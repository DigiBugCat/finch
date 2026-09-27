package finch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ErrNotInstalled means no finch binary was found.
var ErrNotInstalled = errors.New("finch is not installed")

// ErrNoContract means finch answered (exit 0) without a --json payload: a
// finch older than MinVersion, or not the finch CLI at all.
var ErrNoContract = errors.New("finch did not answer with the --json contract")

// TooOld reports whether err, from Version, means this finch answered but is
// too old for finch-bar: it rejected `--version --json` (a finch before 1.6
// fails that flag with a usage error) or answered without the --json
// contract. A finch that could not be run, or timed out, is not "too old".
func TooOld(err error) bool {
	var fe *Error
	return errors.As(err, &fe) || errors.Is(err, ErrNoContract)
}

// Locate finds the finch binary: override (a --finch flag or FINCH_BAR_FINCH)
// when set, else finch on PATH, else the places the installer puts it. The
// fallback matters on macOS, where an app started from Finder or at login gets
// a PATH without ~/.local/bin or /opt/homebrew/bin.
func Locate(override, pathEnv, home string) (string, error) {
	if override != "" {
		if isExecutable(override) {
			return override, nil
		}
		return "", fmt.Errorf("%w: %s is not an executable file", ErrNotInstalled, override)
	}
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" || !filepath.IsAbs(dir) {
			continue // never resolve finch relative to the working directory
		}
		if p := filepath.Join(dir, "finch"); isExecutable(p) {
			return p, nil
		}
	}
	candidates := []string{"/usr/local/bin/finch", "/opt/homebrew/bin/finch"}
	if home != "" {
		candidates = append([]string{filepath.Join(home, ".local", "bin", "finch")}, candidates...)
	}
	for _, p := range candidates {
		if isExecutable(p) {
			return p, nil
		}
	}
	return "", ErrNotInstalled
}

func isExecutable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0o111 != 0
}

// Output is what one finch invocation produced.
type Output struct {
	Stdout []byte
	Stderr []byte
	Exit   int
}

// Runner runs the finch binary.
type Runner interface {
	Run(ctx context.Context, args ...string) (Output, error)
}

// ExecRunner runs finch as a child process.
type ExecRunner struct {
	Path string
	// Env, when set, replaces the child's environment.
	Env []string
}

// Run runs finch with args. err is non-nil only when finch could not be run
// at all (or was killed by ctx); a non-zero exit is reported in Output.Exit.
func (r ExecRunner) Run(ctx context.Context, args ...string) (Output, error) {
	cmd := exec.CommandContext(ctx, r.Path, args...)
	if r.Env != nil {
		cmd.Env = r.Env
	}
	cmd.Stdin = nil
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	out := Output{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}
	if err == nil {
		return out, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) && ctx.Err() == nil {
		out.Exit = ee.ExitCode()
		return out, nil
	}
	if ctx.Err() != nil {
		return out, fmt.Errorf("finch %s did not finish: %w", strings.Join(args, " "), ctx.Err())
	}
	return out, fmt.Errorf("could not run finch: %w", err)
}

// Timeouts per command. service install waits for the relays to connect
// (about 20s) and update downloads a binary.
const (
	quickTimeout   = 30 * time.Second
	testTimeout    = 60 * time.Second
	installTimeout = 90 * time.Second
	updateTimeout  = 5 * time.Minute
)

// Client runs finch commands and decodes their --json payloads.
type Client struct {
	Runner Runner
}

// New returns a Client for the finch binary at path.
func New(path string) *Client { return &Client{Runner: ExecRunner{Path: path}} }

// run runs finch with args (which must include --json) and decodes a
// successful payload into v. okExits lists extra exit codes whose stdout is a
// payload rather than a failure (login --poll's 10 and 11).
func (c *Client) run(ctx context.Context, timeout time.Duration, v any, okExits []int, args ...string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := c.Runner.Run(ctx, args...)
	if err != nil {
		return 0, err
	}
	return out.Exit, Decode(args, out, v, okExits...)
}

