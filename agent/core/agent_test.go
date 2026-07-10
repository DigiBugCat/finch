package core

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
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

// resolveUpstream is the SSRF guard: host/scheme must come only from the trusted
// service base, never from the frame. With NO base path and forwardAll=false the
// service is confined to /mcp by DEFAULT (a sibling path is rejected); a service
// base path re-narrows to it (see _BasePath) and forwardAll opts out to expose the
// whole subtree (see _ForwardAll). The host-injection defenses always hold. This
// is the highest-risk code, so we pin the full attack matrix.
func TestResolveUpstream(t *testing.T) {
	base := mustParse(t, "http://127.0.0.1:8000")
	cases := []struct {
		path    string
		want    string // "" means: expect an error (rejected)
		comment string
	}{
		{"/mcp", "http://127.0.0.1:8000/mcp", "the MCP endpoint works (default /mcp confinement)"},
		{"/mcp/tools", "http://127.0.0.1:8000/mcp/tools", "child path"},
		{"/mcp?x=1", "http://127.0.0.1:8000/mcp?x=1", "query preserved"},
		{"/", "", "no base path defaults to /mcp -> site root rejected"},
		{"/index.html", "", "arbitrary asset rejected under default /mcp"},
		{"/mcp/../admin", "", "traversal out of /mcp -> reject"},
		{"/admin", "", "sibling rejected under default /mcp"},
		{"//evil.com/x", "", "protocol-relative host injection -> reject"},
		{"http://evil.com/x", "", "absolute-URL injection -> reject"},
		{"/mcp/../mcp/ok", "http://127.0.0.1:8000/mcp/ok", "traversal collapses, stays under /mcp"},
		{"", "", "empty path -> / -> rejected under default /mcp"},
	}
	for _, c := range cases {
		got, err := resolveUpstream(base, c.path, false)
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

// forwardAll=true opts out of the default /mcp confinement: any rooted path under
// the service host is forwarded (a website / non-MCP HTTP app), while the
// host-injection defenses still hold.
func TestResolveUpstream_ForwardAll(t *testing.T) {
	base := mustParse(t, "http://127.0.0.1:8000")
	ok := []struct{ path, want string }{
		{"/", "http://127.0.0.1:8000/"},
		{"/index.html", "http://127.0.0.1:8000/index.html"},
		{"/admin", "http://127.0.0.1:8000/admin"},
		{"/mcp", "http://127.0.0.1:8000/mcp"},
	}
	for _, c := range ok {
		got, err := resolveUpstream(base, c.path, true)
		if err != nil {
			t.Errorf("forward_all: resolveUpstream(%q) errored: %v", c.path, err)
			continue
		}
		if got != c.want {
			t.Errorf("forward_all: resolveUpstream(%q) = %q, want %q", c.path, got, c.want)
		}
	}
	for _, bad := range []string{"//evil.com/x", "http://evil.com/x"} {
		if _, err := resolveUpstream(base, bad, true); err == nil {
			t.Errorf("forward_all must still reject host injection %q", bad)
		}
	}
}

// A configured base path widens the confinement prefix to that base path (and
// forwardAll is irrelevant once a base path is set).
func TestResolveUpstream_BasePath(t *testing.T) {
	base := mustParse(t, "http://127.0.0.1:8000/api")
	if _, err := resolveUpstream(base, "/api/mcp", false); err != nil {
		t.Errorf("/api/mcp under base /api should pass: %v", err)
	}
	if _, err := resolveUpstream(base, "/mcp", false); err == nil {
		t.Errorf("/mcp should be rejected when base path is /api")
	}
}

func TestResolveUpstream_RouteAllowlistUsesSegmentBoundaries(t *testing.T) {
	base := mustParse(t, "http://127.0.0.1:8000")
	routes := []string{"/mcp", "/api/v1", "/birdz"}
	for _, allowed := range []string{"/mcp", "/mcp/tools", "/api/v1", "/api/v1/tools?x=1", "/birdz"} {
		if _, err := resolveUpstreamWithRoutes(base, allowed, false, routes); err != nil {
			t.Errorf("allowlisted path %q rejected: %v", allowed, err)
		}
	}
	for _, rejected := range []string{"/", "/api", "/api/v10", "/birdz-old", "/mcpish", "/mcp/../admin", "//evil/x", "https://evil/x"} {
		if _, err := resolveUpstreamWithRoutes(base, rejected, false, routes); err == nil {
			t.Errorf("non-allowlisted path %q accepted", rejected)
		}
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

func TestReadBoundedControlResponse_RejectsOversize(t *testing.T) {
	if _, err := readBoundedControlResponse(bytes.NewReader(make([]byte, controlPlaneResponseLimit+1))); err == nil {
		t.Fatal("oversized hub response accepted")
	}
	if got, err := readBoundedControlResponse(bytes.NewReader([]byte("ok"))); err != nil || string(got) != "ok" {
		t.Fatalf("small response=%q err=%v", got, err)
	}
}

func TestRefresh_RejectsRedirectWithoutLeakingHubBody(t *testing.T) {
	replayed := 0
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		replayed++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", destination.URL+"/stolen")
		w.WriteHeader(http.StatusTemporaryRedirect)
		_, _ = w.Write([]byte("refresh-token-secret"))
	}))
	defer source.Close()
	_, err := refresh(source.URL, "refresh-token-secret")
	if err == nil || !strings.Contains(err.Error(), "HTTP 307") {
		t.Fatalf("redirect error=%v", err)
	}
	if strings.Contains(err.Error(), "refresh-token-secret") {
		t.Fatalf("hub response leaked through error: %v", err)
	}
	if replayed != 0 {
		t.Fatalf("refresh credential followed cross-origin redirect %d time(s)", replayed)
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
		Service: "scraper", Box: "box-1", RefreshToken: "finch_refresh_abc",
	}
	if err := saveState(path, want); err != nil {
		t.Fatalf("saveState: %v", err)
	}
	got, err := loadState(path)
	if err != nil {
		t.Fatalf("loadState: %v", err)
	}
	if got == nil || !reflect.DeepEqual(*got, *want) {
		t.Errorf("round-trip = %+v, want %+v", got, want)
	}
}

func TestSaveState_IsAtomicOwnerOnlyAndRejectsSymlinkTarget(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "credentials")
	path := filepath.Join(dir, "media.json")
	state := &agentState{Hub: "https://finchmcp.com", RefreshToken: "secret"}
	if err := saveState(path, state); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("credential mode=%04o", got)
	}
	if got, _ := os.Lstat(dir); got.Mode().Perm() != 0o700 {
		t.Fatalf("credential directory mode=%04o", got.Mode().Perm())
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadState(path); err == nil {
		t.Fatal("world-readable credential was accepted")
	}

	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if err := saveState(path, state); err == nil {
		t.Fatal("symlink credential target was accepted")
	}
	if got, _ := os.ReadFile(target); string(got) != "keep" {
		t.Fatalf("symlink target changed: %q", got)
	}
}

func TestSaveState_BareRelativePathDoesNotChmodWorkingDirectory(t *testing.T) {
	originalWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(originalWD) })
	if err := saveState("state.json", &agentState{Hub: "https://finchmcp.com", RefreshToken: "secret"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o755 {
		t.Fatalf("working directory mode changed to %04o", got)
	}
}

func TestLoadState_RejectsOversizedCredential(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), credentialStateLimit+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadState(path); err == nil {
		t.Fatal("oversized credential state was accepted")
	}
}

func TestZeroConfigRunDefaultsHonorContainerEnvironment(t *testing.T) {
	t.Setenv("FINCH_HUB", "https://staging.finch.example")
	t.Setenv("FINCH_BOX", "aviary-container")
	t.Setenv("FINCH_CREDENTIALS_DIR", "/data/scoped-credentials")
	if got := agentDefaultHub(); got != "https://staging.finch.example" {
		t.Fatalf("hub default=%q", got)
	}
	if got := agentDefaultBox("hostname"); got != "aviary-container" {
		t.Fatalf("box default=%q", got)
	}
	if got := dynamicCredentialsDir(); got != "/data/scoped-credentials" {
		t.Fatalf("credentials default=%q", got)
	}
}
