package core

// The first five minutes and the end of a service's life: help that answers
// the question asked, add that updates instead of duplicating, rm and
// uninstall that leave nothing behind, logs, and URLs in status and fleet.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBareFinchPrintsHelp(t *testing.T) {
	isolate(t)
	stdout, stderr, code := finch(t)
	if code != 0 || stderr != "" || stdout != usageText {
		t.Fatalf("bare finch: exit=%d stderr=%q stdout=%q", code, stderr, stdout)
	}
	// A person is sent to the one-step login, never the agent's two steps.
	if !strings.Contains(usageText, "  finch login  ") || strings.Contains(usageText, "--start") {
		t.Fatalf("top-level help does not lead with plain 'finch login':\n%s", usageText)
	}
	for _, retired := range []string{"approve <name>", "enroll", "join", "dashboard", "box", "ingress", "app_path", "tenant"} {
		if strings.Contains(strings.SplitN(usageText, "More:", 2)[0], retired) {
			t.Errorf("top-level help mentions %q", retired)
		}
	}
}

// Every command answers `finch help <cmd>` and `finch <cmd> -h` with the same
// formatted help (usage, described flags, an example), exiting 0.
func TestPerCommandHelp(t *testing.T) {
	isolate(t)
	for _, d := range commandDocs {
		t.Run(d.name, func(t *testing.T) {
			viaHelp, stderr, code := finch(t, "help", d.name)
			if code != 0 || stderr != "" {
				t.Fatalf("help %s: exit=%d stderr=%q", d.name, code, stderr)
			}
			for _, want := range []string{"finch " + d.name + " — ", "Usage:\n  finch " + d.usage[0] + "\n", "Example:\n  " + d.example + "\n"} {
				if !strings.Contains(viaHelp, want) {
					t.Fatalf("help %s lacks %q:\n%s", d.name, want, viaHelp)
				}
			}
			if strings.Contains(viaHelp, "Usage of") || strings.Contains(viaHelp, "`") {
				t.Fatalf("help %s is a raw flag dump:\n%s", d.name, viaHelp)
			}
			if d.name == "help" || d.name == "join" {
				return // `finch join -h` is served by Main; `help -h` is help
			}
			var out, errOut strings.Builder
			code, handled := runCLI([]string{d.name, "-h"}, strings.NewReader(""), &out, &errOut)
			if !handled || code != 0 || errOut.String() != "" || out.String() != viaHelp {
				t.Fatalf("%s -h: handled=%v exit=%d stderr=%q\n%s\nwant\n%s", d.name, handled, code, errOut.String(), out.String(), viaHelp)
			}
		})
	}
	// Flags are listed with their argument and description.
	add, _, _ := finch(t, "help", "add")
	for _, want := range []string{"  --service <url>  ", "  --forward-all  ", "  --public  ", "  --config <finch.yml>  "} {
		if !strings.Contains(add, want) {
			t.Fatalf("add help lacks %q:\n%s", want, add)
		}
	}
	svc, _, _ := finch(t, "service", "-h")
	if !strings.Contains(svc, "--config <finch.yml>") || strings.Contains(svc, "finch add`") {
		t.Fatalf("service -h:\n%s", svc)
	}
	// run hides the single-service flags kept for `finch join` machines.
	run, _, _ := finch(t, "help", "run")
	if !strings.Contains(run, "--config") || strings.Contains(run, "--ticket") || strings.Contains(run, "--upstream") {
		t.Fatalf("run help:\n%s", run)
	}
	adv, _, code := finch(t, "help", "advanced")
	if code != 0 || !strings.Contains(adv, "approve") || !strings.Contains(adv, "revoke-tokens") {
		t.Fatalf("help advanced: exit=%d\n%s", code, adv)
	}
	_, stderr, code := finch(t, "help", "frobnicate", "--json")
	if code != 2 || decodeJSONError(t, stderr).Error.Code != "USAGE" {
		t.Fatalf("help of an unknown command: exit=%d stderr=%q", code, stderr)
	}
	stdout, stderr, code := finch(t, "help", "add", "--json")
	if code != 0 || stderr != "" {
		t.Fatalf("help add --json: exit=%d stderr=%q", code, stderr)
	}
	got := decodeJSONOut(t, stdout)
	flags, _ := got["flags"].([]any)
	names := []string{}
	for _, f := range flags {
		names = append(names, f.(map[string]any)["name"].(string))
	}
	if got["command"] != "add" || !reflect.DeepEqual(names, []string{"config", "forward-all", "public", "service", "json"}) {
		t.Fatalf("help add --json=%v", got)
	}
}

