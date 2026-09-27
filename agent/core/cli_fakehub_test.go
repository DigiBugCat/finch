package core

// Shared fixtures for the CLI contract tests: an isolated HOME/cwd, a runner
// that drives the real dispatcher, and a strict fake hub. The fake rejects
// anything the real hub would (missing/invalid bearer, unknown service, bad
// bodies) instead of answering 200 to whatever it is sent, so a CLI that sends
// the wrong request fails its test.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

const fakeCLIToken = "cli_test_token"

// isolate gives a test its own HOME and cwd, points the CLI at no hub, and
// replaces every side-effecting seam (service manager, browser, sleeps) with
// one that fails the test if it is used unexpectedly.
func isolate(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("CODEX_HOME", "")
	t.Setenv("FINCH_CLI_TOKEN", "")
	t.Setenv("FINCH_TICKET", "")
	t.Setenv("FINCH_HUB", "")
	t.Chdir(home)

	oldGOOS, oldRun, oldExe, oldSleep := serviceGOOS, runServiceCommand, serviceExecutable, serviceSleep
	oldNow, oldLoginSleep, oldOpen := loginNow, loginSleep, openURL
	t.Cleanup(func() {
		serviceGOOS, runServiceCommand, serviceExecutable, serviceSleep = oldGOOS, oldRun, oldExe, oldSleep
		loginNow, loginSleep, openURL = oldNow, oldLoginSleep, oldOpen
	})
	// Read-only status queries answer "not running"; anything that would
	// change the real machine's services fails the test.
	runServiceCommand = func(name string, args ...string) (string, error) {
		cmd := name + " " + strings.Join(args, " ")
		if strings.HasPrefix(cmd, "launchctl print ") {
			return "Could not find service", fmt.Errorf("exit status 113")
		}
		if strings.HasPrefix(cmd, "systemctl --user is-active ") {
			return "inactive\n", fmt.Errorf("exit status 3")
		}
		t.Errorf("unexpected service-manager command: %s", cmd)
		return "", fmt.Errorf("unexpected command")
	}
	serviceExecutable = func() (string, error) { return "/opt/finch/bin/finch", nil }
	serviceSleep = func(time.Duration) {}
	loginSleep = func(time.Duration) { t.Error("unexpected sleep in a non-blocking login step") }
	openURL = func(u string) { t.Errorf("unexpected browser open: %s", u) }
	return home
}

// finch runs the real CLI dispatcher and returns stdout, stderr and the exit code.
func finch(t *testing.T, args ...string) (string, string, int) {
	t.Helper()
	var out, errOut bytes.Buffer
	code, handled := runCLI(args, strings.NewReader(""), &out, &errOut)
	if !handled {
		t.Fatalf("finch %v was not handled by the CLI dispatcher", args)
	}
	return out.String(), errOut.String(), code
}

type jsonErrorEnvelope struct {
	SchemaVersion int `json:"schema_version"`
	Error         struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Next    string `json:"next"`
	} `json:"error"`
}

