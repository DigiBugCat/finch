package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func connectFixture(t *testing.T) (string, *fakeHub) {
	t.Helper()
	home := isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	h.set(func(h *fakeHub) { h.services["notes"] = "key" })
	return home, h
}

func TestConnectJSONPrintsSnippet(t *testing.T) {
	_, h := connectFixture(t)
	stdout, stderr, code := finch(t, "connect", "notes", "--client", "json")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	var snippet map[string]any
	if err := json.Unmarshal([]byte(stdout), &snippet); err != nil {
		t.Fatalf("not JSON: %q", stdout)
	}
	want := map[string]any{"mcpServers": map[string]any{"notes": map[string]any{
		"type":    "http",
		"url":     h.url() + "/notes/mcp",
		"headers": map[string]any{"Authorization": "Bearer finch_secret1"},
	}}}
	if !reflect.DeepEqual(snippet, want) {
		t.Fatalf("snippet=%v, want %v", snippet, want)
	}
	host, _ := os.Hostname()
	if h.keys["k_1"] != "json on "+host {
		t.Fatalf("key label=%q", h.keys["k_1"])
	}

	stdout, _, code = finch(t, "connect", "notes", "--client", "json", "--json")
	got := decodeJSONOut(t, stdout)
	if code != 0 || got["key_id"] != "k_2" || got["mcpServers"] == nil || got["url"] != h.url()+"/notes/mcp" {
		t.Fatalf("--json payload=%v", got)
	}
}

