// Package finch runs the finch CLI and decodes its --json contract.
//
// finch-bar has no finch logic of its own: everything it knows comes from
// running the finch binary with --json and reading the documented payloads
// (web/public/agents.md). The types here mirror that contract as of finch
// 1.7.x and 1.8.0; unknown fields are ignored and fields added in 1.8.0 are
// optional, so one finch-bar works with both.
package finch

import (
	"fmt"
	"strconv"
	"strings"
)

// MinVersion is the oldest finch whose --json contract finch-bar understands
// (1.7.0 added login --start/--poll, service install and schema_version).
const MinVersion = "1.7.0"

// InstallCommand is the one-liner that installs finch.
const InstallCommand = "curl -fsSL https://finchmcp.com/install | sh"

// Exit codes of the CLI contract.
const (
	ExitOK          = 0
	ExitError       = 1
	ExitUsage       = 2
	ExitPending     = 10
	ExitExpired     = 11
	ExitNotLoggedIn = 12
)

// Error codes of the --json error envelope.
const (
	CodeNotLoggedIn     = "NOT_LOGGED_IN"
	CodeApprovalPending = "APPROVAL_PENDING"
	CodeExpired         = "EXPIRED"
	CodeNotFound        = "NOT_FOUND"
	CodeUpstream        = "UPSTREAM"
	CodeUsage           = "USAGE"
	CodeInternal        = "INTERNAL"
)

// Error is a failed finch command: the --json error envelope finch wrote to
// stderr, plus its exit code.
type Error struct {
	Args    []string
	Exit    int
	Code    string
	Message string
	Next    string
}

func (e *Error) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("finch %s exited %d", strings.Join(e.Args, " "), e.Exit)
	}
	return e.Message
}

// VersionInfo is `finch --version --json` (the same as `finch version --json`).
type VersionInfo struct {
	Product string `json:"product"`
	Version string `json:"version"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

// Status is `finch status --json`: this machine's login, finch.yml and
// background service. Not being logged in is a normal answer (exit 0).
type Status struct {
	// LoggedInSnake is "logged_in" (finch 1.8.0+); LoggedInCamel is the older
	// "loggedIn" that 1.8.0 keeps for compatibility. Use LoggedIn().
	LoggedInSnake *bool `json:"logged_in"`
	LoggedInCamel *bool `json:"loggedIn"`
	LoginPending  bool  `json:"login_pending"`
	// HubReachable is present only when there was a saved login to verify.
	HubReachable *bool         `json:"hub_reachable"`
	Hub          string        `json:"hub"`
	Account      string        `json:"account"`
	Config       string        `json:"config"`
	Version      string        `json:"version"`
	Ingress      []Ingress     `json:"ingress"`
	Service      ServiceStatus `json:"service"`
}

// LoggedIn reports the saved login's state, preferring the 1.8.0 field.
func (s *Status) LoggedIn() bool {
	if s.LoggedInSnake != nil {
		return *s.LoggedInSnake
	}
	return s.LoggedInCamel != nil && *s.LoggedInCamel
}

// Unverified reports a saved login the hub could not be reached to check.
func (s *Status) Unverified() bool {
	return s.HubReachable != nil && !*s.HubReachable
}

// Ingress is one service this machine's finch.yml serves.
type Ingress struct {
	Name   string `json:"app_path"`
	Target string `json:"service"` // the local URL finch forwards to
	URL    string `json:"url"`     // the public URL (finch 1.8.0+)
}

// ServiceStatus is the background service (`finch service status --json`,
// and the "service" object inside `finch status --json`).
type ServiceStatus struct {
	Manager   string `json:"manager"` // "launchd" | "systemd" | ""
	Unit      string `json:"unit"`
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
	Log       string `json:"log"` // set by service install; optional elsewhere
}

// FleetService is one service in `finch fleet --json`, across every machine
// on the account.
type FleetService struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	State    string `json:"state"` // online | in_use | offline | pending | invited
	Auth     string `json:"auth"`  // key | public
	URL      string `json:"url"`   // finch 1.8.0+
	Version  string `json:"version"`
	Outdated bool   `json:"outdated"`
	LastSeen string `json:"lastSeen"`
}

// Online reports a service a caller can reach right now.
func (f FleetService) Online() bool { return f.State == "online" || f.State == "in_use" }

// Waiting reports a service whose machine joined but waits for
// `finch approve <name>` (the hub's "pending").
func (f FleetService) Waiting() bool { return f.State == "pending" }

// Offline reports a service no machine is serving: "offline" (its machines
// disconnected), "invited" (added, but no machine has joined yet) or a state
// this finch-bar does not know. Like the fleet page, anything that is neither
// online nor waiting for approval reads as offline.
func (f FleetService) Offline() bool { return !f.Online() && !f.Waiting() }

// Fleet is `finch fleet --json`.
type Fleet struct {
	Services []FleetService `json:"services"`
}

// Tool is one MCP tool `finch test` listed.
type Tool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// TestResult is a successful `finch test <name> --json`.
type TestResult struct {
	Service string `json:"service"`
	OK      bool   `json:"ok"`
	Tools   []Tool `json:"tools"`
}

// LoginStart is `finch login --start --json`.
type LoginStart struct {
	UserCode                string `json:"user_code"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// LoginPoll is `finch login --poll --json`: Status is approved (exit 0),
// pending (exit 10) or expired (exit 11).
type LoginPoll struct {
	Status  string `json:"status"`
	Account string `json:"account"`
}

// LoginCancel is `finch login --cancel --json`.
type LoginCancel struct {
	Cancelled bool `json:"cancelled"`
}

// UpdateResult is `finch update --json`.
type UpdateResult struct {
	Updated bool   `json:"updated"`
	Version string `json:"version"` // when already current
	Binary  string `json:"binary"`  // when updated
	Restart string `json:"restart"` // when updated: auto | service | self | none
}

// ServiceChange is `finch service install --json` / `uninstall --json`.
type ServiceChange struct {
	ServiceStatus
	Removed bool     `json:"removed"`
	Notes   []string `json:"notes"`
}

// ParseVersion reads "1.8.0", "v1.8.0" or "1.8.0-rc.1" into comparable parts.
// ok is false for anything else (a "dev" build, say).
func ParseVersion(v string) (parts [3]int, ok bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	fields := strings.Split(v, ".")
	if len(fields) != 3 {
		return parts, false
	}
	for i, f := range fields {
		n, err := strconv.Atoi(f)
		if err != nil || n < 0 {
			return parts, false
		}
		parts[i] = n
	}
	return parts, true
}

// OlderThan reports whether version v is a release older than min. A version
// that does not parse (a local dev build) is assumed to be new enough.
func OlderThan(v, min string) bool {
	a, ok := ParseVersion(v)
	if !ok {
		return false
	}
	b, ok := ParseVersion(min)
	if !ok {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}
