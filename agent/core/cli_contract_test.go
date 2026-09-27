package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Every failure maps to one exit code and, with --json, one strictly shaped
// envelope on stderr with nothing on stdout. The "next" command is part of the
// contract: an agent runs it verbatim.
func TestCLIErrorContract(t *testing.T) {
	type setup func(t *testing.T, h *fakeHub)
	loggedIn := func(t *testing.T, h *fakeHub) { loginTo(t, h) }
	withNotes := func(t *testing.T, h *fakeHub) {
		loginTo(t, h)
		h.set(func(h *fakeHub) { h.services["notes"] = "key" })
	}
	for _, tc := range []struct {
		name     string
		setup    setup
		args     []string
		wantExit int
		wantCode string
		wantNext string
	}{
		{name: "unknown command", args: []string{"frobnicate", "--json"}, wantExit: 2, wantCode: "USAGE", wantNext: "finch help"},
		{name: "unknown flag", args: []string{"status", "--bogus", "--json"}, wantExit: 2, wantCode: "USAGE", wantNext: "finch help"},
		{name: "add without --service", args: []string{"add", "notes", "--json"}, wantExit: 2, wantCode: "USAGE", wantNext: "finch help"},
		{name: "add with a non-http service", args: []string{"add", "notes", "--service", "ftp://x", "--json"}, wantExit: 2, wantCode: "USAGE", wantNext: "finch help"},
		{name: "login --start and --poll together", args: []string{"login", "--start", "--poll", "--json"}, wantExit: 2, wantCode: "USAGE", wantNext: "finch help"},
		{name: "connect to an unknown client", args: []string{"connect", "notes", "--client", "emacs", "--json"}, wantExit: 2, wantCode: "USAGE", wantNext: "finch help"},
		{name: "service without an action", args: []string{"service", "--json"}, wantExit: 2, wantCode: "USAGE", wantNext: "finch help"},
		{name: "add while not logged in", args: []string{"add", "notes", "--service", "http://127.0.0.1:8000", "--json"}, wantExit: 12, wantCode: "NOT_LOGGED_IN", wantNext: "finch login --start"},
		{name: "test while not logged in", args: []string{"test", "notes", "--json"}, wantExit: 12, wantCode: "NOT_LOGGED_IN", wantNext: "finch login --start"},
		{
			name: "add while a login awaits approval",
			setup: func(t *testing.T, h *fakeHub) {
				if err := savePendingLogin(&pendingLogin{Hub: h.url(), DeviceCode: "d", UserCode: "AB-CD", VerificationURIComplete: "https://x/cli", Interval: 3, ExpiresAt: time.Now().Add(time.Minute).Unix()}); err != nil {
					t.Fatal(err)
				}
			},
			args: []string{"add", "notes", "--service", "http://127.0.0.1:8000", "--json"}, wantExit: 10, wantCode: "APPROVAL_PENDING", wantNext: "finch login --poll",
		},
		{name: "poll with no login in progress", args: []string{"login", "--poll", "--json"}, wantExit: 1, wantCode: "NOT_FOUND", wantNext: "finch login --start"},
		{
			name: "revoked CLI token",
			setup: func(t *testing.T, h *fakeHub) {
				if err := saveCliCred(&cliCred{Hub: h.url(), Token: "revoked"}); err != nil {
					t.Fatal(err)
				}
			},
			args: []string{"fleet", "--json"}, wantExit: 12, wantCode: "NOT_LOGGED_IN", wantNext: "finch login --start",
		},
		{name: "test an unknown service", setup: loggedIn, args: []string{"test", "ghost", "--json"}, wantExit: 1, wantCode: "NOT_FOUND", wantNext: "finch fleet"},
		{name: "connect an unknown service", setup: loggedIn, args: []string{"connect", "ghost", "--client", "json", "--json"}, wantExit: 1, wantCode: "NOT_FOUND", wantNext: "finch add ghost --service <url>"},
		{
			name:  "hub down",
			setup: func(t *testing.T, h *fakeHub) { withNotes(t, h); h.set(func(h *fakeHub) { h.down = true }) },
			args:  []string{"fleet", "--json"}, wantExit: 1, wantCode: "UPSTREAM",
		},
		{
			name: "MCP error from the service",
			setup: func(t *testing.T, h *fakeHub) {
				withNotes(t, h)
				h.set(func(h *fakeHub) {
					h.call = func(string) (int, string, string) {
						return 200, "application/json", `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}`
					}
				})
			},
			args: []string{"test", "notes", "--json"}, wantExit: 1, wantCode: "UPSTREAM",
		},
		{
			name: "box offline",
			setup: func(t *testing.T, h *fakeHub) {
				withNotes(t, h)
				h.set(func(h *fakeHub) {
					h.call = func(string) (int, string, string) {
						return 503, "application/json", `{"error":"service offline"}`
					}
				})
			},
			args: []string{"test", "notes", "--json"}, wantExit: 1, wantCode: "UPSTREAM", wantNext: "finch service status",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			isolate(t)
			h := newFakeHub(t)
			if tc.setup != nil {
				tc.setup(t, h)
			}
			stdout, stderr, code := finch(t, tc.args...)
			if code != tc.wantExit {
				t.Fatalf("exit=%d, want %d (stderr %q)", code, tc.wantExit, stderr)
			}
			if stdout != "" {
				t.Fatalf("an error must leave stdout empty, got %q", stdout)
			}
			env := decodeJSONError(t, stderr)
			if env.Error.Code != tc.wantCode || env.Error.Next != tc.wantNext {
				t.Fatalf("error=%+v, want code %s next %q", env.Error, tc.wantCode, tc.wantNext)
			}

			// The same failure without --json: plain text, same exit code.
			var plain []string
			for _, a := range tc.args {
				if a != "--json" {
					plain = append(plain, a)
				}
			}
			_, perr, pcode := finch(t, plain...)
			if pcode != tc.wantExit || !strings.HasPrefix(perr, "finch: ") || strings.Contains(perr, `"schema_version"`) {
				t.Fatalf("plain mode: exit=%d stderr=%q", pcode, perr)
			}
			if tc.wantNext != "" && !strings.Contains(perr, "next: "+tc.wantNext) {
				t.Fatalf("plain mode does not name the next command: %q", perr)
			}
		})
	}
}