// Decode reads one finch invocation's result: a success payload into v, or
// the failure as an *Error. okExits lists extra exit codes whose stdout is a
// payload rather than a failure (login --poll's 10 and 11).
func Decode(args []string, out Output, v any, okExits ...int) error {
	payloadExit := out.Exit == ExitOK
	for _, e := range okExits {
		if out.Exit == e {
			payloadExit = true
		}
	}
	if !payloadExit {
		return decodeError(args, out)
	}
	if err := decodePayload(out.Stdout, v); err != nil {
		return fmt.Errorf("finch %s: %w", strings.Join(args, " "), err)
	}
	return nil
}

// decodePayload reads a --json success payload, which must carry
// schema_version 1.
func decodePayload(stdout []byte, v any) error {
	line := lastJSONLine(stdout)
	if line == nil {
		return fmt.Errorf("%w: unexpected output %q (is this finch older than %s?)", ErrNoContract, snippet(stdout), MinVersion)
	}
	var head struct {
		SchemaVersion int `json:"schema_version"`
	}
	if err := json.Unmarshal(line, &head); err != nil {
		return fmt.Errorf("unreadable JSON %q: %v", snippet(line), err)
	}
	if head.SchemaVersion == 0 {
		return fmt.Errorf("%w: no schema_version in %q (is this finch older than %s?)", ErrNoContract, snippet(line), MinVersion)
	}
	if head.SchemaVersion != 1 {
		return fmt.Errorf("unsupported schema_version %d (finch-bar reads version 1)", head.SchemaVersion)
	}
	if v == nil {
		return nil
	}
	if err := json.Unmarshal(line, v); err != nil {
		return fmt.Errorf("unreadable JSON %q: %v", snippet(line), err)
	}
	return nil
}

// decodeError turns a failed run into an *Error, using the JSON envelope on
// stderr when finch wrote one.
func decodeError(args []string, out Output) error {
	e := &Error{Args: args, Exit: out.Exit}
	if line := lastJSONLine(out.Stderr); line != nil {
		var env struct {
			Error *struct {
				Code    string `json:"code"`
				Message string `json:"message"`
				Next    string `json:"next"`
			} `json:"error"`
		}
		if json.Unmarshal(line, &env) == nil && env.Error != nil {
			e.Code, e.Message, e.Next = env.Error.Code, env.Error.Message, env.Error.Next
			return e
		}
	}
	// No envelope: an old finch, or a crash. Keep its own words.
	msg := strings.TrimSpace(string(out.Stderr))
	if msg == "" {
		msg = strings.TrimSpace(string(out.Stdout))
	}
	if msg != "" {
		e.Message = firstLine(msg)
	}
	if out.Exit == ExitUsage {
		e.Code = CodeUsage
	}
	return e
}

// lastJSONLine returns the last line of b that looks like a JSON object.
func lastJSONLine(b []byte) []byte {
	lines := bytes.Split(bytes.TrimSpace(b), []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		l := bytes.TrimSpace(lines[i])
		if len(l) > 1 && l[0] == '{' && l[len(l)-1] == '}' {
			return l
		}
	}
	return nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 120 {
		s = s[:120] + "…"
	}
	return s
}

// VersionArgs is how finch-bar asks finch its version. It is the flag form,
// not `finch version`: every finch from 1.6 on answers both the same way, but
// a finch before 1.6 has no version command and treats an unknown first word
// as its relay agent's command line, so `finch version` would start serving
// finch.yml. An unknown flag stops it at flag parsing (exit 2) instead.
var VersionArgs = []string{"--version", "--json"}

// Version runs `finch --version --json`. Use TooOld to tell a finch that is
// too old from one that could not be run.
func (c *Client) Version(ctx context.Context) (VersionInfo, error) {
	var v VersionInfo
	_, err := c.run(ctx, quickTimeout, &v, nil, VersionArgs...)
	if err == nil && v.Version == "" {
		err = fmt.Errorf("%w: finch --version --json did not report a version", ErrNoContract)
	}
	return v, err
}

