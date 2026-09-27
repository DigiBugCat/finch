package core

// The agent-facing CLI contract: exit codes, the --json error envelope, and the
// dispatcher every setup/control subcommand runs through. An AI agent drives
// finch by reading exit codes and JSON, so these are a stable interface — keep
// the codes and field names backward-compatible (add fields; never repurpose).
//
//	0  ok                       1  error
//	2  usage                   10  waiting for approval
//	11 expired                 12  not logged in
//
// With --json every success payload carries "schema_version":1 on stdout, and
// every error goes to stderr as
//
//	{"schema_version":1,"error":{"code":"…","message":"…","next":"<command>"}}

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

const (
	exitOK          = 0
	exitError       = 1
	exitUsage       = 2
	exitPending     = 10
	exitExpired     = 11
	exitNotLoggedIn = 12
)

// cliSchemaVersion is stamped on every --json payload (success or error).
const cliSchemaVersion = 1

// Error codes of the --json error envelope.
const (
	codeNotLoggedIn     = "NOT_LOGGED_IN"
	codeApprovalPending = "APPROVAL_PENDING"
	codeExpired         = "EXPIRED"
	codeNotFound        = "NOT_FOUND"
	codeUpstream        = "UPSTREAM"
	codeUsage           = "USAGE"
	codeInternal        = "INTERNAL"
)

// cliError is a failure with a machine-readable code and, when there is one,
// the command the caller should run next.
type cliError struct {
	Code    string
	Message string
	Next    string
}

func (e *cliError) Error() string { return e.Message }

func (e *cliError) exitCode() int {
	switch e.Code {
	case codeUsage:
		return exitUsage
	case codeApprovalPending:
		return exitPending
	case codeExpired:
		return exitExpired
	case codeNotLoggedIn:
		return exitNotLoggedIn
	default:
		return exitError
	}
}

func newCLIError(code, next, format string, a ...any) *cliError {
	return &cliError{Code: code, Message: fmt.Sprintf(format, a...), Next: next}
}

func usageError(format string, a ...any) *cliError {
	return newCLIError(codeUsage, "finch help", format, a...)
}

// exitStatus ends a command with a non-zero exit code whose outcome was already
// reported on stdout (e.g. `finch login --poll` printing {"status":"pending"}
// and exiting 10). It is not an error, so nothing more is printed.
type exitStatus int

func (e exitStatus) Error() string { return fmt.Sprintf("exit status %d", int(e)) }

// errHelpShown ends a command whose -h/--help text was printed (exit 0).
var errHelpShown = errors.New("help shown")

// cli is one CLI invocation: its streams plus whether --json was requested.
// Commands write through it (never os.Stdout directly) so tests can drive the
// real dispatcher and assert the exact bytes and exit code.
type cli struct {
	stdout io.Writer
	stderr io.Writer
	stdin  io.Reader
	json   bool
}

// printf writes human output. With --json the stdout stream is reserved for the
// payload, so human progress text goes to stderr instead.
func (c *cli) printf(format string, a ...any) {
	w := c.stdout
	if c.json {
		w = c.stderr
	}
	fmt.Fprintf(w, format, a...)
}

// emit writes a --json success payload with schema_version stamped on it (as
// the first field, so a human skimming the output sees it first).
func (c *cli) emit(payload map[string]any) error {
	rest := make(map[string]any, len(payload))
	for k, v := range payload {
		if k != "schema_version" {
			rest[k] = v
		}
	}
	b, err := json.Marshal(rest)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(c.stdout, withSchemaVersion(b))
	return err
}

// withSchemaVersion prefixes a marshaled JSON object with "schema_version":1.
func withSchemaVersion(obj []byte) string {
	head := fmt.Sprintf(`{"schema_version":%d`, cliSchemaVersion)
	if string(obj) == "{}" {
		return head + "}"
	}
	return head + "," + string(obj[1:])
}

// finish maps a command's result to its exit code, printing the error in the
// requested format.
func (c *cli) finish(err error) int {
	if err == nil || errors.Is(err, errHelpShown) {
		return exitOK
	}
	var st exitStatus
	if errors.As(err, &st) {
		return int(st)
	}
	var ce *cliError
	if !errors.As(err, &ce) {
		ce = &cliError{Code: codeInternal, Message: err.Error()}
	}
	if c.json {
		body := map[string]any{"code": ce.Code, "message": ce.Message}
		if ce.Next != "" {
			body["next"] = ce.Next
		}
		b, _ := json.Marshal(map[string]any{"error": body})
		fmt.Fprintln(c.stderr, withSchemaVersion(b))
	} else {
		fmt.Fprintf(c.stderr, "finch: %s\n", ce.Message)
		if ce.Next != "" {
			fmt.Fprintf(c.stderr, "  next: %s\n", ce.Next)
		}
	}
	return ce.exitCode()
}

// wantsJSON reports whether --json appears among a command's arguments. It is
// checked before flag parsing so even a usage error is reported as JSON.
func wantsJSON(args []string) bool {
	for _, a := range args {
		if a == "--" {
			return false
		}
		switch a {
		case "--json", "-json", "--json=true", "-json=true", "--json=1", "-json=1":
			return true
		}
	}
	return false
}