func TestWantsJSON(t *testing.T) {
	for args, want := range map[string]bool{
		"--json":         true,
		"-json":          true,
		"notes --json":   true,
		"--json=true":    true,
		"notes":          false,
		"-- --json":      false,
		"--jsonish":      false,
		"--json=false":   false,
		"--client json":  false,
		"--args {\"a\":": false,
	} {
		if got := wantsJSON(strings.Fields(args)); got != want {
			t.Errorf("wantsJSON(%q)=%v, want %v", args, got, want)
		}
	}
}

func TestLoginStartPollApproved(t *testing.T) {
	home := isolate(t)
	h := newFakeHub(t)
	t.Setenv("FINCH_HUB", h.url())

	stdout, stderr, code := finch(t, "login", "--start", "--json")
	if code != 0 {
		t.Fatalf("login --start exit=%d stderr=%q", code, stderr)
	}
	// Exactly the contract's fields.
	var start map[string]any
	if err := json.Unmarshal([]byte(stdout), &start); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"schema_version":            float64(1),
		"user_code":                 "WXYZ-2345",
		"verification_uri_complete": h.url() + "/cli?code=WXYZ-2345",
		"expires_in":                float64(600),
		"interval":                  float64(3),
	}
	if !reflect.DeepEqual(start, want) {
		t.Fatalf("login --start payload=%v, want %v", start, want)
	}
	if h.polls != 0 {
		t.Fatalf("login --start must not poll, polled %d times", h.polls)
	}
	pendingPath := filepath.Join(home, ".finch", "login-pending.json")
	if got := fileMode(t, pendingPath); got != 0o600 {
		t.Fatalf("pending login mode=%04o, want 0600", got)
	}
	if !strings.Contains(mustRead(t, pendingPath), h.deviceCode) {
		t.Fatal("pending login does not hold the device code")
	}

	stdout, _, code = finch(t, "login", "--poll", "--json")
	if code != 10 || strings.TrimSpace(stdout) != `{"schema_version":1,"status":"pending"}` {
		t.Fatalf("pending poll: exit=%d stdout=%q", code, stdout)
	}
	if _, err := os.Stat(pendingPath); err != nil {
		t.Fatal("a pending poll must keep the pending login")
	}

	h.set(func(h *fakeHub) { h.deviceState = "approved" })
	stdout, stderr, code = finch(t, "login", "--poll", "--json")
	if code != 0 {
		t.Fatalf("approved poll exit=%d stderr=%q", code, stderr)
	}
	if got := decodeJSONOut(t, stdout); got["status"] != "approved" || got["account"] != "owner@example.com" || len(got) != 3 {
		t.Fatalf("approved payload=%v", got)
	}
	if _, err := os.Stat(pendingPath); !os.IsNotExist(err) {
		t.Fatal("the pending login must be removed once approved")
	}
	cred, err := loadCliCred()
	if err != nil || cred.Token != fakeCLIToken || cred.Hub != h.url() || cred.Tenant != "user_1" {
		t.Fatalf("saved credential=%+v err=%v", cred, err)
	}
	if strings.Contains(stdout+stderr, fakeCLIToken) {
		t.Fatal("login printed the CLI token")
	}

	// Nothing left to poll.
	_, stderr, code = finch(t, "login", "--poll", "--json")
	if code != 1 || decodeJSONError(t, stderr).Error.Code != "NOT_FOUND" {
		t.Fatalf("poll after approval: exit=%d stderr=%q", code, stderr)
	}
}