func TestAddForwardAll(t *testing.T) {
	home := isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	cfg := filepath.Join(home, "finch.yml")
	stdout, stderr, code := finch(t, "add", "site", "--service", "http://127.0.0.1:3000", "--forward-all", "--config", cfg, "--json")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	got := decodeJSONOut(t, stdout)
	if got["forward_all"] != true || got["url"] != h.url()+"/site/" {
		t.Fatalf("payload=%v", got)
	}
	c, err := loadConfig(cfg, "host")
	if err != nil || len(c.Ingress) != 1 || !c.Ingress[0].ForwardAll {
		t.Fatalf("finch.yml=%+v err=%v", c, err)
	}
}

// Re-running add for a service this machine publishes changes its local URL in
// place: one service, one rule, no "<name>-2".
func TestAddAgainUpdatesTheService(t *testing.T) {
	home := isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	cfg := filepath.Join(home, "finch.yml")
	if _, stderr, code := finch(t, "add", "notes", "--service", "http://127.0.0.1:8000", "--config", cfg); code != 0 {
		t.Fatalf("first add: %q", stderr)
	}
	stdout, stderr, code := finch(t, "add", "notes", "--service", "http://127.0.0.1:9000", "--forward-all", "--config", cfg, "--json")
	if code != 0 {
		t.Fatalf("second add: exit=%d stderr=%q", code, stderr)
	}
	got := decodeJSONOut(t, stdout)
	if got["updated"] != true || got["app_path"] != "notes" || got["service"] != "http://127.0.0.1:9000" || got["forward_all"] != true || got["url"] != h.url()+"/notes/" {
		t.Fatalf("payload=%v", got)
	}
	h.mu.Lock()
	enrolled := append([]string(nil), h.enrolled...)
	h.mu.Unlock()
	if !reflect.DeepEqual(enrolled, []string{"notes"}) {
		t.Fatalf("enrolled %v, want only the first add", enrolled)
	}
	c, err := loadConfig(cfg, "host")
	if err != nil || len(c.Ingress) != 1 || c.Ingress[0].Service != "http://127.0.0.1:9000" || !c.Ingress[0].ForwardAll {
		t.Fatalf("finch.yml=%+v err=%v", c, err)
	}
	// Human output says what changed.
	stdout, _, code = finch(t, "add", "notes", "--service", "http://127.0.0.1:9100", "--config", cfg)
	if code != 0 || !strings.Contains(stdout, `updated "notes" → http://127.0.0.1:9100 (was http://127.0.0.1:9000)`) {
		t.Fatalf("exit=%d stdout=%q", code, stdout)
	}
}

func TestAddRefusesANameAnotherMachinePublishes(t *testing.T) {
	home := isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	h.set(func(h *fakeHub) { h.services["notes"] = "key"; h.machines["notes"] = 1 })
	_, stderr, code := finch(t, "add", "notes", "--service", "http://127.0.0.1:8000", "--config", filepath.Join(home, "finch.yml"), "--json")
	env := decodeJSONError(t, stderr)
	if code != 2 || env.Error.Code != "USAGE" || !strings.Contains(env.Error.Message, "already exists in your account") || env.Error.Next != "finch fleet" {
		t.Fatalf("exit=%d env=%+v", code, env)
	}
	if len(h.enrolled) != 0 {
		t.Fatalf("enrolled %v", h.enrolled)
	}
}

