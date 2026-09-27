// Package fakefinch puts a fake `finch` on PATH for tests: the test binary
// itself, symlinked as finch, answering from recorded fixtures in
// testdata/finch/<version>/.
//
// The fake is strict. It accepts only the command lines finch-bar is allowed
// to run (always with --json, except a legacy `finch update`), exits 2 with
// finch's own USAGE envelope for anything else, and refuses to answer with a
// fixture that was recorded for different arguments — so a test cannot pass
// by running the wrong command.
//
// A test package opts in with:
//
//	func TestMain(m *testing.M) { fakefinch.MaybeRun(); os.Exit(m.Run()) }
package fakefinch

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
)

const (
	envActive   = "FAKE_FINCH"
	envScenario = "FAKE_FINCH_SCENARIO"
)

// Scenario says how the fake answers.
type Scenario struct {
	// Grammar is the finch release whose command line the fake accepts:
	// "1.7" (1.7.x and 1.8.0 share every command finch-bar runs) or "1.6"
	// (no login --start/--poll/--cancel).
	Grammar string `json:"grammar"`
	// Responses maps a command key ("status", "service install", "test notes",
	// "login --poll"; see Key) to fixture files, relative to testdata/finch.
	// Each call takes the next file; the last one repeats.
	Responses map[string][]string `json:"responses"`
	// Dir is testdata/finch (set by Install).
	Dir string `json:"dir"`
	// Log is where each invocation's argv is appended as a JSON line.
	Log string `json:"log"`
	// State holds the per-key call counters.
	State string `json:"state"`
}

// Fixture is one recorded finch invocation.
type Fixture struct {
	Args   []string `json:"args"`
	Exit   int      `json:"exit"`
	Stdout string   `json:"stdout"`
	Stderr string   `json:"stderr"`
}

// Fake is an installed fake finch.
type Fake struct {
	Dir      string // the directory holding the finch symlink (put it on PATH)
	Path     string // the finch symlink
	scenario Scenario
	t        testing.TB
}

// Install creates the fake finch for a test and returns it. It does not touch
// PATH; tests pass Fake.Path to the client or prepend Fake.Dir to PATH.
func Install(t testing.TB, grammar string, responses map[string][]string) *Fake {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "finch")
	if err := os.Symlink(exe, bin); err != nil {
		t.Fatal(err)
	}
	_, file, _, _ := runtime.Caller(0)
	testdata := filepath.Join(filepath.Dir(file), "..", "..", "testdata", "finch")
	for key, files := range responses {
		for _, f := range files {
			if _, err := os.Stat(filepath.Join(testdata, f)); err != nil {
				t.Fatalf("fakefinch: response for %q: %v", key, err)
			}
		}
	}
	sc := Scenario{
		Grammar:   grammar,
		Responses: responses,
		Dir:       testdata,
		Log:       filepath.Join(dir, "calls.jsonl"),
		State:     filepath.Join(dir, "state"),
	}
	if err := os.MkdirAll(sc.State, 0o700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(sc)
	scPath := filepath.Join(dir, "scenario.json")
	if err := os.WriteFile(scPath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envActive, "1")
	t.Setenv(envScenario, scPath)
	// Under -race the fake (a race-enabled test binary) would otherwise
	// sleep a second at every exit.
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	return &Fake{Dir: dir, Path: bin, scenario: sc, t: t}
}

// Calls returns the argv of every invocation so far, in order.
func (f *Fake) Calls() [][]string {
	f.t.Helper()
	b, err := os.ReadFile(f.scenario.Log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		f.t.Fatal(err)
	}
	var calls [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if line == "" {
			continue
		}
		var args []string
		if err := json.Unmarshal([]byte(line), &args); err != nil {
			f.t.Fatal(err)
		}
		calls = append(calls, args)
	}
	return calls
}

// MaybeRun acts as finch and exits when this process was started as the
// fake; otherwise it returns and the tests run.
func MaybeRun() {
	if os.Getenv(envActive) != "1" || filepath.Base(os.Args[0]) != "finch" {
		return
	}
	os.Exit(run(os.Args[1:]))
}