func TestLoginPollExpired(t *testing.T) {
	for _, tc := range []struct {
		name      string
		hubState  string
		clockSkew time.Duration
		wantPolls int
	}{
		{name: "hub says expired", hubState: "expired", wantPolls: 1},
		{name: "local deadline passed", hubState: "pending", clockSkew: 11 * time.Minute, wantPolls: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := isolate(t)
			h := newFakeHub(t)
			t.Setenv("FINCH_HUB", h.url())
			if _, _, code := finch(t, "login", "--start", "--json"); code != 0 {
				t.Fatal("login --start failed")
			}
			h.set(func(h *fakeHub) { h.deviceState = tc.hubState })
			loginNow = func() time.Time { return time.Now().Add(tc.clockSkew) }
			stdout, _, code := finch(t, "login", "--poll", "--json")
			if code != 11 || strings.TrimSpace(stdout) != `{"schema_version":1,"status":"expired"}` {
				t.Fatalf("exit=%d stdout=%q", code, stdout)
			}
			if h.polls != tc.wantPolls {
				t.Fatalf("hub polled %d times, want %d", h.polls, tc.wantPolls)
			}
			if _, err := os.Stat(filepath.Join(home, ".finch", "login-pending.json")); !os.IsNotExist(err) {
				t.Fatal("an expired pending login must be removed")
			}
		})
	}
}