func TestConnectCursorMergesConfig(t *testing.T) {
	home, h := connectFixture(t)
	dir := filepath.Join(home, ".cursor")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(dir, "mcp.json")
	existing := `{"mcpServers":{"other":{"command":"npx","args":["x"]},"notes":{"url":"stale"}},"theme":"dark"}`
	if err := os.WriteFile(cfg, []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := finch(t, "connect", "notes", "--client", "cursor", "--json")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if strings.Contains(stdout+stderr, "finch_secret") {
		t.Fatal("connect printed the key")
	}
	if got := decodeJSONOut(t, stdout); got["config"] != cfg || got["key_id"] != "k_1" {
		t.Fatalf("payload=%v", got)
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(mustRead(t, cfg)), &doc); err != nil {
		t.Fatal(err)
	}
	servers := doc["mcpServers"].(map[string]any)
	want := map[string]any{"url": h.url() + "/notes/mcp", "headers": map[string]any{"Authorization": "Bearer finch_secret1"}}
	if !reflect.DeepEqual(servers["notes"], want) {
		t.Fatalf("notes entry=%v, want %v", servers["notes"], want)
	}
	if !reflect.DeepEqual(servers["other"], map[string]any{"command": "npx", "args": []any{"x"}}) || doc["theme"] != "dark" {
		t.Fatalf("unrelated config was not preserved: %v", doc)
	}
	if got := fileMode(t, cfg); got != 0o600 {
		t.Fatalf("mcp.json holds a key; mode=%04o, want 0600", got)
	}
}

func TestConnectCodexMergesConfig(t *testing.T) {
	home, h := connectFixture(t)
	dir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(dir, "config.toml")
	existing := `# my codex config
model = "gpt-5"

[mcp_servers.other]
command = "npx"

[mcp_servers.notes]
url = "https://stale.example/notes/mcp"

[mcp_servers.notes.env]
TOKEN = "stale"

[profiles.fast]
model = "gpt-5-mini"
`
	if err := os.WriteFile(cfg, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ { // re-running replaces the entry instead of duplicating it
		stdout, stderr, code := finch(t, "connect", "notes", "--client", "codex")
		if code != 0 || strings.Contains(stdout+stderr, "finch_secret") {
			t.Fatalf("run %d: exit=%d stdout=%q stderr=%q", i+1, code, stdout, stderr)
		}
	}
	got := mustRead(t, cfg)
	for _, want := range []string{"# my codex config", `model = "gpt-5"`, "[mcp_servers.other]", "[profiles.fast]", `model = "gpt-5-mini"`} {
		if !strings.Contains(got, want) {
			t.Fatalf("lost %q:\n%s", want, got)
		}
	}
	for _, gone := range []string{"stale", "[mcp_servers.notes.env]"} {
		if strings.Contains(got, gone) {
			t.Fatalf("old entry %q survived:\n%s", gone, got)
		}
	}
	wantBlock := "[mcp_servers.notes]\nurl = \"" + h.url() + "/notes/mcp\"\nhttp_headers = { \"Authorization\" = \"Bearer finch_secret2\" }\n"
	if strings.Count(got, "[mcp_servers.notes]") != 1 || !strings.Contains(got, wantBlock) {
		t.Fatalf("codex entry wrong:\n%s", got)
	}
	if strings.Count(got, "# Managed by 'finch connect notes") != 1 {
		t.Fatalf("marker comment duplicated:\n%s", got)
	}
}

// Re-running connect for cursor/codex overwrites the entry, so the key the old
// entry carried must be revoked — but only that key: not the new one, not a
// key for another service with the same client label, and not a key the old
// entry did not carry.
func TestConnectRevokesTheKeyItReplaces(t *testing.T) {
	for _, client := range []string{"cursor", "codex"} {
		t.Run(client, func(t *testing.T) {
			home, h := connectFixture(t)
			h.set(func(h *fakeHub) { h.services["api"] = "key" })
			if err := os.MkdirAll(filepath.Join(home, "."+client), 0o700); err != nil {
				t.Fatal(err)
			}
			// k_1: notes, k_2: api (same label, other service).
			for _, svc := range []string{"notes", "api"} {
				if _, stderr, code := finch(t, "connect", svc, "--client", client, "--json"); code != 0 {
					t.Fatalf("connect %s: exit=%d stderr=%q", svc, code, stderr)
				}
			}
			// A manually minted key for notes with a different label (k_3).
			if _, stderr, code := finch(t, "keys", "mint", "laptop", "--service", "notes", "--json"); code != 0 {
				t.Fatalf("keys mint: exit=%d stderr=%q", code, stderr)
			}
			stdout, stderr, code := finch(t, "connect", "notes", "--client", client, "--json")
			if code != 0 {
				t.Fatalf("reconnect: exit=%d stderr=%q", code, stderr)
			}
			got := decodeJSONOut(t, stdout)
			if got["key_id"] != "k_4" || !reflect.DeepEqual(got["revoked_key_ids"], []any{"k_1"}) {
				t.Fatalf("payload=%v", got)
			}
			if !reflect.DeepEqual(h.revoked, []string{"k_1"}) {
				t.Fatalf("revoked=%v, want only the replaced notes key", h.revoked)
			}
			for _, live := range []string{"k_2", "k_3", "k_4"} {
				if _, ok := h.keys[live]; !ok {
					t.Fatalf("%s was revoked; keys=%v", live, h.keys)
				}
			}
		})
	}
}

// A dotfile manager's symlinked mcp.json must stay a symlink, with the new
// entry written into its target.
func TestConnectCursorWritesThroughSymlink(t *testing.T) {
	home, _ := connectFixture(t)
	dir := filepath.Join(home, ".cursor")
	dotfiles := filepath.Join(home, "dotfiles")
	for _, d := range []string{dir, dotfiles} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	dotTarget := filepath.Join(dotfiles, "mcp.json")
	if err := os.WriteFile(dotTarget, []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "mcp.json")
	if err := os.Symlink(dotTarget, link); err != nil {
		t.Fatal(err)
	}
	if _, stderr, code := finch(t, "connect", "notes", "--client", "cursor", "--json"); code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if st, err := os.Lstat(link); err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("%s is no longer a symlink (err %v)", link, err)
	}
	got := mustRead(t, dotTarget)
	if !strings.Contains(got, `"notes"`) || !strings.Contains(got, `"theme": "dark"`) {
		t.Fatalf("the symlink target was not updated:\n%s", got)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("stray files next to the link: %v", entries)
	}

	// A dangling link is refused (and the minted key revoked), not replaced.
	if err := os.Remove(dotTarget); err != nil {
		t.Fatal(err)
	}
	_, stderr, code := finch(t, "connect", "notes", "--client", "cursor", "--json")
	if code != 1 || !strings.Contains(decodeJSONError(t, stderr).Error.Message, "symlink") {
		t.Fatalf("dangling link: exit=%d stderr=%q", code, stderr)
	}
	if st, err := os.Lstat(link); err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("dangling link was replaced (err %v)", err)
	}
}

