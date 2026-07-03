package core

import "testing"

// resolveTicket gives the enrollment ticket the same argv-free intake as the CLI
// token: a literal value passes through, FINCH_TICKET is the env fallback, and an
// explicit argv value wins over the env. (The "-" stdin path exits on empty
// stdin, so it is exercised via the CLI, not unit-tested here.)
func TestResolveTicket(t *testing.T) {
	if got := resolveTicket("tkt_abc"); got != "tkt_abc" {
		t.Fatalf("literal ticket = %q, want tkt_abc", got)
	}
	t.Setenv("FINCH_TICKET", "tkt_env")
	if got := resolveTicket(""); got != "tkt_env" {
		t.Fatalf("env-fallback ticket = %q, want tkt_env", got)
	}
	if got := resolveTicket("tkt_argv"); got != "tkt_argv" {
		t.Fatalf("argv-over-env ticket = %q, want tkt_argv", got)
	}
}