func usage(msg string) int {
	b, _ := json.Marshal(map[string]any{"schema_version": 1, "error": map[string]string{"code": "USAGE", "message": msg, "next": "finch help"}})
	fmt.Fprintln(os.Stderr, string(b))
	return 2
}

var serviceName = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$`)

// Key is the command key for argv: the words without --json.
func Key(args []string) string {
	var words []string
	for _, a := range args {
		if a != "--json" {
			words = append(words, a)
		}
	}
	return strings.Join(words, " ")
}

// allowed reports whether argv is a command line finch-bar may run.
func allowed(grammar string, args []string) (bool, string) {
	jsonCount := 0
	for _, a := range args {
		if a == "--json" {
			jsonCount++
		}
	}
	words := strings.Fields(Key(args))
	if len(words) == 0 {
		return false, "no command"
	}
	if slices.Equal(words, []string{"update"}) && jsonCount == 0 {
		return true, "" // the legacy update for a finch older than 1.7
	}
	if jsonCount != 1 || args[len(args)-1] != "--json" {
		return false, fmt.Sprintf("finch-bar must pass --json exactly once, last: %q", args)
	}
	switch {
	case slices.Equal(words, []string{"version"}),
		slices.Equal(words, []string{"status"}),
		slices.Equal(words, []string{"fleet"}),
		slices.Equal(words, []string{"update"}):
		return true, ""
	case len(words) == 2 && words[0] == "service":
		return slices.Contains([]string{"status", "install", "uninstall"}, words[1]), "usage: finch service install|uninstall|status"
	case len(words) == 2 && words[0] == "test":
		return serviceName.MatchString(words[1]), fmt.Sprintf("invalid service name %q", words[1])
	case len(words) == 2 && words[0] == "login":
		if grammar == "1.6" {
			return false, "flag provided but not defined: " + strings.TrimPrefix(words[1], "-")
		}
		return slices.Contains([]string{"--start", "--poll", "--cancel"}, words[1]), "usage: finch login [--start | --poll | --cancel]"
	}
	return false, fmt.Sprintf("unknown command %q", strings.Join(words, " "))
}

func run(args []string) int {
	b, err := os.ReadFile(os.Getenv(envScenario))
	if err != nil {
		fmt.Fprintln(os.Stderr, "fakefinch:", err)
		return 99
	}
	var sc Scenario
	if err := json.Unmarshal(b, &sc); err != nil {
		fmt.Fprintln(os.Stderr, "fakefinch:", err)
		return 99
	}
	if line, err := json.Marshal(args); err == nil {
		if f, err := os.OpenFile(sc.Log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			fmt.Fprintln(f, string(line))
			f.Close()
		}
	}
	if ok, why := allowed(sc.Grammar, args); !ok {
		return usage(why)
	}
	key := Key(args)
	files := sc.Responses[key]
	if len(files) == 0 {
		fmt.Fprintf(os.Stderr, "fakefinch: no response recorded for %q\n", key)
		return 98
	}
	counter := filepath.Join(sc.State, strings.NewReplacer(" ", "_", "/", "_").Replace(key))
	n := 0
	if c, err := os.ReadFile(counter); err == nil {
		n, _ = strconv.Atoi(strings.TrimSpace(string(c)))
	}
	_ = os.WriteFile(counter, []byte(strconv.Itoa(n+1)), 0o600)
	if n >= len(files) {
		n = len(files) - 1
	}
	fb, err := os.ReadFile(filepath.Join(sc.Dir, files[n]))
	if err != nil {
		fmt.Fprintln(os.Stderr, "fakefinch:", err)
		return 99
	}
	var fx Fixture
	if err := json.Unmarshal(fb, &fx); err != nil {
		fmt.Fprintln(os.Stderr, "fakefinch:", files[n], err)
		return 99
	}
	if Key(fx.Args) != key {
		fmt.Fprintf(os.Stderr, "fakefinch: fixture %s was recorded for %q, not %q\n", files[n], Key(fx.Args), key)
		return 97
	}
	os.Stdout.WriteString(fx.Stdout)
	os.Stderr.WriteString(fx.Stderr)
	return fx.Exit
}