func TestRmRemovesTheServiceEverywhere(t *testing.T) {
	home := isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	cfg := filepath.Join(home, "finch.yml")
	for _, name := range []string{"notes", "wiki"} {
		if _, stderr, code := finch(t, "add", name, "--service", "http://127.0.0.1:8000", "--config", cfg); code != 0 {
			t.Fatalf("add %s: %q", name, stderr)
		}
	}
	credPath := filepath.Join(home, ".finch", "notes.json")
	if !fileExists(credPath) {
		t.Fatal("add saved no credential")
	}
	stdout, stderr, code := finch(t, "rm", "notes", "--config", cfg, "--json")
	if code != 0 {
		t.Fatalf("rm: exit=%d stderr=%q", code, stderr)
	}
	got := decodeJSONOut(t, stdout)
	if got["removed"] != "notes" || got["account"] != true || got["config_entry"] != true || got["credential"] != credPath {
		t.Fatalf("payload=%v", got)
	}
	if !reflect.DeepEqual(h.released, []string{"notes"}) || fileExists(credPath) {
		t.Fatalf("released=%v credential still there=%v", h.released, fileExists(credPath))
	}
	c, err := loadConfig(cfg, "host")
	if err != nil || len(c.Ingress) != 1 || c.Ingress[0].AppPath != "wiki" {
		t.Fatalf("finch.yml=%+v err=%v", c, err)
	}
	// Adding it again is a fresh service with the same name, not notes-2.
	stdout, _, code = finch(t, "add", "notes", "--service", "http://127.0.0.1:8000", "--config", cfg, "--json")
	if code != 0 || decodeJSONOut(t, stdout)["app_path"] != "notes" {
		t.Fatalf("re-add: exit=%d stdout=%q", code, stdout)
	}
	// Removed from the account elsewhere: rm still cleans up this machine.
	h.set(func(h *fakeHub) { delete(h.services, "wiki") })
	stdout, _, code = finch(t, "rm", "wiki", "--config", cfg, "--json")
	if got := decodeJSONOut(t, stdout); code != 0 || got["account"] != false || got["config_entry"] != true {
		t.Fatalf("rm of a service gone from the account: exit=%d payload=%v", code, got)
	}
	_, stderr, code = finch(t, "rm", "wiki", "--config", cfg, "--json")
	if env := decodeJSONError(t, stderr); code != 1 || env.Error.Code != "NOT_FOUND" {
		t.Fatalf("rm of nothing: exit=%d env=%+v", code, env)
	}
}

