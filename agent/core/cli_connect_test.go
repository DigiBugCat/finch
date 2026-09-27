package core

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
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

// A rotation whose revoke fails is reported, not swallowed: the new entry is in
// place, but the replaced key is still live and nothing references it any more,
// so connect exits 1 INTERNAL and names the key to revoke.
func TestConnectReportsAKeyItCouldNotRevoke(t *testing.T) {
	home, h := connectFixture(t)
	if err := os.MkdirAll(filepath.Join(home, ".cursor"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, stderr, code := finch(t, "connect", "notes", "--client", "cursor", "--json"); code != 0 { // k_1
		t.Fatalf("connect: exit=%d stderr=%q", code, stderr)
	}
	h.set(func(h *fakeHub) { h.revokeDown = true })
	stdout, stderr, code := finch(t, "connect", "notes", "--client", "cursor", "--json") // k_2
	env := decodeJSONError(t, stderr)
	if code != 1 || stdout != "" || env.Error.Code != "INTERNAL" || env.Error.Next != "finch keys revoke k_1" ||
		!strings.Contains(env.Error.Message, "k_1 is still active") || !strings.Contains(env.Error.Message, "finch keys list") {
		t.Fatalf("exit=%d stdout=%q env=%+v", code, stdout, env)
	}
	if strings.Contains(stderr, "finch_secret") {
		t.Fatalf("a key leaked: %q", stderr)
	}
	if _, ok := h.keys["k_1"]; !ok || len(h.revoked) != 0 {
		t.Fatalf("keys=%v revoked=%v", h.keys, h.revoked)
	}
	// The client already uses the new key.
	if cfg := mustRead(t, filepath.Join(home, ".cursor", "mcp.json")); !strings.Contains(cfg, "finch_secret2") {
		t.Fatalf("cursor config=%q", cfg)
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

// json snippets go who knows where, so --client json never revokes anything.
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

// A service id may contain '.', and a bare dotted TOML key is a key path:
// [mcp_servers.foo.bar] is server "foo" with a sub-table "bar". The name must
// be written, matched and replaced as one quoted key.
func TestConnectCodexQuotesDottedNames(t *testing.T) {
	home, h := connectFixture(t)
	h.set(func(h *fakeHub) { h.services["foo.bar"] = "key" })
	dir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(dir, "config.toml")
	// Server "foo" with a sub-table "bar": not ours, and must survive.
	existing := "[mcp_servers.foo]\ncommand = \"foo-server\"\n\n[mcp_servers.foo.bar]\nx = 1\n"
	if err := os.WriteFile(cfg, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2; i++ {
		stdout, stderr, code := finch(t, "connect", "foo.bar", "--client", "codex", "--json")
		if code != 0 {
			t.Fatalf("run %d: exit=%d stderr=%q", i, code, stderr)
		}
		want := []any{}
		if i == 2 {
			want = []any{"k_1"}
		}
		if got := decodeJSONOut(t, stdout); !reflect.DeepEqual(got["revoked_key_ids"], want) {
			t.Fatalf("run %d payload=%v", i, got)
		}
	}
	got := mustRead(t, cfg)
	wantBlock := "[mcp_servers.\"foo.bar\"]\nurl = \"" + h.url() + "/foo.bar/mcp\"\nhttp_headers = { \"Authorization\" = \"Bearer finch_secret2\" }\n"
	if !strings.HasPrefix(got, existing) || strings.Count(got, `[mcp_servers."foo.bar"]`) != 1 || !strings.Contains(got, wantBlock) {
		t.Fatalf("config.toml:\n%s", got)
	}

	// Recognised however it is quoted, and never in its bare (key path) form.
	if out, _ := mergeCodexConfig("[mcp_servers.'foo.bar']\nurl = \"x\"\n", "foo.bar", "https://a/foo.bar/mcp", ""); strings.Contains(out, `url = "x"`) {
		t.Fatalf("literal-quoted entry not replaced:\n%s", out)
	}
	if codexEntryKey("[mcp_servers.foo.bar]\nx = \"Bearer finch_abcd1234\"\n", "foo.bar") != "" {
		t.Fatal("the bare key path [mcp_servers.foo.bar] is not the server foo.bar")
	}
	if !codexDefinesInline("[mcp_servers]\n\"foo.bar\" = { url = \"x\" }\n", "foo.bar") || codexDefinesInline("[mcp_servers]\nfoo.bar = 1\n", "foo.bar") {
		t.Fatal("inline detection must use the quoted form of a dotted name")
	}
	if !codexDefinesInline("[mcp_servers]\nnotes.url = \"x\"\n", "notes") || !codexDefinesInline("mcp_servers.notes.url = \"x\"\n", "notes") {
		t.Fatal("dotted-key definitions must be detected")
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

// fakeClaude is a strict fake `claude` on PATH. It keeps local-scope entries as
// files in its state dir, answers `mcp get` in the real CLI's format (checked
// against claude 2.1.283), accepts only `mcp get <name>`, `mcp remove <name>
// -s local` and `mcp add-json <name> <json>`, fails any call whose argv
// carries a finch_ key, and appends every argv to argv.log.
type fakeClaude struct {
	dir   string
	state string
	log   string
}

func writeFakeClaude(t *testing.T, addExit string) *fakeClaude {
	t.Helper()
	bin := t.TempDir()
	f := &fakeClaude{dir: bin, state: filepath.Join(bin, "state"), log: filepath.Join(bin, "argv.log")}
	if err := os.MkdirAll(f.state, 0o700); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
S="` + f.state + `"
printf '%s\n' "$*" >> "` + f.log + `"
case "$*" in *finch_*) echo "fake claude: a key reached argv" >&2; exit 65 ;; esac
[ "$1" = mcp ] || { echo "fake claude: unexpected argv: $*" >&2; exit 64; }
case "$2" in
get)
  [ "$#" -eq 3 ] || exit 64
  if [ ! -f "$S/$3.json" ]; then echo "No MCP server named \"$3\". Run 'claude mcp add' to add one." >&2; exit 1; fi
  echo "$3:"
  echo "  Scope: $(cat "$S/$3.scope")"
  echo "  Status: ✓ Connected"
  echo "  Type: http"
  echo "  URL: $(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' "$S/$3.json")"
  if [ -f "$S/$3.headers" ]; then echo "  Headers:"; echo "    $(cat "$S/$3.headers")"; fi
  echo ""
  echo "To remove this server, run: claude mcp remove $3 -s local"
  ;;
remove)
  [ "$#" -eq 5 ] && [ "$4" = -s ] && [ "$5" = local ] || { echo "fake claude: bad remove: $*" >&2; exit 64; }
  [ -f "$S/$3.json" ] || { echo "No MCP server found with name: $3" >&2; exit 1; }
  rm -f "$S/$3.json" "$S/$3.scope" "$S/$3.headers"
  echo "Removed MCP server $3 from local config"
  ;;
add-json)
  [ "$#" -eq 4 ] || { echo "fake claude: bad add-json: $*" >&2; exit 64; }
  if [ -f "$S/$3.json" ]; then echo "MCP server $3 already exists in local config" >&2; exit 1; fi
  if [ "` + addExit + `" != 0 ]; then echo "Invalid configuration" >&2; exit ` + addExit + `; fi
  printf '%s' "$4" > "$S/$3.json"
  echo "Local config (private to you in this project)" > "$S/$3.scope"
  echo "Added http MCP server $3 to local config"
  ;;
*) echo "fake claude: unexpected argv: $*" >&2; exit 64 ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	return f
}

// seed plants an existing entry, as an older connect (or a human) left it.
func (f *fakeClaude) seed(t *testing.T, name, scope, url, header string) {
	t.Helper()
	files := map[string]string{name + ".json": `{"type":"http","url":"` + url + `"}`, name + ".scope": scope + "\n"}
	if header != "" {
		files[name+".headers"] = header + "\n"
	}
	for n, body := range files {
		if err := os.WriteFile(filepath.Join(f.state, n), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func (f *fakeClaude) entry(t *testing.T, name string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.state, name+".json"))
	if err != nil {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("add-json got invalid JSON %q: %v", b, err)
	}
	return m
}

// runHelper runs a headersHelper the way Claude Code does (through the shell)
// and decodes the headers it prints.
func runHelper(t *testing.T, helper string) map[string]string {
	t.Helper()
	out, err := exec.Command("/bin/sh", "-c", helper).Output()
	if err != nil {
		t.Fatalf("headersHelper %q failed: %v", helper, err)
	}
	var h map[string]string
	if err := json.Unmarshal(out, &h); err != nil {
		t.Fatalf("headersHelper printed %q, not a JSON object of headers", out)
	}
	return h
}

func TestConnectClaudeCode(t *testing.T) {
	home, h := connectFixture(t)
	fc := writeFakeClaude(t, "0")
	stdout, stderr, code := finch(t, "connect", "notes", "--client", "claude-code", "--json")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if strings.Contains(stdout+stderr, "finch_secret") || strings.Contains(mustRead(t, fc.log), "finch_") {
		t.Fatal("the key was printed or reached claude's argv")
	}
	helperFile := filepath.Join(home, ".finch", "connect", "notes.claude-code.json")
	got := decodeJSONOut(t, stdout)
	if got["client"] != "claude-code" || got["key_id"] != "k_1" || got["headers_file"] != helperFile || !reflect.DeepEqual(got["revoked_key_ids"], []any{}) {
		t.Fatalf("payload=%v", got)
	}
	if m := fileMode(t, helperFile); m != 0o600 {
		t.Fatalf("headers file mode=%04o, want 0600", m)
	}
	entry := fc.entry(t, "notes")
	helper, _ := entry["headersHelper"].(string)
	if entry["type"] != "http" || entry["url"] != h.url()+"/notes/mcp" || helper == "" || len(entry) != 3 {
		t.Fatalf("claude entry=%v", entry)
	}
	if hdr := runHelper(t, helper); !reflect.DeepEqual(hdr, map[string]string{"Authorization": "Bearer finch_secret1"}) {
		t.Fatalf("headersHelper printed %v", hdr)
	}
	calls := strings.Split(strings.TrimSpace(mustRead(t, fc.log)), "\n")
	if len(calls) != 2 || calls[0] != "mcp get notes" || !strings.HasPrefix(calls[1], "mcp add-json notes {") {
		t.Fatalf("claude calls=%q", calls)
	}
}

// Re-connecting replaces this project's entry and revokes what it replaced:
// the key the headers file held (shared by every project on this machine, so
// they all move to the new key) and a key an older entry carried inline.
func TestConnectClaudeCodeRotatesTheKey(t *testing.T) {
	_, h := connectFixture(t)
	h.set(func(h *fakeHub) { h.services["api"] = "key" })
	fc := writeFakeClaude(t, "0")
	host, _ := os.Hostname()
	label := "claude-code on " + host

	// k_1: an older connect's key, written inline into this project's entry.
	if _, stderr, code := finch(t, "keys", "mint", label, "--service", "notes", "--json"); code != 0 {
		t.Fatalf("keys mint: exit=%d stderr=%q", code, stderr)
	}
	fc.seed(t, "notes", "Local config (private to you in this project)", h.url()+"/notes/mcp", "Authorization: Bearer finch_secret1")
	// k_2: api, same label, another service; must survive.
	if _, stderr, code := finch(t, "connect", "api", "--client", "claude-code", "--json"); code != 0 {
		t.Fatalf("connect api: exit=%d stderr=%q", code, stderr)
	}

	stdout, stderr, code := finch(t, "connect", "notes", "--client", "claude-code", "--json") // k_3
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if got := decodeJSONOut(t, stdout); got["key_id"] != "k_3" || !reflect.DeepEqual(got["revoked_key_ids"], []any{"k_1"}) {
		t.Fatalf("payload=%v", got)
	}
	if hdr := runHelper(t, fc.entry(t, "notes")["headersHelper"].(string)); hdr["Authorization"] != "Bearer finch_secret3" {
		t.Fatalf("helper after the first connect: %v", hdr)
	}

	stdout, stderr, code = finch(t, "connect", "notes", "--client", "claude-code", "--json") // k_4
	if code != 0 {
		t.Fatalf("reconnect: exit=%d stderr=%q", code, stderr)
	}
	if got := decodeJSONOut(t, stdout); got["key_id"] != "k_4" || !reflect.DeepEqual(got["revoked_key_ids"], []any{"k_3"}) {
		t.Fatalf("reconnect payload=%v", got)
	}
	if hdr := runHelper(t, fc.entry(t, "notes")["headersHelper"].(string)); hdr["Authorization"] != "Bearer finch_secret4" {
		t.Fatalf("helper after the reconnect: %v", hdr)
	}
	if !reflect.DeepEqual(h.revoked, []string{"k_1", "k_3"}) {
		t.Fatalf("revoked=%v", h.revoked)
	}
	for _, live := range []string{"k_2", "k_4"} {
		if _, ok := h.keys[live]; !ok {
			t.Fatalf("%s was revoked; keys=%v", live, h.keys)
		}
	}
	if strings.Contains(mustRead(t, fc.log), "finch_") {
		t.Fatal("a key reached claude's argv")
	}

	// An entry in another scope is not this project's to replace: it is left
	// alone, and so is its key.
	fc2 := writeFakeClaude(t, "0")
	h.set(func(h *fakeHub) { h.services["docs"] = "key" })
	if _, _, code := finch(t, "keys", "mint", label, "--service", "docs", "--json"); code != 0 { // k_5
		t.Fatal("keys mint failed")
	}
	fc2.seed(t, "docs", "User config (available in all your projects)", h.url()+"/docs/mcp", "Authorization: Bearer finch_secret5")
	finch(t, "connect", "docs", "--client", "claude-code", "--json")
	if _, ok := h.keys["k_5"]; !ok || strings.Contains(mustRead(t, fc2.log), "mcp remove") {
		t.Fatalf("a user-scope entry was replaced or its key revoked: keys=%v log=%q", h.keys, mustRead(t, fc2.log))
	}
}

func TestConnectClaudeCodeFailureRevokesKey(t *testing.T) {
	home, h := connectFixture(t)
	fc := writeFakeClaude(t, "1")
	helperFile := filepath.Join(home, ".finch", "connect", "notes.claude-code.json")
	_, stderr, code := finch(t, "connect", "notes", "--client", "claude-code", "--json")
	env := decodeJSONError(t, stderr)
	if code != 1 || env.Error.Code != "UPSTREAM" || env.Error.Next != "finch connect notes --client claude-code" {
		t.Fatalf("exit=%d env=%+v", code, env)
	}
	if strings.Contains(stderr, "finch_secret") || strings.Contains(mustRead(t, fc.log), "finch_") {
		t.Fatalf("the key leaked: %q", stderr)
	}
	if !reflect.DeepEqual(h.revoked, []string{"k_1"}) || len(h.keys) != 0 {
		t.Fatalf("the orphan key was not revoked: revoked=%v keys=%v", h.revoked, h.keys)
	}
	if fileExists(helperFile) {
		t.Fatal("a failed connect left a headers file with a revoked key")
	}

	// With an earlier headers file, a failure puts it back as it was.
	prev := []byte(`{"Authorization":"Bearer finch_earlier"}` + "\n")
	if err := writeCredentialFile(helperFile, prev); err != nil {
		t.Fatal(err)
	}
	finch(t, "connect", "notes", "--client", "claude-code", "--json")
	if mustRead(t, helperFile) != string(prev) {
		t.Fatalf("headers file not restored: %q", mustRead(t, helperFile))
	}
}

func TestShellQuoteSurvivesTheShell(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "it's a dir")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(dir, "h.json")
	if err := os.WriteFile(f, []byte(`{"Authorization":"Bearer x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cat, err := lookPathAbs("cat")
	if err != nil {
		t.Fatal(err)
	}
	if got := runHelper(t, claudeHelperCommand(cat, f)); got["Authorization"] != "Bearer x" {
		t.Fatalf("helper=%v", got)
	}
}

// The headersHelper names the cat preflight found on PATH, by absolute path,
// and a machine with no cat on PATH fails preflight before a key is minted.
func TestConnectClaudeCodeResolvesCat(t *testing.T) {
	_, h := connectFixture(t)
	fc := writeFakeClaude(t, "0")
	catDir := t.TempDir()
	cat := filepath.Join(catDir, "cat")
	if err := os.Symlink("/bin/cat", cat); err != nil {
		t.Fatal(err)
	}
	// Only the fake claude and this cat: no /bin, /usr/bin on PATH.
	t.Setenv("PATH", fc.dir+":"+catDir)
	if _, stderr, code := finch(t, "connect", "notes", "--client", "claude-code", "--json"); code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	helper, _ := fc.entry(t, "notes")["headersHelper"].(string)
	if !strings.HasPrefix(helper, shellQuote(cat)+" ") {
		t.Fatalf("headersHelper=%q, want it to start with %s", helper, shellQuote(cat))
	}
	if hdr := runHelper(t, helper); hdr["Authorization"] != "Bearer finch_secret1" {
		t.Fatalf("headersHelper printed %v", hdr)
	}

	_, h2 := connectFixture(t)
	fc2 := writeFakeClaude(t, "0")
	t.Setenv("PATH", fc2.dir)
	_, stderr, code := finch(t, "connect", "notes", "--client", "claude-code", "--json")
	env := decodeJSONError(t, stderr)
	if code != 1 || env.Error.Code != "NOT_FOUND" || !strings.Contains(env.Error.Message, "cat") || env.Error.Next != "finch connect notes --client json" {
		t.Fatalf("exit=%d env=%+v", code, env)
	}
	if h2.nextKey != 0 || h.nextKey != 1 {
		t.Fatalf("minted: %d, %d", h.nextKey, h2.nextKey)
	}
}

// A service made public after it was connected: the re-connect writes an entry
// with no headersHelper and revokes the helper file's key. The file itself is
// machine-wide — entries for this service in OTHER project directories still
// run it — so it stays, emptied to no headers, and those entries keep working.
func TestConnectClaudeCodePublicReconnectRevokesTheHelperKey(t *testing.T) {
	home, h := connectFixture(t)
	fc := writeFakeClaude(t, "0")
	helperFile := filepath.Join(home, ".finch", "connect", "notes.claude-code.json")
	if _, stderr, code := finch(t, "connect", "notes", "--client", "claude-code", "--json"); code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if !fileExists(helperFile) {
		t.Fatal("no headers file after a key-gated connect")
	}
	// What another project's entry for this service runs.
	otherProjectHelper := fc.entry(t, "notes")["headersHelper"].(string)

	// The first public reconnect cannot reach the hub to revoke: it fails
	// and leaves the helper holding the (still live) key.
	h.set(func(h *fakeHub) { h.services["notes"] = "public"; h.revokeDown = true })
	_, stderr, code := finch(t, "connect", "notes", "--client", "claude-code", "--json")
	env := decodeJSONError(t, stderr)
	if code != 1 || env.Error.Code != "INTERNAL" || env.Error.Next != "finch keys revoke k_1" || !strings.Contains(env.Error.Message, "k_1 is still active") {
		t.Fatalf("exit=%d env=%+v", code, env)
	}
	if hdr := runHelper(t, otherProjectHelper); hdr["Authorization"] != "Bearer finch_secret1" {
		t.Fatalf("the helper lost its unrevoked key: %v", hdr)
	}
	h.set(func(h *fakeHub) { h.revokeDown = false })
	stdout, stderr, code := finch(t, "connect", "notes", "--client", "claude-code", "--json")
	if code != 0 {
		t.Fatalf("public reconnect: exit=%d stderr=%q", code, stderr)
	}
	got := decodeJSONOut(t, stdout)
	if got["key_id"] != "" || !reflect.DeepEqual(got["revoked_key_ids"], []any{"k_1"}) || got["headers_file"] != nil {
		t.Fatalf("payload=%v", got)
	}
	if !reflect.DeepEqual(h.revoked, []string{"k_1"}) || h.nextKey != 1 {
		t.Fatalf("revoked=%v minted=%d", h.revoked, h.nextKey)
	}
	if got := mustRead(t, helperFile); got != "{}\n" {
		t.Fatalf("headers file=%q, want it kept with no headers", got)
	}
	if hdr := runHelper(t, otherProjectHelper); len(hdr) != 0 {
		t.Fatalf("another project's helper still sends headers: %v", hdr)
	}
	if entry := fc.entry(t, "notes"); entry["headersHelper"] != nil || entry["url"] != h.url()+"/notes/mcp" {
		t.Fatalf("claude entry=%v", entry)
	}
}

// Credential state is checked before the client: while a login awaits approval
// (or there is none) a missing client is not what the agent should chase.
func TestConnectChecksLoginBeforeClient(t *testing.T) {
	isolate(t)
	h := newFakeHub(t)
	t.Setenv("PATH", t.TempDir()) // no claude
	_, stderr, code := finch(t, "connect", "notes", "--client", "claude-code", "--json")
	if env := decodeJSONError(t, stderr); code != 12 || env.Error.Code != "NOT_LOGGED_IN" {
		t.Fatalf("not logged in: exit=%d env=%+v", code, env)
	}
	if err := savePendingLogin(&pendingLogin{Hub: h.url(), DeviceCode: "d", UserCode: "AB-CD", VerificationURIComplete: "https://x/cli", Interval: 3, ExpiresAt: time.Now().Add(time.Minute).Unix()}); err != nil {
		t.Fatal(err)
	}
	for _, client := range []string{"claude-code", "cursor", "codex"} {
		_, stderr, code := finch(t, "connect", "notes", "--client", client, "--json")
		if env := decodeJSONError(t, stderr); code != 10 || env.Error.Code != "APPROVAL_PENDING" || env.Error.Next != "finch login --poll" {
			t.Fatalf("%s while a login is pending: exit=%d env=%+v", client, code, env)
		}
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

// On a staging hub the tenant's stored slug host is not routed, so connect
// writes the origin the hub names in serviceBase.
func TestConnectUsesTheHubsServiceBase(t *testing.T) {
	_, h := connectFixture(t)
	h.set(func(h *fakeHub) {
		h.host = "brave-finch-12.finchmcp.com"
		h.serviceBase = "https://finch-hub-staging.example.workers.dev"
	})
	stdout, stderr, code := finch(t, "connect", "notes", "--client", "json", "--json")
	if got := decodeJSONOut(t, stdout); code != 0 || got["url"] != "https://finch-hub-staging.example.workers.dev/notes/mcp" {
		t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout, stderr)
	}
}

func TestServiceMCPURL(t *testing.T) {
	const staging = "https://finch-hub-staging.example.workers.dev"
	for _, tc := range []struct{ hub, base, host, want string }{
		// The hub's serviceBase wins.
		{"https://finchmcp.com", "https://brave-finch-12.finchmcp.com", "brave-finch-12.finchmcp.com", "https://brave-finch-12.finchmcp.com/notes/mcp"},
		{staging, staging, "brave-finch-12.finchmcp.com", staging + "/notes/mcp"},
		{"http://127.0.0.1:8787", "http://127.0.0.1:8787", "brave-finch-12.finchmcp.com", "http://127.0.0.1:8787/notes/mcp"},
		// A hub without serviceBase (or with a malformed one).
		{"https://finchmcp.com", "", "brave-finch-12.finchmcp.com", "https://brave-finch-12.finchmcp.com/notes/mcp"},
		{"https://finchmcp.com", "", "", "https://finchmcp.com/notes/mcp"},
		{"http://127.0.0.1:8787", "", "brave-finch-12.finchmcp.com", "http://127.0.0.1:8787/notes/mcp"},
		{staging, "", "brave-finch-12.finchmcp.com", staging + "/notes/mcp"},
		{staging, "ftp://x", "brave-finch-12.finchmcp.com", staging + "/notes/mcp"},
		{staging, "https://x.example/sub", "brave-finch-12.finchmcp.com", staging + "/notes/mcp"},
	} {
		if got := serviceMCPURL(tc.hub, tc.base, tc.host, "notes"); got != tc.want {
			t.Errorf("serviceMCPURL(%q,%q,%q)=%q, want %q", tc.hub, tc.base, tc.host, got, tc.want)
		}
	}
}