// decodeJSONError strictly decodes the --json error envelope (unknown fields
// rejected) from stderr, which must hold exactly one line.
func decodeJSONError(t *testing.T, stderr string) jsonErrorEnvelope {
	t.Helper()
	lines := strings.Split(strings.TrimRight(stderr, "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("stderr must be one JSON line, got %q", stderr)
	}
	dec := json.NewDecoder(strings.NewReader(lines[0]))
	dec.DisallowUnknownFields()
	var env jsonErrorEnvelope
	if err := dec.Decode(&env); err != nil {
		t.Fatalf("stderr is not the error envelope: %v: %q", err, stderr)
	}
	if env.SchemaVersion != 1 || env.Error.Code == "" || env.Error.Message == "" {
		t.Fatalf("incomplete error envelope: %+v", env)
	}
	return env
}

// decodeJSONOut decodes a --json success payload (one line) and checks its schema_version.
func decodeJSONOut(t *testing.T, stdout string) map[string]any {
	t.Helper()
	if strings.Count(strings.TrimRight(stdout, "\n"), "\n") != 0 {
		t.Fatalf("stdout must be one JSON line, got %q", stdout)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("stdout is not JSON: %v: %q", err, stdout)
	}
	if m["schema_version"] != float64(1) {
		t.Fatalf("payload lacks schema_version 1: %v", m)
	}
	return m
}

var slugRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

type fakeHub struct {
	t   *testing.T
	srv *httptest.Server

	mu          sync.Mutex
	deviceCode  string
	userCode    string
	deviceState string // pending | approved | expired | consumed
	polls       int
	services    map[string]string // id -> auth mode
	host        string
	keys        map[string]string // id -> label
	nextKey     int
	revoked     []string
	authCalls   []string // "id=mode"
	callMethods []string
	// call answers /api/cli/call for a known service: status + body.
	call func(method string) (int, string, string)
	down bool // every authed route answers 503
}

func newFakeHub(t *testing.T) *fakeHub {
	h := &fakeHub{
		t:           t,
		deviceCode:  "dev_0123456789abcdef",
		userCode:    "WXYZ-2345",
		deviceState: "pending",
		services:    map[string]string{},
		keys:        map[string]string{},
	}
	h.call = func(method string) (int, string, string) {
		return 200, "application/json", `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"echo","description":"Echo it"}]}}`
	}
	h.srv = httptest.NewServer(http.HandlerFunc(h.serve))
	t.Cleanup(h.srv.Close)
	return h
}

func (h *fakeHub) url() string { return h.srv.URL }

func (h *fakeHub) set(f func(h *fakeHub)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	f(h)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// body decodes a strict JSON object body, answering 400 when it is not one.
func (h *fakeHub) body(w http.ResponseWriter, r *http.Request, into any) bool {
	if r.Header.Get("Content-Type") != "application/json" {
		writeJSON(w, 400, map[string]string{"error": "content-type must be application/json"})
		return false
	}
	b, _ := io.ReadAll(r.Body)
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad body: " + err.Error()})
		return false
	}
	return true
}

func (h *fakeHub) serve(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	route := r.Method + " " + r.URL.Path

	// Unauthenticated device flow.
	switch route {
	case "POST /api/cli/device/start":
		var b struct{}
		if !h.body(w, r, &b) {
			return
		}
		if r.Header.Get("Authorization") != "" {
			writeJSON(w, 400, map[string]string{"error": "device/start takes no credential"})
			return
		}
		writeJSON(w, 200, map[string]any{
			"device_code":               h.deviceCode,
			"user_code":                 h.userCode,
			"verification_uri":          h.srv.URL + "/cli",
			"verification_uri_complete": h.srv.URL + "/cli?code=" + h.userCode,
			"expires_in":                600,
			"interval":                  3,
		})
		return
	case "POST /api/cli/device/poll":
		var b struct {
			DeviceCode string `json:"device_code"`
		}
		if !h.body(w, r, &b) {
			return
		}
		h.polls++
		if b.DeviceCode != h.deviceCode {
			writeJSON(w, 200, map[string]string{"status": "not_found"})
			return
		}
		switch h.deviceState {
		case "approved":
			h.deviceState = "consumed"
			writeJSON(w, 200, map[string]string{"status": "approved", "token": fakeCLIToken, "tenant": "user_1", "email": "owner@example.com"})
		case "consumed":
			writeJSON(w, 200, map[string]string{"status": "not_found"})
		default:
			writeJSON(w, 200, map[string]string{"status": h.deviceState})
		}
		return
	case "POST /join":
		var b struct{ Ticket, Box, OS, Version string }
		if !h.body(w, r, &b) {
			return
		}
		id := strings.TrimPrefix(b.Ticket, "tkt_")
		if _, ok := h.services[id]; !ok || !strings.HasPrefix(b.Ticket, "tkt_") || b.Box == "" {
			writeJSON(w, 403, map[string]string{"error": "bad ticket"})
			return
		}
		writeJSON(w, 200, joinResp{OK: true, Tenant: "user_1", Service: id, Box: b.Box, ConnectToken: "ct", RefreshToken: "rt_" + id})
		return
	}

	if r.Header.Get("Authorization") != "Bearer "+fakeCLIToken {
		writeJSON(w, 401, map[string]string{"error": "missing, invalid, or expired CLI token"})
		return
	}
	if h.down {
		writeJSON(w, 503, map[string]string{"error": "hub unavailable"})
		return
	}
	switch route {
	case "GET /api/cli/whoami":
		writeJSON(w, 200, map[string]any{"ok": true, "tenant": "user_1"})
	case "POST /api/cli/enroll":
		var b struct {
			Name string `json:"name"`
		}
		if !h.body(w, r, &b) {
			return
		}
		if !slugRE.MatchString(b.Name) {
			writeJSON(w, 400, map[string]string{"error": "bad name"})
			return
		}
		h.services[b.Name] = "key"
		writeJSON(w, 200, map[string]any{"id": b.Name, "ticket": "tkt_" + b.Name, "url": h.srv.URL + "/" + b.Name + "/mcp", "install": "x", "expiresAt": 1})
	case "POST /api/cli/auth":
		var b struct{ Service, Mode string }
		if !h.body(w, r, &b) {
			return
		}
		if _, ok := h.services[b.Service]; !ok {
			writeJSON(w, 404, map[string]any{"ok": false, "error": "unknown service"})
			return
		}
		if b.Mode != "key" && b.Mode != "public" {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "bad mode"})
			return
		}
		h.services[b.Service] = b.Mode
		h.authCalls = append(h.authCalls, b.Service+"="+b.Mode)
		writeJSON(w, 200, map[string]any{"ok": true})
	case "GET /api/cli/state":
		services := []map[string]any{}
		for id, auth := range h.services {
			services = append(services, map[string]any{"id": id, "state": "online", "auth": auth})
		}
		keys := []map[string]any{}
		for id, label := range h.keys {
			keys = append(keys, map[string]any{"id": id, "label": label})
		}
		writeJSON(w, 200, map[string]any{"host": h.host, "services": services, "keys": keys})
	case "POST /api/cli/keys":
		var b struct {
			Label string `json:"label"`
			Scope struct {
				Services []string `json:"services"`
			} `json:"scope"`
		}
		if !h.body(w, r, &b) {
			return
		}
		if b.Label == "" || len(b.Scope.Services) != 1 {
			writeJSON(w, 400, map[string]string{"error": "label and a one-service scope required"})
			return
		}
		if _, ok := h.services[b.Scope.Services[0]]; !ok {
			writeJSON(w, 400, map[string]string{"error": "unknown service in scope"})
			return
		}
		h.nextKey++
		id := fmt.Sprintf("k_%d", h.nextKey)
		h.keys[id] = b.Label
		writeJSON(w, 200, map[string]any{"key": fmt.Sprintf("finch_secret%d", h.nextKey), "id": id, "label": b.Label, "last4": "0000"})
	case "POST /api/cli/keys/revoke":
		var b struct {
			ID string `json:"id"`
		}
		if !h.body(w, r, &b) {
			return
		}
		if _, ok := h.keys[b.ID]; !ok {
			writeJSON(w, 404, map[string]any{"ok": false})
			return
		}
		delete(h.keys, b.ID)
		h.revoked = append(h.revoked, b.ID)
		writeJSON(w, 200, map[string]any{"ok": true})
	case "POST /api/cli/call":
		var b struct {
			Service string         `json:"service"`
			Method  string         `json:"method"`
			Params  map[string]any `json:"params"`
		}
		if !h.body(w, r, &b) {
			return
		}
		if b.Method != "tools/list" && b.Method != "tools/call" {
			writeJSON(w, 400, map[string]string{"error": "unexpected method " + b.Method})
			return
		}
		if _, ok := h.services[b.Service]; !ok {
			writeJSON(w, 404, map[string]string{"error": "unknown service"})
			return
		}
		h.callMethods = append(h.callMethods, b.Method)
		status, ctype, body := h.call(b.Method)
		w.Header().Set("Content-Type", ctype)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	default:
		writeJSON(w, 404, map[string]string{"error": "unknown CLI route", "path": r.URL.Path})
	}
}

// loginTo saves a CLI credential for the fake hub, as a finished login would.
func loginTo(t *testing.T, h *fakeHub) {
	t.Helper()
	if err := saveCliCred(&cliCred{Hub: h.url(), Token: fakeCLIToken, Email: "owner@example.com", Tenant: "user_1"}); err != nil {
		t.Fatal(err)
	}
}

func fileMode(t *testing.T, p string) os.FileMode {
	t.Helper()
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	return st.Mode().Perm()
}

func mustRead(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Clean(p))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
