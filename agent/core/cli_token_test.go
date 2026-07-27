package core

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// resolveCliToken must give the ~30-day TENANT-ADMIN CLI token the same argv-free
// intake the strictly less privileged enrollment ticket already has (resolveTicket,
// cli.go:1131): "-" reads stdin, FINCH_CLI_TOKEN is the env fallback. The argv form
// still works — it only reports fromArgv=true so cmdLogin can warn that the token
// landed in /proc/<pid>/cmdline and shell history.
func TestResolveCliToken(t *testing.T) {
	for _, tc := range []struct {
		name         string
		arg          string
		stdin        string
		env          string
		want         string
		wantFromArgv bool
	}{
		{name: "stdin", arg: "-", stdin: "cli_stdin\n", want: "cli_stdin"},
		{name: "stdin wins over env", arg: "-", stdin: "  cli_stdin  ", env: "cli_env", want: "cli_stdin"},
		{name: "env fallback", arg: "", env: " cli_env\n", want: "cli_env"},
		{name: "argv still works", arg: "cli_argv", want: "cli_argv", wantFromArgv: true},
		{name: "argv wins over env", arg: "cli_argv", env: "cli_env", want: "cli_argv", wantFromArgv: true},
		// Nothing anywhere → "" so cmdLogin falls through to the device flow.
		{name: "no token at all", arg: "", want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("FINCH_CLI_TOKEN", tc.env)
			got, fromArgv := resolveCliToken(tc.arg, strings.NewReader(tc.stdin))
			if got != tc.want || fromArgv != tc.wantFromArgv {
				t.Fatalf("resolveCliToken(%q) = (%q, %v), want (%q, %v)", tc.arg, got, fromArgv, tc.want, tc.wantFromArgv)
			}
		})
	}
}

// loginCommand (cli.go:994) is what BOTH copy-a-whole-command surfaces emit:
// `finch token --login` and the dashboard's Settings → CLI access button. The
// old form embedded the tenant-admin token as an argv word, and callers paste
// these straight into a shell — so the token landed in /proc/<pid>/cmdline and
// in shell history. Assert the token is nowhere on the command line, and that
// the heredoc body still round-trips through the intake resolveCliToken uses.
func TestLoginCommandKeepsTokenOffArgv(t *testing.T) {
	// Shell metacharacters a naive quoting scheme would mangle or expand. A
	// quoted heredoc delimiter (<<'...') suppresses all of it.
	const token = "cli_$HOME`id`\\n\"'; rm -rf /"
	const hub = "https://finchmcp.com"

	cmd := loginCommand(hub, token)
	lines := strings.Split(cmd, "\n")
	if len(lines) != 3 {
		t.Fatalf("loginCommand: want 3 lines (argv, token, delimiter), got %d: %q", len(lines), cmd)
	}
	if strings.Contains(lines[0], token) {
		t.Fatalf("loginCommand put the token on the shell command line: %q", lines[0])
	}
	if want := "finch login --hub " + hub + " --token - <<'" + loginHeredocDelimiter + "'"; lines[0] != want {
		t.Fatalf("loginCommand argv line = %q, want %q", lines[0], want)
	}
	if lines[2] != loginHeredocDelimiter {
		t.Fatalf("loginCommand does not terminate the heredoc: %q", cmd)
	}
	// What the shell hands the login process on stdin is exactly the body line;
	// resolveCliToken must recover the token verbatim, metacharacters intact.
	got, fromArgv := resolveCliToken("-", strings.NewReader(lines[1]+"\n"))
	if got != token || fromArgv {
		t.Fatalf("round-trip = (%q, %v), want (%q, false)", got, fromArgv, token)
	}
}

// The package header (cli.go:1) is the recipe a reader/agent follows on a FRESH
// box. It must not be circular: `finch token` calls loadCliCred first (cli.go:1009
// → cli.go:278), which exits "not logged in" when no credential exists yet, so
// `finch token | finch login --token -` cannot bootstrap box #1. The pipe is
// correct only where the text says the source box is already logged in.
func TestPackageHeaderBootstrapsAFreshBox(t *testing.T) {
	src, err := os.ReadFile(filepath.Join(".", "cli.go"))
	if err != nil {
		t.Fatal(err)
	}
	header, _, ok := strings.Cut(string(src), "\nimport (")
	if !ok {
		t.Fatal("could not isolate the cli.go package header")
	}
	// The indented recipe block: a tab-indented comment line is a command.
	recipe := regexp.MustCompile(`(?m)^//\t(\S.*)$`).FindAllStringSubmatch(header, -1)
	if len(recipe) == 0 {
		t.Fatal("cli.go header has no command recipe at all")
	}
	var bootstrap string
	for _, m := range recipe {
		if strings.HasPrefix(m[1], "finch login") || strings.HasPrefix(m[1], "finch token") {
			bootstrap = m[1]
			break
		}
	}
	if !strings.HasPrefix(bootstrap, "finch login") {
		t.Fatalf("first auth step in the cli.go header recipe is %q; a fresh box can only start with `finch login`", bootstrap)
	}
	if strings.Contains(bootstrap, "finch token") {
		t.Fatalf("cli.go header bootstraps with a circular `finch token` pipe: %q", bootstrap)
	}
}