// claude-code entries are per project and json snippets go who knows where,
// so neither revokes anything.
func TestConnectJSONRevokesNothing(t *testing.T) {
	_, h := connectFixture(t)
	for i := 0; i < 2; i++ {
		if _, stderr, code := finch(t, "connect", "notes", "--client", "json", "--json"); code != 0 {
			t.Fatalf("exit=%d stderr=%q", code, stderr)
		}
	}
	if len(h.revoked) != 0 || len(h.keys) != 2 {
		t.Fatalf("revoked=%v keys=%v", h.revoked, h.keys)
	}
}

func TestMergeCodexConfigQuotedHeaderAndInline(t *testing.T) {
	out, err := mergeCodexConfig("[mcp_servers.\"notes\"] # old\nurl = \"x\"\n", "notes", "https://a/notes/mcp", "")
	if err != nil || strings.Contains(out, `url = "x"`) || strings.Contains(out, "http_headers") {
		t.Fatalf("quoted header not replaced / public entry has headers: %q %v", out, err)
	}
	if !codexDefinesInline("[mcp_servers]\nnotes = { url = \"x\" }\n", "notes") || !codexDefinesInline("mcp_servers = { notes = {} }\n", "notes") {
		t.Fatal("inline definitions must be detected")
	}
	if codexDefinesInline("[mcp_servers.notes]\nurl = \"x\"\n[other]\nnotes = 1\n", "notes") {
		t.Fatal("a table header is not an inline definition")
	}
	if _, err := mergeCodexConfig("", "notes", "https://a/\n", "k"); err == nil {
		t.Fatal("control characters must be rejected")
	}
}

// writeFakeClaude puts a strict fake `claude` on PATH: it accepts only the
// exact `claude mcp add --transport http <name> <url> --header "Authorization:
// Bearer finch_…"` shape and records its argv.
func writeFakeClaude(t *testing.T, exitCode string) string {
	t.Helper()
	bin := t.TempDir()
	log := filepath.Join(bin, "argv.log")
	script := `#!/bin/sh
if [ "$#" -ne 8 ] || [ "$1" != mcp ] || [ "$2" != add ] || [ "$3" != --transport ] || [ "$4" != http ] || [ "$7" != --header ]; then
  echo "fake claude: unexpected argv: $*" >&2; exit 64
fi
case "$8" in "Authorization: Bearer finch_"*) ;; *) echo "fake claude: bad header" >&2; exit 64 ;; esac
case "$6" in http://*/"$5"/mcp|https://*/"$5"/mcp) ;; *) echo "fake claude: bad url $6" >&2; exit 64 ;; esac
for a in "$@"; do printf '%s\n' "$a"; done > "` + log + `"
if [ "` + exitCode + `" != 0 ]; then echo "MCP server $5 already exists (header $8)" >&2; exit ` + exitCode + `; fi
echo "Added HTTP MCP server $5"
`
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	return log
}

func TestConnectClaudeCode(t *testing.T) {
	_, h := connectFixture(t)
	log := writeFakeClaude(t, "0")
	stdout, stderr, code := finch(t, "connect", "notes", "--client", "claude-code", "--json")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if strings.Contains(stdout+stderr, "finch_secret") {
		t.Fatal("connect printed the key")
	}
	argv := strings.Split(strings.TrimSpace(mustRead(t, log)), "\n")
	want := []string{"mcp", "add", "--transport", "http", "notes", h.url() + "/notes/mcp", "--header", "Authorization: Bearer finch_secret1"}
	if !reflect.DeepEqual(argv, want) {
		t.Fatalf("claude argv=%q, want %q", argv, want)
	}
	if got := decodeJSONOut(t, stdout); got["client"] != "claude-code" || got["key_id"] != "k_1" {
		t.Fatalf("payload=%v", got)
	}
}