func TestLoginPollRejectsDifferentHub(t *testing.T) {
	isolate(t)
	h := newFakeHub(t)
	if _, _, code := finch(t, "login", "--start", "--hub", h.url()); code != 0 {
		t.Fatal("login --start failed")
	}
	_, stderr, code := finch(t, "login", "--poll", "--hub", "https://other.example", "--json")
	if code != 2 || decodeJSONError(t, stderr).Error.Code != "USAGE" {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
}

func TestBlockingLoginStillWaits(t *testing.T) {
	isolate(t)
	h := newFakeHub(t)
	sleeps := 0
	loginSleep = func(time.Duration) {
		sleeps++
		if sleeps == 2 {
			h.set(func(h *fakeHub) { h.deviceState = "approved" })
		}
	}
	stdout, stderr, code := finch(t, "login", "--hub", h.url(), "--headless")
	if code != 0 || stderr != "" {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if !strings.Contains(stdout, "WXYZ-2345") || !strings.Contains(stdout, "logged in as owner@example.com") || h.polls != 2 {
		t.Fatalf("blocking login should show the code and poll until approved: polls=%d stdout=%q", h.polls, stdout)
	}

	// Expiry while blocking is exit 11 / EXPIRED.
	isolate(t)
	h = newFakeHub(t)
	h.set(func(h *fakeHub) { h.deviceState = "expired" })
	loginSleep = func(time.Duration) {}
	_, stderr, code = finch(t, "login", "--hub", h.url(), "--headless")
	if code != 11 || !strings.Contains(stderr, "expired") || !strings.Contains(stderr, "next: finch login") {
		t.Fatalf("expired blocking login: exit=%d stderr=%q", code, stderr)
	}
}

// The blocking login has to show a human its link while it waits, which
// --json has no stream for (stderr carries only the one error envelope), so
// with --json it refuses up front and points at the two-step form. Nothing is
// started on the hub.
func TestBlockingLoginRefusesJSON(t *testing.T) {
	isolate(t)
	h := newFakeHub(t)
	stdout, stderr, code := finch(t, "login", "--hub", h.url(), "--headless", "--json")
	env := decodeJSONError(t, stderr)
	if code != 2 || stdout != "" || env.Error.Code != "USAGE" || env.Error.Next != "finch login --start --json" {
		t.Fatalf("exit=%d stdout=%q env=%+v", code, stdout, env)
	}
	if h.polls != 0 || fileExists(pendingLoginPath()) {
		t.Fatal("a refused blocking login must not start anything")
	}
}

// A started login blocks the saved one: an agent switching account or hub with
// --start must not keep acting on the old tenant until the new login resolves.
// --cancel lifts the block, and so does the poll resolving it.
func TestPendingLoginBlocksTheSavedLogin(t *testing.T) {
	isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	h.set(func(h *fakeHub) { h.services["notes"] = "key" })
	if _, stderr, code := finch(t, "fleet", "--json"); code != 0 {
		t.Fatalf("fleet with a saved login: exit=%d stderr=%q", code, stderr)
	}

	if _, stderr, code := finch(t, "login", "--start", "--hub", h.url(), "--json"); code != 0 {
		t.Fatalf("login --start: exit=%d stderr=%q", code, stderr)
	}
	for _, args := range [][]string{
		{"fleet", "--json"},
		{"add", "api", "--service", "http://127.0.0.1:9000", "--json"},
		{"connect", "notes", "--client", "json", "--json"},
		{"keys", "--json"},
	} {
		stdout, stderr, code := finch(t, args...)
		env := decodeJSONError(t, stderr)
		if code != 10 || stdout != "" || env.Error.Code != "APPROVAL_PENDING" || env.Error.Next != "finch login --poll" || !strings.Contains(env.Error.Message, "finch login --cancel") {
			t.Fatalf("%v while a login is pending: exit=%d stdout=%q env=%+v", args, code, stdout, env)
		}
	}
	if h.nextKey != 0 || len(h.services) != 1 {
		t.Fatal("a command acted on the old tenant while a login was pending")
	}
	// status reports the pending login, not the blocked saved one.
	stdout, _, code := finch(t, "status", "--json")
	if got := decodeJSONOut(t, stdout); code != 0 || got["loggedIn"] != false || got["login_pending"] != true || got["hub"] != h.url() || got["account"] != nil {
		t.Fatalf("status while pending: exit=%d payload=%v", code, got)
	}
	if stdout, _, _ := finch(t, "status"); !strings.Contains(stdout, "login waiting for approval") {
		t.Fatalf("plain status while pending: %q", stdout)
	}

	// --cancel drops the started login and the saved one works again.
	stdout, stderr, code := finch(t, "login", "--cancel", "--json")
	if code != 0 || decodeJSONOut(t, stdout)["cancelled"] != true {
		t.Fatalf("login --cancel: exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
	if fileExists(pendingLoginPath()) {
		t.Fatal("--cancel left the pending login")
	}
	if _, stderr, code := finch(t, "fleet", "--json"); code != 0 {
		t.Fatalf("fleet after --cancel: exit=%d stderr=%q", code, stderr)
	}
	stdout, _, code = finch(t, "login", "--cancel", "--json")
	if code != 0 || decodeJSONOut(t, stdout)["cancelled"] != false {
		t.Fatalf("second --cancel: exit=%d stdout=%q", code, stdout)
	}
	if stdout, _, code := finch(t, "login", "--cancel"); code != 0 || !strings.Contains(stdout, "no login was pending") {
		t.Fatalf("plain --cancel: exit=%d stdout=%q", code, stdout)
	}

	// An expired start no longer blocks anything.
	if _, _, code := finch(t, "login", "--start", "--hub", h.url(), "--json"); code != 0 {
		t.Fatal("login --start failed")
	}
	loginNow = func() time.Time { return time.Now().Add(11 * time.Minute) }
	if _, stderr, code := finch(t, "fleet", "--json"); code != 0 {
		t.Fatalf("fleet after the started login expired: exit=%d stderr=%q", code, stderr)
	}
	loginNow = time.Now

	// A login that completes another way (here --token) supersedes the start.
	if _, _, code := finch(t, "login", "--start", "--hub", h.url(), "--json"); code != 0 {
		t.Fatal("login --start failed")
	}
	t.Setenv("FINCH_CLI_TOKEN", fakeCLIToken)
	if _, stderr, code := finch(t, "login", "--hub", h.url(), "--json"); code != 0 {
		t.Fatalf("login --token: exit=%d stderr=%q", code, stderr)
	}
	if fileExists(pendingLoginPath()) {
		t.Fatal("a completed login left the started one blocking")
	}

	for _, args := range [][]string{{"login", "--cancel", "--poll"}, {"login", "--cancel", "--start"}, {"login", "--cancel", "--token", "-"}} {
		if _, stderr, code := finch(t, append(args, "--json")...); code != 2 || decodeJSONError(t, stderr).Error.Code != "USAGE" {
			t.Fatalf("%v: exit=%d stderr=%q", args, code, stderr)
		}
	}
}

// A relative credentials-dir belongs to the manifest: `finch add --config`
// run from another directory must write the credential where the service
// (which runs in the manifest's directory) and a later `finch run --config`
// look for it.
func TestRelativeCredentialsDirFollowsTheManifest(t *testing.T) {
	home := isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	proj := filepath.Join(home, "proj")
	if err := os.MkdirAll(proj, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(proj, "finch.yml")
	if err := os.WriteFile(cfg, []byte("hub: "+h.url()+"\ncredentials-dir: creds\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	elsewhere := filepath.Join(home, "elsewhere")
	if err := os.MkdirAll(elsewhere, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Chdir(elsewhere)
	if _, stderr, code := finch(t, "add", "notes", "--service", "http://127.0.0.1:8000", "--config", cfg, "--json"); code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if !fileExists(filepath.Join(proj, "creds", "notes.json")) || fileExists(filepath.Join(elsewhere, "creds")) {
		t.Fatal("the credential was not written under the manifest's credentials-dir")
	}
	for _, cwd := range []string{elsewhere, proj, home} {
		t.Chdir(cwd)
		c, err := loadConfig(cfg, "box")
		if err != nil {
			t.Fatalf("from %s: %v", cwd, err)
		}
		if c.CredentialsDir != filepath.Join(proj, "creds") {
			t.Fatalf("from %s: credentials-dir=%q", cwd, c.CredentialsDir)
		}
	}
}

func TestAddPublicPrintsURL(t *testing.T) {
	home := isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	cfg := filepath.Join(home, "finch.yml")

	stdout, stderr, code := finch(t, "add", "notes", "--service", "http://127.0.0.1:8000", "--public", "--config", cfg, "--json")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	got := decodeJSONOut(t, stdout)
	if got["url"] != h.url()+"/notes/mcp" || got["auth"] != "public" || got["app_path"] != "notes" {
		t.Fatalf("payload=%v", got)
	}
	if !reflect.DeepEqual(h.authCalls, []string{"notes=public"}) {
		t.Fatalf("auth calls=%v, want [notes=public]", h.authCalls)
	}
	if !strings.Contains(mustRead(t, cfg), "app_path: notes") {
		t.Fatal("finch.yml was not written")
	}
	if got := fileMode(t, filepath.Join(home, ".finch", "notes.json")); got != 0o600 {
		t.Fatalf("box credential mode=%04o", got)
	}

	// Without --public the access mode is left alone.
	stdout, _, code = finch(t, "add", "api", "--service", "http://127.0.0.1:9000", "--config", cfg, "--json")
	if code != 0 || decodeJSONOut(t, stdout)["auth"] != "key" || len(h.authCalls) != 1 {
		t.Fatalf("add without --public: exit=%d stdout=%q auth calls=%v", code, stdout, h.authCalls)
	}
}

// With --json, a command that printed progress before failing must still leave
// exactly the one error envelope on stderr (decodeJSONError insists on one
// line), and its success payload alone on stdout.
func TestJSONModeKeepsStderrToTheEnvelope(t *testing.T) {
	home := isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	cfg := filepath.Join(home, "finch.yml")
	h.set(func(h *fakeHub) { h.authDown = true })

	// "Notes" is registered as "notes" (a human-mode note), then --public fails.
	stdout, stderr, code := finch(t, "add", "Notes", "--service", "http://127.0.0.1:8000", "--public", "--config", cfg, "--json")
	if code != 1 || stdout != "" {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
	if env := decodeJSONError(t, stderr); env.Error.Code != "UPSTREAM" || !strings.Contains(env.Error.Message, "notes") {
		t.Fatalf("envelope=%+v", env.Error)
	}

	// The same note still reaches a human.
	h.set(func(h *fakeHub) { h.authDown = false })
	stdout, _, code = finch(t, "add", "Api", "--service", "http://127.0.0.1:9000", "--config", cfg)
	if code != 0 || !strings.Contains(stdout, `"Api" was registered as "api"`) {
		t.Fatalf("human add: exit=%d stdout=%q", code, stdout)
	}
}

func TestTestCommandJSON(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		ctype    string
		body     string
		wantExit int
	}{
		{name: "json result", status: 200, ctype: "application/json", body: `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"echo","description":"Echo it"}]}}`},
		{name: "event-stream result", status: 200, ctype: "text/event-stream", body: "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"echo\",\"description\":\"Echo it\"}]}}\n\n"},
		{name: "json-rpc error", status: 200, ctype: "application/json", body: `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"boom"}}`, wantExit: 1},
		{name: "no tools array", status: 200, ctype: "application/json", body: `{"jsonrpc":"2.0","id":1,"result":{}}`, wantExit: 1},
		{name: "not json", status: 200, ctype: "text/html", body: `<html>hi</html>`, wantExit: 1},
		{name: "upstream 502", status: 502, ctype: "application/json", body: `{"error":"bad gateway"}`, wantExit: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			isolate(t)
			h := newFakeHub(t)
			loginTo(t, h)
			h.set(func(h *fakeHub) {
				h.services["notes"] = "key"
				h.call = func(method string) (int, string, string) { return tc.status, tc.ctype, tc.body }
			})
			stdout, stderr, code := finch(t, "test", "notes", "--json")
			if code != tc.wantExit {
				t.Fatalf("exit=%d, want %d (stdout %q stderr %q)", code, tc.wantExit, stdout, stderr)
			}
			if tc.wantExit != 0 {
				if decodeJSONError(t, stderr).Error.Code != "UPSTREAM" || stdout != "" {
					t.Fatalf("stdout=%q stderr=%q", stdout, stderr)
				}
				return
			}
			got := decodeJSONOut(t, stdout)
			tools, _ := got["tools"].([]any)
			if got["ok"] != true || got["service"] != "notes" || len(tools) != 1 {
				t.Fatalf("payload=%v", got)
			}
		})
	}
}

// The hub relays the MCP server's own HTTP status, so a 401 or 404 from the
// server behind finch must not read as "your login is gone" or "no such
// service". Only a 401 the hub itself confirms is NOT_LOGGED_IN.
func TestTestCommandClassifiesRelayedStatuses(t *testing.T) {
	const sdk406 = `{"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"}}`
	const sdk400 = `{"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Bad Request: Missing session ID"}}`
	for _, tc := range []struct {
		name        string
		service     string // defaults to notes, which exists
		token       string // defaults to the valid CLI token
		status      int
		body        string
		wantExit    int
		wantCode    string
		wantNext    string
		wantMessage string
	}{
		{name: "server's own 401", status: 401, body: `{"error":"bad bearer"}`, wantExit: 1, wantCode: "UPSTREAM", wantMessage: "finch login is fine"},
		{name: "revoked finch login", token: "cli_revoked", status: 200, wantExit: 12, wantCode: "NOT_LOGGED_IN", wantNext: "finch login --start"},
		{name: "server's own 404", status: 404, body: `{"detail":"Not Found"}`, wantExit: 1, wantCode: "UPSTREAM", wantMessage: "no MCP endpoint at /mcp"},
		{name: "service not in the account", service: "ghost", wantExit: 1, wantCode: "NOT_FOUND", wantNext: "finch fleet", wantMessage: `no service named "ghost"`},
		{name: "SDK 406 without SSE accept", status: 406, body: sdk406, wantExit: 1, wantCode: "UPSTREAM", wantNext: "finch connect notes --client <client>", wantMessage: "does not mean the service is down"},
		{name: "SDK 400 missing session", status: 400, body: sdk400, wantExit: 1, wantCode: "UPSTREAM", wantNext: "finch connect notes --client <client>", wantMessage: "Missing session ID"},
		{name: "server's own 403", status: 403, body: `{"error":"forbidden"}`, wantExit: 1, wantCode: "UPSTREAM", wantMessage: "HTTP 403: forbidden"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			isolate(t)
			h := newFakeHub(t)
			token := tc.token
			if token == "" {
				token = fakeCLIToken
			}
			if err := saveCliCred(&cliCred{Hub: h.url(), Token: token, Email: "owner@example.com", Tenant: "user_1"}); err != nil {
				t.Fatal(err)
			}
			h.set(func(h *fakeHub) {
				h.services["notes"] = "key"
				h.call = func(string) (int, string, string) { return tc.status, "application/json", tc.body }
			})
			service := tc.service
			if service == "" {
				service = "notes"
			}
			stdout, stderr, code := finch(t, "test", service, "--json")
			if code != tc.wantExit || stdout != "" {
				t.Fatalf("exit=%d, want %d (stdout %q stderr %q)", code, tc.wantExit, stdout, stderr)
			}
			env := decodeJSONError(t, stderr)
			if env.Error.Code != tc.wantCode || env.Error.Next != tc.wantNext || !strings.Contains(env.Error.Message, tc.wantMessage) {
				t.Fatalf("envelope=%+v", env.Error)
			}
			if tc.wantCode == "UPSTREAM" && strings.Contains(env.Error.Message, "expired or revoked") {
				t.Fatalf("an upstream failure blamed the finch login: %q", env.Error.Message)
			}
		})
	}
}

func TestCallToolErrorExitsNonZero(t *testing.T) {
	isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	h.set(func(h *fakeHub) {
		h.services["notes"] = "key"
		h.call = func(string) (int, string, string) {
			return 200, "application/json", `{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"no such note"}]}}`
		}
	})
	_, stderr, code := finch(t, "call", "notes", "read", "--args", `{"id":"x"}`, "--json")
	if code != 1 || !strings.Contains(decodeJSONError(t, stderr).Error.Message, "no such note") {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	_, stderr, code = finch(t, "call", "notes", "read", "--args", `[1]`, "--json")
	if code != 2 || decodeJSONError(t, stderr).Error.Code != "USAGE" {
		t.Fatalf("non-object --args: exit=%d stderr=%q", code, stderr)
	}
}

func TestStatusJSONWhenLoggedOut(t *testing.T) {
	isolate(t)
	stdout, stderr, code := finch(t, "status", "--json")
	if code != 0 {
		t.Fatalf("status must report, not fail: exit=%d stderr=%q", code, stderr)
	}
	got := decodeJSONOut(t, stdout)
	svc, _ := got["service"].(map[string]any)
	if got["loggedIn"] != false || got["login_pending"] != false || svc["installed"] != false {
		t.Fatalf("payload=%v", got)
	}
}

func TestListCommandsWrapArraysWithSchemaVersion(t *testing.T) {
	isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	h.set(func(h *fakeHub) { h.services["notes"] = "key" })
	for cmd, field := range map[string]string{"fleet": "services", "keys": "keys"} {
		stdout, stderr, code := finch(t, cmd, "--json")
		if code != 0 {
			t.Fatalf("%s: exit=%d stderr=%q", cmd, code, stderr)
		}
		if _, ok := decodeJSONOut(t, stdout)[field].([]any); !ok {
			t.Fatalf("%s --json lacks a %q array: %q", cmd, field, stdout)
		}
	}
}

// help and guide keep the --json contract: one schema-versioned object on
// stdout carrying the prose (and, for help, the command table as rows).
func TestHelpAndGuideJSON(t *testing.T) {
	isolate(t)
	for _, tc := range []struct {
		args []string
		text string
	}{
		{[]string{"help", "--json"}, usageText},
		{[]string{"--help", "--json"}, usageText},
		{[]string{"guide", "--json"}, guideText},
	} {
		stdout, stderr, code := finch(t, tc.args...)
		if code != 0 || stderr != "" {
			t.Fatalf("%v: exit=%d stderr=%q", tc.args, code, stderr)
		}
		got := decodeJSONOut(t, stdout)
		if got["text"] != tc.text {
			t.Fatalf("%v: text=%q", tc.args, got["text"])
		}
		if tc.text == guideText {
			if _, ok := got["commands"]; ok {
				t.Fatalf("guide payload has commands: %v", got)
			}
			continue
		}
		rows, _ := got["commands"].([]any)
		if len(rows) < 20 {
			t.Fatalf("help commands=%v", got["commands"])
		}
		first, _ := rows[0].(map[string]any)
		if first["usage"] != "login [--hub URL]" || !strings.HasPrefix(first["summary"].(string), "Log in and wait") {
			t.Fatalf("first row=%v", first)
		}
		for _, r := range rows {
			m := r.(map[string]any)
			if len(m) != 2 || m["usage"] == "" || m["summary"] == "" {
				t.Fatalf("bad row %v", m)
			}
		}
	}
	// Without --json they stay prose.
	if stdout, _, code := finch(t, "help"); code != 0 || stdout != usageText {
		t.Fatalf("plain help: exit=%d", code)
	}
	if stdout, _, code := finch(t, "guide"); code != 0 || stdout != guideText {
		t.Fatalf("plain guide: exit=%d", code)
	}
}