// Status runs `finch status --json`.
func (c *Client) Status(ctx context.Context) (Status, error) {
	var s Status
	_, err := c.run(ctx, quickTimeout, &s, nil, "status", "--json")
	return s, err
}

// Fleet runs `finch fleet --json`.
func (c *Client) Fleet(ctx context.Context) (Fleet, error) {
	var f Fleet
	_, err := c.run(ctx, quickTimeout, &f, nil, "fleet", "--json")
	return f, err
}

// ServiceStatus runs `finch service status --json`.
func (c *Client) ServiceStatus(ctx context.Context) (ServiceStatus, error) {
	var s ServiceStatus
	_, err := c.run(ctx, quickTimeout, &s, nil, "service", "status", "--json")
	return s, err
}

// ServiceInstall runs `finch service install --json`: it (re)starts finch in
// the background and waits for its services to connect.
func (c *Client) ServiceInstall(ctx context.Context) (ServiceChange, error) {
	var s ServiceChange
	_, err := c.run(ctx, installTimeout, &s, nil, "service", "install", "--json")
	return s, err
}

// ServiceUninstall runs `finch service uninstall --json`: it stops the
// background service and removes it.
func (c *Client) ServiceUninstall(ctx context.Context) (ServiceChange, error) {
	var s ServiceChange
	_, err := c.run(ctx, quickTimeout, &s, nil, "service", "uninstall", "--json")
	return s, err
}

// Test runs `finch test <name> --json`.
func (c *Client) Test(ctx context.Context, name string) (TestResult, error) {
	if !ValidServiceName(name) {
		return TestResult{}, fmt.Errorf("invalid service name %q", name)
	}
	var t TestResult
	_, err := c.run(ctx, testTimeout, &t, nil, "test", name, "--json")
	return t, err
}

// LoginStart runs `finch login --start --json`.
func (c *Client) LoginStart(ctx context.Context) (LoginStart, error) {
	var l LoginStart
	_, err := c.run(ctx, quickTimeout, &l, nil, "login", "--start", "--json")
	if err == nil && (l.VerificationURIComplete == "" || l.UserCode == "") {
		err = errors.New("finch login --start did not return a sign-in link")
	}
	return l, err
}

// LoginPoll runs `finch login --poll --json` once.
func (c *Client) LoginPoll(ctx context.Context) (LoginPoll, error) {
	var l LoginPoll
	_, err := c.run(ctx, quickTimeout, &l, []int{ExitPending, ExitExpired}, "login", "--poll", "--json")
	return l, err
}

// LoginCancel runs `finch login --cancel --json`.
func (c *Client) LoginCancel(ctx context.Context) (LoginCancel, error) {
	var l LoginCancel
	_, err := c.run(ctx, quickTimeout, &l, nil, "login", "--cancel", "--json")
	return l, err
}

// Update runs `finch update --json`.
func (c *Client) Update(ctx context.Context) (UpdateResult, error) {
	var u UpdateResult
	_, err := c.run(ctx, updateTimeout, &u, nil, "update", "--json")
	return u, err
}

// UpdateLegacy runs a plain `finch update`, for a finch too old to speak
// --json; only its exit code and words are used.
func (c *Client) UpdateLegacy(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, updateTimeout)
	defer cancel()
	args := []string{"update"}
	out, err := c.Runner.Run(ctx, args...)
	if err != nil {
		return err
	}
	if out.Exit != ExitOK {
		return decodeError(args, out)
	}
	return nil
}

// ValidServiceName matches the service names finch accepts (ASCII letters and
// digits, with '-', '_' and '.' only between them; at most 63 characters), so
// a name read from the hub is never handed to finch as a flag.
func ValidServiceName(name string) bool {
	if name == "" || len(name) > 63 {
		return false
	}
	for i, r := range name {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			continue
		}
		if i > 0 && i < len(name)-1 && (r == '-' || r == '_' || r == '.') {
			continue
		}
		return false
	}
	return true
}