func TestConnectClaudeCodeFailureRevokesKey(t *testing.T) {
	_, h := connectFixture(t)
	writeFakeClaude(t, "1")
	_, stderr, code := finch(t, "connect", "notes", "--client", "claude-code", "--json")
	env := decodeJSONError(t, stderr)
	if code != 1 || env.Error.Code != "UPSTREAM" || !strings.HasPrefix(env.Error.Next, "claude mcp remove notes") {
		t.Fatalf("exit=%d env=%+v", code, env)
	}
	if strings.Contains(stderr, "finch_secret") {
		t.Fatalf("the error leaked the key: %q", stderr)
	}
	if !reflect.DeepEqual(h.revoked, []string{"k_1"}) || len(h.keys) != 0 {
		t.Fatalf("the orphan key was not revoked: revoked=%v keys=%v", h.revoked, h.keys)
	}
}

// A missing or unusable client is detected before any key is minted.
func TestConnectPreflightMintsNothing(t *testing.T) {
	for _, tc := range []struct {
		name     string
		client   string
		prepare  func(t *testing.T, home string)
		wantCode string
	}{
		{name: "claude not on PATH", client: "claude-code", prepare: func(t *testing.T, home string) { t.Setenv("PATH", t.TempDir()) }, wantCode: "NOT_FOUND"},
		{name: "no ~/.cursor", client: "cursor", wantCode: "NOT_FOUND"},
		{name: "no ~/.codex", client: "codex", wantCode: "NOT_FOUND"},
		{
			name: "broken mcp.json", client: "cursor",
			prepare: func(t *testing.T, home string) {
				_ = os.MkdirAll(filepath.Join(home, ".cursor"), 0o755)
				_ = os.WriteFile(filepath.Join(home, ".cursor", "mcp.json"), []byte("{not json"), 0o600)
			},
			wantCode: "INTERNAL",
		},
		{
			name: "inline codex entry", client: "codex",
			prepare: func(t *testing.T, home string) {
				_ = os.MkdirAll(filepath.Join(home, ".codex"), 0o700)
				_ = os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte("[mcp_servers]\nnotes = { url = \"x\" }\n"), 0o600)
			},
			wantCode: "INTERNAL",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home, h := connectFixture(t)
			if tc.prepare != nil {
				tc.prepare(t, home)
			}
			_, stderr, code := finch(t, "connect", "notes", "--client", tc.client, "--json")
			env := decodeJSONError(t, stderr)
			if code != 1 || env.Error.Code != tc.wantCode || env.Error.Next != "finch connect notes --client json" {
				t.Fatalf("exit=%d env=%+v", code, env)
			}
			if h.nextKey != 0 {
				t.Fatal("a key was minted for a client that cannot use it")
			}
		})
	}
	// The broken file is left exactly as it was.
	home, _ := connectFixture(t)
	_ = os.MkdirAll(filepath.Join(home, ".cursor"), 0o755)
	cfg := filepath.Join(home, ".cursor", "mcp.json")
	_ = os.WriteFile(cfg, []byte("{not json"), 0o600)
	finch(t, "connect", "notes", "--client", "cursor")
	if mustRead(t, cfg) != "{not json" {
		t.Fatal("a broken mcp.json was overwritten")
	}
}

func TestConnectPublicServiceNeedsNoKey(t *testing.T) {
	_, h := connectFixture(t)
	h.set(func(h *fakeHub) { h.services["notes"] = "public" })
	stdout, _, code := finch(t, "connect", "notes", "--client", "json")
	if code != 0 || strings.Contains(stdout, "headers") || h.nextKey != 0 {
		t.Fatalf("exit=%d stdout=%q minted=%d", code, stdout, h.nextKey)
	}
}

func TestServiceMCPURL(t *testing.T) {
	for _, tc := range []struct{ hub, host, want string }{
		{"https://finchmcp.com", "brave-finch-12.finchmcp.com", "https://brave-finch-12.finchmcp.com/notes/mcp"},
		{"https://finchmcp.com", "", "https://finchmcp.com/notes/mcp"},
		{"http://127.0.0.1:8787", "brave-finch-12.finchmcp.com", "http://127.0.0.1:8787/notes/mcp"},
	} {
		if got := serviceMCPURL(tc.hub, tc.host, "notes"); got != tc.want {
			t.Errorf("serviceMCPURL(%q,%q)=%q, want %q", tc.hub, tc.host, got, tc.want)
		}
	}
}