// Removing the last service while the background service is installed says
// to remove that too: with nothing to serve, 'finch run' would exit at every
// start and launchd / systemd would keep restarting it.
func TestRmOfTheLastServiceSaysToUninstallTheService(t *testing.T) {
	home := isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	cfg := filepath.Join(home, ".finch", "finch.yml")
	for _, name := range []string{"notes", "wiki"} {
		if _, stderr, code := finch(t, "add", name, "--service", "http://127.0.0.1:8000"); code != 0 {
			t.Fatalf("add %s: %q", name, stderr)
		}
	}
	serviceGOOS = "darwin" // restored by isolate
	if err := os.MkdirAll(filepath.Dir(launchdPlistPath()), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launchdPlistPath(), []byte("<plist/>"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout, _, code := finch(t, "rm", "notes", "--json")
	if got := decodeJSONOut(t, stdout); code != 0 || got["next"] != nil {
		t.Fatalf("rm with a service left: exit=%d payload=%v", code, got)
	}
	stdout, _, code = finch(t, "rm", "wiki", "--config", cfg, "--json")
	if got := decodeJSONOut(t, stdout); code != 0 || got["next"] != "finch service uninstall" || got["restarted"] != false {
		t.Fatalf("rm of the last service: exit=%d payload=%v", code, got)
	}
	// Without a background service there is nothing to say.
	if err := os.Remove(launchdPlistPath()); err != nil {
		t.Fatal(err)
	}
	if _, stderr, code := finch(t, "add", "notes", "--service", "http://127.0.0.1:8000"); code != 0 {
		t.Fatalf("re-add: %q", stderr)
	}
	stdout, _, code = finch(t, "rm", "notes")
	if code != 0 || strings.Contains(stdout, "service uninstall") {
		t.Fatalf("rm without a background service: exit=%d\n%s", code, stdout)
	}
}

// When the hub registered the service but this machine could not join it, a
// plain retry would publish "<name>-2": the error says to remove it first.
func TestAddJoinFailureSaysToRemoveTheService(t *testing.T) {
	isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	h.set(func(h *fakeHub) { h.joinDown = true })
	_, stderr, code := finch(t, "add", "notes", "--service", "http://127.0.0.1:8000", "--json")
	env := decodeJSONError(t, stderr)
	if code != 1 || env.Error.Code != "UPSTREAM" || env.Error.Next != "finch rm notes" ||
		!strings.Contains(env.Error.Message, "could not join it") || !strings.Contains(env.Error.Message, "finch add notes --service http://127.0.0.1:8000") {
		t.Fatalf("exit=%d env=%+v", code, env)
	}
	// Following that next step clears the way for the same name.
	h.set(func(h *fakeHub) { h.joinDown = false })
	if _, stderr, code := finch(t, "rm", "notes", "--json"); code != 0 {
		t.Fatalf("rm: exit=%d stderr=%q", code, stderr)
	}
	stdout, _, code := finch(t, "add", "notes", "--service", "http://127.0.0.1:8000", "--json")
	if code != 0 || decodeJSONOut(t, stdout)["app_path"] != "notes" {
		t.Fatalf("retry: exit=%d stdout=%q", code, stdout)
	}
}

func TestLogs(t *testing.T) {
	isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	ts := time.Date(2026, 9, 27, 11, 44, 37, 0, time.UTC).UnixMilli()
	h.set(func(h *fakeHub) {
		h.services["notes"] = "key"
		h.calls["notes"] = []map[string]any{
			{"ts": ts, "ago": "1m", "route": "/notes/mcp", "caller": "claude-code on mac", "status": 200, "ms": 12},
			{"ts": ts - 1000, "ago": "1m", "route": "/notes/mcp", "caller": "anonymous", "status": 401, "ms": 1},
		}
	})
	want := []any{
		map[string]any{"time": "2026-09-27T11:44:37Z", "route": "/notes/mcp", "caller": "claude-code on mac", "status": float64(200), "ms": float64(12)},
	}
	for _, legacy := range []bool{false, true} {
		h.set(func(h *fakeHub) { h.legacyLogs = legacy })
		stdout, stderr, code := finch(t, "logs", "notes", "--limit", "1", "--json")
		if code != 0 {
			t.Fatalf("legacy=%v: exit=%d stderr=%q", legacy, code, stderr)
		}
		if got := decodeJSONOut(t, stdout); got["service"] != "notes" || !reflect.DeepEqual(got["calls"], want) {
			t.Fatalf("legacy=%v: payload=%v", legacy, got)
		}
	}
	stdout, _, code := finch(t, "logs", "notes")
	if code != 0 || !strings.Contains(stdout, "STATUS") || !strings.Contains(stdout, "claude-code on mac") || !strings.Contains(stdout, "401") {
		t.Fatalf("text logs: exit=%d\n%s", code, stdout)
	}
	for _, legacy := range []bool{false, true} {
		h.set(func(h *fakeHub) { h.legacyLogs = legacy })
		_, stderr, code := finch(t, "logs", "ghost", "--json")
		if env := decodeJSONError(t, stderr); code != 1 || env.Error.Code != "NOT_FOUND" || env.Error.Next != "finch fleet" {
			t.Fatalf("legacy=%v unknown service: exit=%d env=%+v", legacy, code, env)
		}
	}
}

func TestFleetAndStatusShowURLs(t *testing.T) {
	home := isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	if _, stderr, code := finch(t, "add", "notes", "--service", "http://127.0.0.1:8000"); code != 0 {
		t.Fatalf("add: %q", stderr)
	}
	stdout, _, code := finch(t, "fleet", "--json")
	services, _ := decodeJSONOut(t, stdout)["services"].([]any)
	if code != 0 || len(services) != 1 || services[0].(map[string]any)["url"] != h.url()+"/notes/mcp" {
		t.Fatalf("fleet: exit=%d services=%v", code, services)
	}
	if stdout, _, _ := finch(t, "fleet"); !strings.Contains(stdout, h.url()+"/notes/mcp") {
		t.Fatalf("fleet text lacks the URL: %q", stdout)
	}
	stdout, _, code = finch(t, "status", "--json")
	got := decodeJSONOut(t, stdout)
	ingress, _ := got["ingress"].([]any)
	if code != 0 || got["logged_in"] != true || got["loggedIn"] != true || len(ingress) != 1 ||
		ingress[0].(map[string]any)["url"] != h.url()+"/notes/mcp" || got["config"] != filepath.Join(home, ".finch", "finch.yml") {
		t.Fatalf("status: exit=%d payload=%v", code, got)
	}
	if stdout, _, _ := finch(t, "status"); !strings.Contains(stdout, h.url()+"/notes/mcp") || strings.Contains(stdout, "user_1") {
		t.Fatalf("status text: %q", stdout)
	}
}

func TestStatusTellsAPersonToLogIn(t *testing.T) {
	isolate(t)
	stdout, _, _ := finch(t, "status")
	if !strings.Contains(stdout, "not logged in — run 'finch login'\n") {
		t.Fatalf("status: %q", stdout)
	}
	out, _, _ := finch(t, "status", "--json")
	if got := decodeJSONOut(t, out); got["logged_in"] != false || got["loggedIn"] != false {
		t.Fatalf("status --json=%v", got)
	}
}

func TestNothingToServeIsAPlainNextStep(t *testing.T) {
	isolate(t)
	e := nothingToServe()
	if e.Code != codeNotFound || e.Next != "finch login --start" || strings.Contains(e.Message, "agent.json") || strings.Contains(e.Message, "app_path") {
		t.Fatalf("not logged in: %+v", e)
	}
	var out, errOut strings.Builder
	(&cli{stdout: &out, stderr: &errOut}).finish(e)
	if !strings.HasPrefix(errOut.String(), "finch: nothing to serve yet") || !strings.Contains(errOut.String(), "next: finch login\n") {
		t.Fatalf("printed %q", errOut.String())
	}
	h := newFakeHub(t)
	loginTo(t, h)
	if e := nothingToServe(); e.Next != "finch add <name> --service <url>" {
		t.Fatalf("logged in: %+v", e)
	}
}

func TestUpdateChecksBeforeDownloading(t *testing.T) {
	isolate(t)
	var latest string
	versionStatus, downloads := 200, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/cli/version" && versionStatus == 200:
			_ = json.NewEncoder(w).Encode(map[string]string{"latest": latest})
		case r.URL.Path == "/api/cli/version" || r.URL.Path == "/api/version":
			w.WriteHeader(versionStatus)
		case strings.HasPrefix(r.URL.Path, "/releases/"):
			downloads++
			http.Error(w, "no", http.StatusNotFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	latest = agentVersion
	stdout, stderr, code := finch(t, "update", "--hub", srv.URL, "--restart", "none")
	if code != 0 || stdout != "finch "+agentVersion+" is already the latest\n" || downloads != 0 {
		t.Fatalf("current: exit=%d stdout=%q stderr=%q downloads=%d", code, stdout, stderr, downloads)
	}
	// A check that fails is reported; it never turns into a reinstall.
	versionStatus = 500
	_, stderr, code = finch(t, "update", "--hub", srv.URL, "--restart", "none", "--json")
	if env := decodeJSONError(t, stderr); code != 1 || env.Error.Code != "UPSTREAM" || env.Error.Next != "finch update --force" || downloads != 0 {
		t.Fatalf("failed check: exit=%d env=%+v downloads=%d", code, env, downloads)
	}
	// --force downloads without asking.
	_, _, _ = finch(t, "update", "--hub", srv.URL, "--restart", "none", "--force")
	if downloads != 1 {
		t.Fatalf("--force downloads=%d", downloads)
	}
}

// A local service that is down is reported to the hub without the local URL or
// the dial error: for a public service, the caller is anyone.
func TestForwardHidesTheLocalURLWhenTheServiceIsDown(t *testing.T) {
	upstream := mustParse(t, "http://127.0.0.1:1/mcp")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cw := &collectingWriter{}
	forward(ctx, upstream, frame{ID: "down", Type: "req", Method: "POST", Path: "/mcp", Body: "{}"}, cw.write, nil, false)
	frames := cw.snapshot()
	if len(frames) != 1 || frames[0].Status != 502 || frames[0].Message != upstreamUnreachableMessage {
		t.Fatalf("frames=%+v", frames)
	}
	if strings.Contains(frames[0].Message, "127.0.0.1") || strings.Contains(frames[0].Message, "dial") {
		t.Fatalf("err frame leaks the local URL: %q", frames[0].Message)
	}
}

func TestGuideIsAgentsMD(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "web", "public", "agents.md"))
	if err != nil {
		t.Skip("web/public not present (agent built outside the monorepo)")
	}
	if guideText != string(b) {
		t.Fatal("agent/core/agents.md differs from web/public/agents.md: copy web/public/agents.md over it")
	}
	if strings.Contains(guideText, "does not do yet") || strings.Contains(guideText, "cannot check") {
		t.Fatal("the guide still documents the retired finch test limitation")
	}
}

// uninstall revokes the keys connect made here, takes out the client entries
// it wrote (and nothing else), deletes ~/.finch, and leaves the binary.
func TestUninstall(t *testing.T) {
	home, h := connectFixture(t)
	for _, dir := range []string{".cursor", ".codex"} {
		if err := os.MkdirAll(filepath.Join(home, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cursorCfg := filepath.Join(home, ".cursor", "mcp.json")
	if err := os.WriteFile(cursorCfg, []byte(`{"mcpServers":{"other":{"command":"npx"}},"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	codexCfg := filepath.Join(home, ".codex", "config.toml")
	if err := os.WriteFile(codexCfg, []byte("model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"npx\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, client := range []string{"cursor", "codex"} {
		if _, stderr, code := finch(t, "connect", "notes", "--client", client); code != 0 {
			t.Fatalf("connect %s: %q", client, stderr)
		}
	}
	// A key someone minted by hand is not this machine's connect key, and
	// neither is one another machine with the same hostname made with
	// connect: it carries the very same "cursor on <host>" label.
	host, _ := os.Hostname()
	for _, label := range []string{"ci-bot", "cursor on " + host} {
		if _, stderr, code := finch(t, "keys", "mint", label, "--service", "notes"); code != 0 {
			t.Fatalf("mint %s: %q", label, stderr)
		}
	}
	if !fileExists(filepath.Join(home, ".finch", "connections.json")) {
		t.Fatal("connect kept no record of what it wired")
	}

	stdout, stderr, code := finch(t, "uninstall", "--json")
	if code != 0 {
		t.Fatalf("uninstall: exit=%d stderr=%q", code, stderr)
	}
	got := decodeJSONOut(t, stdout)
	if !reflect.DeepEqual(got["revoked_key_ids"], []any{"k_1", "k_2"}) || !reflect.DeepEqual(got["candidate_key_ids"], []any{}) {
		t.Fatalf("revoked=%v candidates=%v", got["revoked_key_ids"], got["candidate_key_ids"])
	}
	h.mu.Lock()
	_, handMinted := h.keys["k_3"]
	_, twinMachine := h.keys["k_4"]
	h.mu.Unlock()
	if !handMinted || !twinMachine {
		t.Fatalf("uninstall revoked a key connect did not create here: k_3 kept=%v k_4 kept=%v", handMinted, twinMachine)
	}
	if fileExists(filepath.Join(home, ".finch")) {
		t.Fatal("~/.finch is still there")
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(mustRead(t, cursorCfg)), &doc); err != nil {
		t.Fatal(err)
	}
	if want := map[string]any{"other": map[string]any{"command": "npx"}}; !reflect.DeepEqual(doc["mcpServers"], want) || doc["theme"] != "dark" {
		t.Fatalf("cursor config=%v", doc)
	}
	if codex := mustRead(t, codexCfg); strings.Contains(codex, "notes") || strings.Contains(codex, "finch_") || !strings.Contains(codex, "[mcp_servers.other]") {
		t.Fatalf("codex config=%q", codex)
	}
	exe, _ := os.Executable()
	if bin, _ := got["binary"].(string); bin == "" || !strings.HasPrefix(got["remove_binary"].(string), "rm ") || !fileExists(exe) {
		t.Fatalf("binary=%v remove=%v", got["binary"], got["remove_binary"])
	}
	// Running it again finds nothing left to do.
	stdout, _, code = finch(t, "uninstall")
	if code != 0 || !strings.Contains(stdout, "nothing to remove") || !strings.Contains(stdout, "finch binary is still at") {
		t.Fatalf("second uninstall: exit=%d\n%s", code, stdout)
	}
	// Its JSON list fields are arrays even when empty, never null.
	stdout, _, code = finch(t, "uninstall", "--json")
	got = decodeJSONOut(t, stdout)
	for _, field := range []string{"client_entries_removed", "deleted", "revoked_key_ids", "candidate_key_ids", "warnings"} {
		if _, ok := got[field].([]any); code != 0 || !ok {
			t.Fatalf("empty uninstall: exit=%d %s=%v", code, field, got[field])
		}
	}
}

// A machine set up before finch 1.8 has no record of the keys its connects
// made. Labels are not proof (hostnames repeat), so uninstall revokes none of
// them: it lists the ones with this machine's connect labels for the person.
func TestUninstallWithoutALedgerRevokesNothing(t *testing.T) {
	_, h := connectFixture(t)
	host, _ := os.Hostname()
	for _, label := range []string{"cursor on " + host, "ci-bot"} {
		if _, stderr, code := finch(t, "keys", "mint", label, "--service", "notes"); code != 0 {
			t.Fatalf("mint %s: %q", label, stderr)
		}
	}
	stdout, stderr, code := finch(t, "uninstall", "--json")
	if code != 0 {
		t.Fatalf("uninstall: exit=%d stderr=%q", code, stderr)
	}
	got := decodeJSONOut(t, stdout)
	want := "k_1 (cursor on " + host + ")"
	if !reflect.DeepEqual(got["revoked_key_ids"], []any{}) || !reflect.DeepEqual(got["candidate_key_ids"], []any{want}) {
		t.Fatalf("revoked=%v candidates=%v", got["revoked_key_ids"], got["candidate_key_ids"])
	}
	h.mu.Lock()
	kept, revoked := len(h.keys), append([]string(nil), h.revoked...)
	h.mu.Unlock()
	if kept != 2 || len(revoked) != 0 {
		t.Fatalf("keys left=%d revoked=%v", kept, revoked)
	}
	warnings, _ := got["warnings"].([]any)
	found := false
	for _, w := range warnings {
		if s, _ := w.(string); strings.Contains(s, want) && strings.Contains(s, "none were revoked") && strings.Contains(s, "finch keys revoke <id>") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no warning names the candidate: %v", warnings)
	}
}

// uninstall reads the current directory's finch.yml too, but deletes a file
// it names only if that file is a finch credential.
func TestUninstallDeletesOnlyFinchCredentials(t *testing.T) {
	home := isolate(t)
	project := filepath.Join(home, "project")
	if err := os.MkdirAll(project, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Chdir(project)
	manifest := "hub: https://finchmcp.com\nbox: testbox\ncredentials-dir: .\ningress:\n" +
		"  - app_path: package\n    service: http://127.0.0.1:8000\n" +
		"  - app_path: notes\n    service: http://127.0.0.1:8001\n"
	if err := os.WriteFile(filepath.Join(project, "finch.yml"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	pkg := filepath.Join(project, "package.json")
	if err := os.WriteFile(pkg, []byte(`{"name":"my-app"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cred := filepath.Join(project, "notes.json")
	if err := writeCredentialFile(cred, []byte(`{"hub":"https://finchmcp.com","service":"notes","box":"testbox","refreshToken":"rt_notes"}`)); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := finch(t, "uninstall", "--json")
	if code != 0 {
		t.Fatalf("uninstall: exit=%d stderr=%q", code, stderr)
	}
	got := decodeJSONOut(t, stdout)
	if !fileExists(pkg) {
		t.Fatal("uninstall deleted package.json")
	}
	if fileExists(cred) {
		t.Fatal("uninstall left the finch credential notes.json")
	}
	deleted, _ := got["deleted"].([]any)
	if len(deleted) != 1 || deleted[0] != cred {
		t.Fatalf("deleted=%v", deleted)
	}
	warnings, _ := got["warnings"].([]any)
	found := false
	for _, w := range warnings {
		if s, _ := w.(string); strings.Contains(s, pkg) && strings.Contains(s, "left in place") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no warning for %s: %v", pkg, warnings)
	}
}

// A usage mistake in add explains the rule and the fix.
func TestAddErrorsSayHowToFixThem(t *testing.T) {
	isolate(t)
	for _, tc := range []struct {
		args        []string
		wantMessage string
	}{
		{[]string{"add", "notes", "--service", "localhost:8000"}, "--service needs a full URL — did you mean http://localhost:8000?"},
		{[]string{"add", "Bad Name!", "--service", "http://127.0.0.1:8000"}, "use letters, digits and '-'"},
	} {
		_, stderr, code := finch(t, append(tc.args, "--json")...)
		if env := decodeJSONError(t, stderr); code != 2 || !strings.Contains(env.Error.Message, tc.wantMessage) {
			t.Fatalf("%v: exit=%d env=%+v", tc.args, code, env)
		}
	}
	if got := slugifyServiceName("My_Notes v2"); got != "my-notes-v2" {
		t.Fatalf("slugify=%q", got)
	}
}

// #50: a Codex config may spell the table ["mcp_servers"]; an inline entry
// there must be seen, or merging would declare the same key twice.
func TestCodexQuotedServersTable(t *testing.T) {
	for _, text := range []string{
		"[\"mcp_servers\"]\nnotes = { url = \"https://x.example/notes/mcp\" }\n",
		"['mcp_servers']\nnotes = { url = \"https://x.example/notes/mcp\" }\n",
		"\"mcp_servers\".notes.url = \"https://x.example/notes/mcp\"\n",
	} {
		if !codexDefinesInline(text, "notes") {
			t.Errorf("inline definition not recognized in %q", text)
		}
	}
	for _, header := range []string{`["mcp_servers".notes]`, `['mcp_servers'."notes"]`, `[mcp_servers.notes.env]`} {
		if !codexServerHeader("notes").MatchString(header) {
			t.Errorf("header %s not recognized", header)
		}
	}
	merged, err := mergeCodexConfig("[\"mcp_servers\".notes]\nurl = \"stale\"\n", "notes", "https://x.example/notes/mcp", "")
	if err != nil || strings.Contains(merged, "stale") || strings.Count(merged, "notes]") != 1 {
		t.Fatalf("merge=%q err=%v", merged, err)
	}
}

// #50: `finch <cmd> -h --json` is the JSON help payload, not prose.
func TestSubcommandHelpJSON(t *testing.T) {
	isolate(t)
	for _, args := range [][]string{{"add", "-h", "--json"}, {"logs", "--json", "--help"}, {"version", "-h", "--json"}} {
		stdout, stderr, code := finch(t, args...)
		if code != 0 || stderr != "" {
			t.Fatalf("%v: exit=%d stderr=%q", args, code, stderr)
		}
		if got := decodeJSONOut(t, stdout); got["command"] != args[0] || got["text"] == "" {
			t.Fatalf("%v: payload=%v", args, got)
		}
	}
}
