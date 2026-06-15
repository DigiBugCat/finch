package main

import (
	"encoding/base64"
	"net/url"
	"path/filepath"
	"testing"
	"time"
)

func mustParse(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return u
}

// resolveUpstream is the SSRF guard: the hub-supplied path must never escape the
// --upstream base or climb out of the gated /mcp route. This is the highest-risk
// code in the binary, so we pin the full attack matrix.
func TestResolveUpstream(t *testing.T) {
	base := mustParse(t, "http://127.0.0.1:8000")
	cases := []struct {
		path    string
		want    string // "" means: expect an error (rejected)
		comment string
	}{
		{"/mcp", "http://127.0.0.1:8000/mcp", "canonical route"},
		{"/mcp/tools", "http://127.0.0.1:8000/mcp/tools", "child of the route"},
		{"/mcp?x=1", "http://127.0.0.1:8000/mcp?x=1", "query preserved"},
		{"/mcp/../admin", "", "traversal out of /mcp -> reject"},
		{"/admin", "", "sibling route -> reject"},
		{"//evil.com/x", "", "protocol-relative host injection -> reject"},
		{"http://evil.com/x", "", "absolute-URL injection -> reject"},
		{"/mcp/../mcp/ok", "http://127.0.0.1:8000/mcp/ok", "traversal that stays under /mcp is fine"},
		{"", "", "empty path -> reject (not the /mcp route)"},
	}
	for _, c := range cases {
		got, err := resolveUpstream(base, c.path)
		if c.want == "" {
			if err == nil {
				t.Errorf("%s: resolveUpstream(%q) = %q, want REJECT", c.comment, c.path, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: resolveUpstream(%q) errored: %v", c.comment, c.path, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: resolveUpstream(%q) = %q, want %q", c.comment, c.path, got, c.want)
		}
	}
}

// A configured base path widens the confinement prefix to that base path.
func TestResolveUpstream_BasePath(t *testing.T) {
	base := mustParse(t, "http://127.0.0.1:8000/api")
	if _, err := resolveUpstream(base, "/api/mcp"); err != nil {
		t.Errorf("/api/mcp under base /api should pass: %v", err)
	}
	if _, err := resolveUpstream(base, "/mcp"); err == nil {
		t.Errorf("/mcp should be rejected when base path is /api")
	}
}

func TestTokenExp(t *testing.T) {
	enc := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	valid := enc(`{"exp":1700000000}`) + ".sig"
	if got := tokenExp(valid); !got.Equal(time.Unix(1700000000, 0)) {
		t.Errorf("tokenExp(valid) = %v, want %v", got, time.Unix(1700000000, 0))
	}
	// Fail-safe: anything malformed -> zero time (treated as already expired).
	for _, bad := range []string{
		"no-dot",
		enc(`{"exp":0}`) + ".sig", // exp:0 -> zero
		"!!!." + "sig",            // bad base64 payload
		"",
	} {
		if got := tokenExp(bad); !got.IsZero() {
			t.Errorf("tokenExp(%q) = %v, want zero time", bad, got)
		}
	}
}

func TestRelayURL(t *testing.T) {
	cases := []struct{ hub, want string }{
		{"http://localhost:8787", "ws://localhost:8787/app/box/_connect"},
		{"https://finchmcp.com", "wss://finchmcp.com/app/box/_connect"},
		{"http://localhost:8787/", "ws://localhost:8787/app/box/_connect"},
	}
	for _, c := range cases {
		if got := relayURL(c.hub, "app", "box"); got != c.want {
			t.Errorf("relayURL(%q) = %q, want %q", c.hub, got, c.want)
		}
	}
}

func TestState_RoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "agent.json")

	// Missing file -> (nil, nil), not an error.
	if st, err := loadState(path); st != nil || err != nil {
		t.Fatalf("loadState(missing) = (%v,%v), want (nil,nil)", st, err)
	}

	want := &agentState{
		Hub: "https://finchmcp.com", Tenant: "org_1",
		Appliance: "scraper", Machine: "box-1", RefreshToken: "finch_refresh_abc",
	}
	if err := saveState(path, want); err != nil {
		t.Fatalf("saveState: %v", err)
	}
	got, err := loadState(path)
	if err != nil {
		t.Fatalf("loadState: %v", err)
	}
	if got == nil || *got != *want {
		t.Errorf("round-trip = %+v, want %+v", got, want)
	}
}