// newFlagSet returns a flag set that reports parse errors to the caller instead
// of printing and exiting.
func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

// parseArgs parses flags that may be interleaved with positionals
// (`finch add notes --service …` and `finch add --service … notes` both work)
// and returns the positionals in order.
func (c *cli) parseArgs(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				fmt.Fprintf(c.stdout, "Usage of finch %s:\n", fs.Name())
				fs.SetOutput(c.stdout)
				fs.PrintDefaults()
				return nil, errHelpShown
			}
			return nil, usageError("%s: %v", fs.Name(), err)
		}
		rest := fs.Args()
		if len(rest) == 0 {
			return pos, nil
		}
		pos = append(pos, rest[0])
		args = rest[1:]
	}
}

// runCLI runs a setup/control subcommand. handled=false means args belong to the
// relay agent (`finch run`, `finch join`, or bare flags), which Main serves.
func runCLI(args []string, stdin io.Reader, stdout, stderr io.Writer) (code int, handled bool) {
	if len(args) == 0 {
		return 0, false
	}
	name, rest := args[0], args[1:]
	c := &cli{stdout: stdout, stderr: stderr, stdin: stdin, json: wantsJSON(rest)}
	h := lookupCommand(name)
	if h == nil {
		if validateRelayCommandArg(name) == nil {
			return 0, false
		}
		return c.finish(usageError("unknown command %q", name)), true
	}
	return c.finish(h(c, rest)), true
}

type commandFunc func(c *cli, args []string) error

func lookupCommand(name string) commandFunc {
	switch name {
	case "login":
		return runLogin
	case "add":
		return runAdd
	case "service":
		return runService
	case "connect":
		return runConnect
	case "enroll":
		return runEnroll
	case "approve":
		return runApprove
	case "auth":
		return runAuth
	case "token":
		return runToken
	case "status":
		return runStatus
	case "keys":
		return runKeys
	case "domain":
		return runDomain
	case "fleet", "ls":
		return runFleet
	case "rm":
		return runRm
	case "revoke-tokens":
		return runRevokeTokens
	case "test":
		return runTest
	case "call":
		return runCall
	case "update":
		return runUpdate
	case "version", "--version", "-v":
		return func(c *cli, args []string) error {
			if err := writeCLIVersion(c.stdout, args, currentCLIVersionInfo()); err != nil {
				return usageError("version: %v", err)
			}
			return nil
		}
	case "guide":
		return func(c *cli, args []string) error { _, err := io.WriteString(c.stdout, guideText); return err }
	case "help", "-h", "--help":
		return func(c *cli, args []string) error { _, err := io.WriteString(c.stdout, usageText); return err }
	}
	return nil
}

// hubError is a non-200 answer (or a transport failure, Status 0) from the hub.
type hubError struct {
	Status int
	Msg    string
}

func (e *hubError) Error() string {
	if e.Status == 0 {
		return "could not reach the finch hub: " + e.Msg
	}
	return fmt.Sprintf("hub %d: %s", e.Status, e.Msg)
}

// hubFailure classifies an error from cliRequest into the contract: a 401 means
// the saved login is expired or revoked, a 404 that the thing does not exist,
// anything else (5xx, 429, network) an upstream failure. what prefixes the
// message ("enroll notes"); notFoundNext is the next step for a 404.
func hubFailure(err error, what, notFoundNext string) error {
	var he *hubError
	if !errors.As(err, &he) {
		var ce *cliError
		if errors.As(err, &ce) {
			return ce
		}
		return newCLIError(codeUpstream, "", "%s: %v", what, err)
	}
	switch {
	case he.Status == 401:
		return newCLIError(codeNotLoggedIn, "finch login --start", "%s: the saved finch login is expired or revoked (%s)", what, he.Msg)
	case he.Status == 404:
		return newCLIError(codeNotFound, notFoundNext, "%s: %s", what, he.Msg)
	default:
		return newCLIError(codeUpstream, "", "%s: %v", what, he)
	}
}

// requireCred loads the saved CLI login or explains how to get one. A login
// started with `finch login --start` but not yet approved reports
// APPROVAL_PENDING so an agent keeps polling instead of starting over.
func requireCred() (*cliCred, error) {
	cred, err := readCliCred()
	if err != nil {
		return nil, newCLIError(codeInternal, "", "reading %s: %v", cliCredPath(), err)
	}
	if cred != nil && cred.Token != "" {
		return cred, nil
	}
	if p, _ := readPendingLogin(); p != nil && !p.expired() {
		return nil, newCLIError(codeApprovalPending, "finch login --poll",
			"login is waiting for approval — open %s and confirm code %s", p.VerificationURIComplete, p.UserCode)
	}
	return nil, newCLIError(codeNotLoggedIn, "finch login --start", "not logged in")
}

func asHubError(err error, target **hubError) bool { return errors.As(err, target) }

func asCLIError(err error, target **cliError) bool { return errors.As(err, target) }

// cliMain runs a subcommand for Main against the real process streams and
// exits with its code. It returns only when args belong to the relay agent.
func cliMain(args []string) {
	if code, handled := runCLI(args, os.Stdin, os.Stdout, os.Stderr); handled {
		os.Exit(code)
	}
}
