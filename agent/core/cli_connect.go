package core

// `finch connect <name> --client claude-code|cursor|codex|json` — wire a
// published service into an MCP client in one step. It mints a fresh finch_
// key scoped to that one service and labelled for the client, then writes it
// straight into the client's configuration, so the key never passes through
// the agent's transcript. `--client json` is the one mode that prints the key:
// it emits an mcpServers snippet for clients finch does not know.
//
// The client is checked BEFORE a key is minted (a missing client must not
// leave an orphan key behind), and a key whose wiring fails is revoked again.
// When the client already had an entry for the service carrying a finch_ key
// that this command minted earlier (same label, same one-service scope, same
// last four characters), that key is revoked once the new entry is written, so
// re-running connect rotates the key instead of piling up live keys nothing
// references.
//
// Claude Code: the `claude` CLI (checked on 2.1.283) has no way to take a
// header value except as an argument — `claude mcp add --header` and
// `claude mcp add-json <name> <json>` both put it in claude's argv, where any
// local process can read it (ps, /proc/<pid>/cmdline), and add-json does not
// read '-', /dev/stdin or @file. So the key never goes to claude at all: finch
// writes it to ~/.finch/connect/<name>.claude-code.json (0600, the hardened
// credential writer) and registers the server with a headersHelper that cats
// that file, which Claude Code runs each time it connects. claude's argv then
// carries only the URL and the file's path. The same file serves every project
// connected to that service on this machine, so a re-connect rotates the key
// for all of them. The helper names cat by the absolute path preflight found on
// PATH (not a hard-coded /bin/cat, which NixOS and some minimal systems lack).
// Re-connecting a service that has since been made public writes an entry with
// no helper, so the file's key is revoked and the file removed.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var connectClients = []string{"claude-code", "cursor", "codex", "json"}

func cursorConfigDir() string { return filepath.Join(homeDir(), ".cursor") }

func codexConfigDir() string {
	if d := os.Getenv("CODEX_HOME"); d != "" && filepath.IsAbs(d) {
		return d
	}
	return filepath.Join(homeDir(), ".codex")
}

// connectTarget is what preflight learned about the client before a key exists.
type connectTarget struct {
	client string
	claude string         // claude-code: the claude binary
	cat    string         // claude-code: absolute path of cat, for the headersHelper
	config string         // cursor/codex: the config file to merge into
	cursor map[string]any // cursor: the parsed existing config
	codex  string         // codex: the existing config text
	// prevKey is the finch_ key the existing cursor/codex entry for the
	// service carries (for claude-code: the one written inline in the project's
	// local entry), if any; it is replaced by this connect.
	prevKey string
	// claude-code: whether this project has a local entry for the service
	// (it is removed and re-added), the headers file, and what it held before.
	claudeLocal   bool
	helperPath    string
	helperBefore  []byte
	helperPrevKey string
}

// claudeCommandTimeout bounds each `claude mcp` call (get health-checks the
// server it describes).
const claudeCommandTimeout = 2 * time.Minute

// runClaude runs the claude CLI. Its argv must never carry a key.
var runClaude = func(bin string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), claudeCommandTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, args...).CombinedOutput()
	return string(out), err
}

// claudeHelperPath is the 0600 file Claude Code's headersHelper reads a
// service's Authorization header from.
func claudeHelperPath(name string) string {
	return filepath.Join(finchHome(), "connect", name+".claude-code.json")
}

// shellQuote single-quotes s for the shell Claude Code runs headersHelper with.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// claudeHelperCommand is the headersHelper: print the headers file, which is
// already the JSON object of headers Claude Code expects. cat is the absolute
// path preflight resolved, so the helper does not depend on the PATH Claude
// Code happens to run it with.
func claudeHelperCommand(cat, path string) string { return shellQuote(cat) + " " + shellQuote(path) }

// lookPathAbs resolves an executable on PATH to an absolute path.
func lookPathAbs(name string) (string, error) {
	p, err := exec.LookPath(name)
	if err != nil {
		return "", err
	}
	return filepath.Abs(p)
}

var claudeLocalScope = regexp.MustCompile(`(?m)^\s*Scope:\s*Local config`)

// claudeExistingEntry asks `claude mcp get` about the service's entry for this
// project: whether it is a local one, and the finch_ key written inline in its
// Authorization header, if any. No entry (or a get that fails) reads as none.
func claudeExistingEntry(bin, name string) (local bool, inlineKey string) {
	out, err := runClaude(bin, "mcp", "get", name)
	if err != nil {
		return false, ""
	}
	if !claudeLocalScope.MatchString(out) {
		return false, ""
	}
	if m := bearerFinchKey.FindStringSubmatch(out); m != nil {
		inlineKey = m[1]
	}
	return true, inlineKey
}

var bearerFinchKey = regexp.MustCompile(`Bearer\s+(finch_[A-Za-z0-9_-]+)`)

// cursorEntryKey returns the finch_ key in mcpServers.<name>.headers.Authorization.
func cursorEntryKey(doc map[string]any, name string) string {
	servers, _ := doc["mcpServers"].(map[string]any)
	entry, _ := servers[name].(map[string]any)
	headers, _ := entry["headers"].(map[string]any)
	auth, _ := headers["Authorization"].(string)
	if m := bearerFinchKey.FindStringSubmatch(auth); m != nil {
		return m[1]
	}
	return ""
}

// codexEntryKey returns the finch_ key in the [mcp_servers.<name>] table.
func codexEntryKey(text, name string) string {
	header := codexServerHeader(name)
	in := false
	for _, line := range strings.Split(text, "\n") {
		if tomlHeaderLine.MatchString(line) {
			in = header.MatchString(line)
			continue
		}
		if in {
			if m := bearerFinchKey.FindStringSubmatch(line); m != nil {
				return m[1]
			}
		}
	}
	return ""
}

// replacedKeyIDs finds the account key behind prevKey: minted by connect for
// the same client and host (label), scoped to exactly this service, with the
// same last four characters. The key minted by this run is never a match.
func replacedKeyIDs(st map[string]any, name, label, newID, prevKey string) []string {
	if len(prevKey) < len("finch_")+4 {
		return nil
	}
	last4 := prevKey[len(prevKey)-4:]
	var ids []string
	keys, _ := st["keys"].([]any)
	for _, k := range keys {
		m, _ := k.(map[string]any)
		id, _ := m["id"].(string)
		if id == "" || id == newID || m["label"] != label || m["last4"] != last4 {
			continue
		}
		scope, _ := m["scope"].(map[string]any)
		services, _ := scope["services"].([]any)
		if len(services) == 1 && services[0] == name {
			ids = append(ids, id)
		}
	}
	return ids
}

func preflightClient(client, name string) (*connectTarget, error) {
	t := &connectTarget{client: client}
	jsonNext := "finch connect " + name + " --client json"
	switch client {
	case "claude-code":
		bin, err := exec.LookPath("claude")
		if err != nil {
			return nil, newCLIError(codeNotFound, jsonNext, "the 'claude' CLI (Claude Code) is not on PATH")
		}
		t.claude = bin
		cat, err := lookPathAbs("cat")
		if err != nil {
			return nil, newCLIError(codeNotFound, jsonNext, "no 'cat' on PATH; Claude Code's headersHelper needs it to read the key file")
		}
		t.cat = cat
		t.helperPath = claudeHelperPath(name)
		before, err := readCredentialFile(t.helperPath, credentialStateLimit)
		if err != nil {
			return nil, newCLIError(codeInternal, "", "reading %s: %v", t.helperPath, err)
		}
		t.helperBefore = before
		if m := bearerFinchKey.FindStringSubmatch(string(before)); m != nil {
			t.helperPrevKey = m[1]
		}
		t.claudeLocal, t.prevKey = claudeExistingEntry(bin, name)
	case "cursor":
		dir := cursorConfigDir()
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			return nil, newCLIError(codeNotFound, jsonNext, "Cursor's config directory %s does not exist (is Cursor installed and opened once?)", dir)
		}
		t.config = filepath.Join(dir, "mcp.json")
		doc := map[string]any{}
		if b, err := os.ReadFile(t.config); err == nil {
			if len(strings.TrimSpace(string(b))) > 0 {
				if err := json.Unmarshal(b, &doc); err != nil || doc == nil {
					return nil, newCLIError(codeInternal, jsonNext, "%s is not a JSON object; fix it first so finch does not overwrite it", t.config)
				}
			}
		} else if !os.IsNotExist(err) {
			return nil, newCLIError(codeInternal, "", "reading %s: %v", t.config, err)
		}
		if s, ok := doc["mcpServers"]; ok {
			if _, ok := s.(map[string]any); !ok {
				return nil, newCLIError(codeInternal, jsonNext, "%s: mcpServers is not an object", t.config)
			}
		}
		t.cursor = doc
		t.prevKey = cursorEntryKey(doc, name)
	case "codex":
		dir := codexConfigDir()
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			return nil, newCLIError(codeNotFound, jsonNext, "Codex's config directory %s does not exist (is Codex installed?)", dir)
		}
		t.config = filepath.Join(dir, "config.toml")
		if b, err := os.ReadFile(t.config); err == nil {
			t.codex = string(b)
		} else if !os.IsNotExist(err) {
			return nil, newCLIError(codeInternal, "", "reading %s: %v", t.config, err)
		}
		if codexDefinesInline(t.codex, name) {
			return nil, newCLIError(codeInternal, jsonNext, "%s already defines mcp_servers.%s inline; remove it first so finch can manage the entry", t.config, codexServerKey(name))
		}
		t.prevKey = codexEntryKey(t.codex, name)
	}
	return t, nil
}

// serviceMCPURL is the public MCP endpoint of a service. The hub says which
// origin reaches the tenant's services (serviceBase in /api/cli/state): the
// slug host in production, the hub itself in dev/staging, where the stored
// <slug>.finchmcp.com host is not routed. A hub that predates serviceBase gets
// the slug host only when it is a subdomain of the hub's own host (production:
// finchmcp.com → <slug>.finchmcp.com), and otherwise the hub itself (a loopback
// or workers.dev hub, or a tenant with no slug yet).
func serviceMCPURL(hub, serviceBase, host, name string) string {
	if b, err := url.Parse(serviceBase); err == nil && (b.Scheme == "https" || b.Scheme == "http") && b.Host != "" && (b.Path == "" || b.Path == "/") && b.RawQuery == "" && b.User == nil {
		return b.Scheme + "://" + b.Host + "/" + name + "/mcp"
	}
	if u, err := url.Parse(hub); err == nil && host != "" && !isLoopbackHost(u.Hostname()) &&
		strings.HasSuffix(strings.ToLower(host), "."+strings.ToLower(u.Hostname())) {
		return "https://" + host + "/" + name + "/mcp"
	}
	return strings.TrimRight(hub, "/") + "/" + name + "/mcp"
}

func runConnect(c *cli, args []string) error {
	fs := newFlagSet("connect")
	client := fs.String("client", "", "the MCP `client`: claude-code, cursor, codex, or json (prints a snippet)")
	fs.Bool("json", false, "JSON output (the key is included only with --client json)")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usageError("usage: finch connect <name> --client claude-code|cursor|codex|json")
	}
	name := pos[0]
	if err := validateServiceID(name); err != nil {
		return usageError("%v", err)
	}
	valid := false
	for _, k := range connectClients {
		valid = valid || *client == k
	}
	if !valid {
		return usageError("--client must be one of: %s", strings.Join(connectClients, ", "))
	}
	// Credential state first: while a login awaits approval (or there is none)
	// the answer is to finish logging in, not to troubleshoot the client.
	cred, err := requireCred()
	if err != nil {
		return err
	}
	target, err := preflightClient(*client, name)
	if err != nil {
		return err
	}
	st, err := cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
	if err != nil {
		return hubFailure(err, "connect "+name, "")
	}
	public, found := false, false
	services, _ := st["services"].([]any)
	for _, s := range services {
		if m, ok := s.(map[string]any); ok && m["id"] == name {
			found = true
			public = m["auth"] == "public"
		}
	}
	if !found {
		return newCLIError(codeNotFound, "finch add "+name+" --service <url>", "no service named %q in this account", name)
	}
	host, _ := st["host"].(string)
	serviceBase, _ := st["serviceBase"].(string)
	endpoint := serviceMCPURL(cred.Hub, serviceBase, host, name)

	// A public service needs no key; everything else gets its own, so revoking
	// one client never cuts off another.
	key, keyID := "", ""
	label := connectLabel(*client)
	if !public {
		out, err := mintClientKey(cred, label, map[string][]string{"services": {name}})
		if err != nil {
			return err
		}
		key, _ = out["key"].(string)
		keyID, _ = out["id"].(string)
	}
	server := map[string]any{"url": endpoint}
	if key != "" {
		server["headers"] = map[string]string{"Authorization": "Bearer " + key}
	}

	configPath := ""
	switch *client {
	case "json":
		snippet := map[string]any{"type": "http", "url": endpoint}
		if key != "" {
			snippet["headers"] = server["headers"]
		}
		if keyID != "" {
			recordConnection(connection{Client: "json", Name: name, URL: endpoint, KeyID: keyID})
		}
		servers := map[string]any{"mcpServers": map[string]any{name: snippet}}
		if c.json {
			return c.emit(map[string]any{"client": "json", "name": name, "url": endpoint, "key_id": keyID, "mcpServers": servers["mcpServers"]})
		}
		b, _ := json.MarshalIndent(servers, "", "  ")
		fmt.Fprintln(c.stdout, string(b))
		return nil
	case "claude-code":
		if err := connectClaudeCode(target, name, endpoint, key); err != nil {
			revokeQuietly(cred, keyID)
			return err
		}
	case "cursor":
		servers, _ := target.cursor["mcpServers"].(map[string]any)
		if servers == nil {
			servers = map[string]any{}
		}
		servers[name] = server
		target.cursor["mcpServers"] = servers
		b, _ := json.MarshalIndent(target.cursor, "", "  ")
		if err := atomicWriteFile(target.config, append(b, '\n'), 0o600); err != nil {
			revokeQuietly(cred, keyID)
			return newCLIError(codeInternal, "", "writing %s: %v", target.config, err)
		}
		configPath = target.config
	case "codex":
		merged, err := mergeCodexConfig(target.codex, name, endpoint, key)
		if err == nil {
			err = atomicWriteFile(target.config, []byte(merged), 0o600)
		}
		if err != nil {
			revokeQuietly(cred, keyID)
			return newCLIError(codeInternal, "", "writing %s: %v", target.config, err)
		}
		configPath = target.config
	}

	// Remember the entry, so 'finch uninstall' can take it out again.
	conn := connection{Client: *client, Name: name, URL: endpoint, KeyID: keyID, Config: configPath}
	if *client == "claude-code" {
		conn.Dir, _ = os.Getwd()
	}
	recordConnection(conn)

	// The client's entry now carries the new key (or none, for a public
	// service), so the key it replaced is referenced nowhere: revoke it. For
	// claude-code that is the key inline in the project entry it removed, and
	// the key the headers file held before this run overwrote it (or, for a
	// service now public, before it is emptied below).
	prevKeys := []string{target.prevKey}
	if *client == "claude-code" {
		prevKeys = append(prevKeys, target.helperPrevKey)
	}
	revoked := []string{}
	var unrevoked []string
	var revokeErr error
	seen := map[string]bool{}
	for _, prev := range prevKeys {
		for _, id := range replacedKeyIDs(st, name, label, keyID, prev) {
			if seen[id] {
				continue
			}
			seen[id] = true
			if _, err := cliRequest("POST", cred.Hub, "/api/cli/keys/revoke", cred.Token, map[string]string{"id": id}); err != nil {
				unrevoked = append(unrevoked, id)
				if revokeErr == nil {
					revokeErr = err
				}
				continue
			}
			revoked = append(revoked, id)
		}
	}
	// A rotation that leaves the superseded key live is not a success: the
	// client no longer references it, so no later connect would find it again.
	// (Reconnecting is how a suspected-exposed key gets rotated.)
	if len(unrevoked) > 0 {
		next := "finch keys list"
		if len(unrevoked) == 1 {
			next = "finch keys revoke " + unrevoked[0]
		}
		return newCLIError(codeInternal, next,
			"connected %s, but revoking the key it replaced failed (%v); %s is still active — revoke it with 'finch keys revoke <id>' (see 'finch keys list')",
			name, revokeErr, strings.Join(unrevoked, ", "))
	}
	// A public entry has no headersHelper, but Claude Code entries for this
	// service in OTHER project directories still run the same machine-wide
	// helper file. Keep it, now that its key is revoked, with no headers, so
	// those entries still reach the (public) service.
	if *client == "claude-code" && key == "" && target.helperBefore != nil {
		if err := writeCredentialFile(target.helperPath, []byte("{}\n")); err != nil {
			return newCLIError(codeInternal, "", "connected %s, but emptying the stale headers file %s failed: %v", name, target.helperPath, err)
		}
	}

	if c.json {
		p := map[string]any{"client": *client, "name": name, "url": endpoint, "key_id": keyID, "revoked_key_ids": revoked}
		switch {
		case *client == "claude-code" && key != "":
			p["headers_file"] = target.helperPath
		case *client != "claude-code":
			p["config"] = configPath
		}
		return c.emit(p)
	}
	where := map[string]string{"claude-code": "Claude Code (this directory's project)", "cursor": "Cursor (" + configPath + ")", "codex": "Codex (" + configPath + ")"}[*client]
	c.printf("finch: connected %s to %s → %s\n", name, where, endpoint)
	if keyID != "" {
		c.printf("       using a new key %s (revoke with 'finch keys revoke %s'); the key was not printed\n", keyID, keyID)
	}
	if *client == "claude-code" && key != "" {
		c.printf("       Claude Code reads it from %s through a headersHelper, which it runs only in a trusted workspace\n", target.helperPath)
	}
	if len(revoked) > 0 {
		c.printf("       revoked the key the old entry used: %s\n", strings.Join(revoked, ", "))
	}
	c.printf("       restart the client (or reload its MCP servers) to pick it up\n")
	return nil
}

// connectClaudeCode registers the service with Claude Code for the current
// directory's project (claude's "local" scope) without the key ever reaching
// claude's argv: the key goes to the 0600 headers file first, and the entry
// runs a headersHelper that prints it. An existing local entry is replaced.
// On failure the headers file is put back as it was; the caller revokes the
// new key.
func connectClaudeCode(t *connectTarget, name, endpoint, key string) error {
	entry := map[string]any{"type": "http", "url": endpoint}
	restore := func() {}
	if key != "" {
		headers, _ := json.Marshal(map[string]string{"Authorization": "Bearer " + key})
		if err := writeCredentialFile(t.helperPath, append(headers, '\n')); err != nil {
			return newCLIError(codeInternal, "", "writing %s: %v", t.helperPath, err)
		}
		restore = func() {
			if t.helperBefore != nil {
				_ = writeCredentialFile(t.helperPath, t.helperBefore)
			} else {
				_ = os.Remove(t.helperPath)
			}
		}
		entry["headersHelper"] = claudeHelperCommand(t.cat, t.helperPath)
	}
	next := "finch connect " + name + " --client claude-code"
	if t.claudeLocal {
		if out, err := runClaude(t.claude, "mcp", "remove", name, "-s", "local"); err != nil {
			restore()
			return newCLIError(codeUpstream, next, "claude mcp remove %s failed (%v): %s", name, err, strings.TrimSpace(out))
		}
	}
	b, _ := json.Marshal(entry)
	if out, err := runClaude(t.claude, "mcp", "add-json", name, string(b)); err != nil {
		restore()
		msg := fmt.Sprintf("claude mcp add-json failed (%v): %s", err, strings.TrimSpace(out))
		if t.claudeLocal {
			msg += "; this project's previous " + name + " entry was already removed, so run connect again"
		}
		return newCLIError(codeUpstream, next, "%s", msg)
	}
	// A public entry has no headersHelper. The headers file left from when the
	// service was key-gated is emptied by the caller once its key is revoked.
	return nil
}

func revokeQuietly(cred *cliCred, keyID string) {
	if keyID != "" {
		_, _ = cliRequest("POST", cred.Hub, "/api/cli/keys/revoke", cred.Token, map[string]string{"id": keyID})
	}
}

var tomlHeaderLine = regexp.MustCompile(`^\s*\[`)

var tomlBareKey = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// codexServerKey is the service name as one TOML key segment. A service id may
// contain '.', which a bare key would split into nested tables
// ([mcp_servers.foo.bar] is server "foo", sub-table "bar"), so such a name is
// quoted: [mcp_servers."foo.bar"]. Service ids never need escapes inside the
// quotes (validAppPath allows only letters, digits, '-', '_' and '.').
func codexServerKey(name string) string {
	if tomlBareKey.MatchString(name) {
		return name
	}
	return `"` + name + `"`
}

// codexKeyForms is a regexp alternation of the ways config.toml can spell the
// service name as one key segment: quoted either way, or bare when the name is
// a valid bare key. A dotted name has no bare form: bare, it is a key path.
func codexKeyForms(name string) string {
	q := regexp.QuoteMeta(name)
	forms := `"` + q + `"|'` + q + `'`
	if tomlBareKey.MatchString(name) {
		forms = q + `|` + forms
	}
	return `(?:` + forms + `)`
}

// codexServersKey matches the mcp_servers key itself, bare or quoted
// (["mcp_servers"] and ['mcp_servers'] are the same TOML key).
const codexServersKey = `(?:mcp_servers|"mcp_servers"|'mcp_servers')`

// codexServerHeader matches `[mcp_servers.<name>]` and its sub-tables
// (`[mcp_servers.<name>.env]`), bare or quoted, with an optional comment.
func codexServerHeader(name string) *regexp.Regexp {
	return regexp.MustCompile(`^\s*\[\s*` + codexServersKey + `\s*\.\s*` + codexKeyForms(name) + `\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$`)
}

// codexDefinesInline reports whether config.toml defines the server in a form
// line surgery cannot safely replace: a key (or dotted key) inside a
// [mcp_servers] table, an inline mcp_servers = { … } value, or a root-level
// dotted key mcp_servers.<name>.… = ….
func codexDefinesInline(text, name string) bool {
	forms := codexKeyForms(name)
	inTable := false
	tableHeader := regexp.MustCompile(`^\s*\[\s*` + codexServersKey + `\s*\]\s*(?:#.*)?$`)
	keyLine := regexp.MustCompile(`^\s*` + forms + `\s*[=.]`)
	rootInline := regexp.MustCompile(`^\s*` + codexServersKey + `\s*(?:=|\.\s*` + forms + `\s*[=.])`)
	atRoot := true
	for _, line := range strings.Split(text, "\n") {
		if tomlHeaderLine.MatchString(line) {
			atRoot = false
			inTable = tableHeader.MatchString(line)
			continue
		}
		if (inTable && keyLine.MatchString(line)) || (atRoot && rootInline.MatchString(line)) {
			return true
		}
	}
	return false
}

func tomlString(s string) (string, error) {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("value contains a control character")
		}
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`, nil
}

// mergeCodexConfig replaces (or adds) [mcp_servers.<name>] (quoted when the
// name has a '.') in Codex's
// config.toml, leaving every other line — comments included — untouched.
func mergeCodexConfig(text, name, endpoint, key string) (string, error) {
	header := codexServerHeader(name)
	var kept []string
	skipping := false
	for _, line := range strings.Split(text, "\n") {
		if tomlHeaderLine.MatchString(line) {
			skipping = header.MatchString(line)
		}
		if !skipping {
			kept = append(kept, line)
		}
	}
	out := strings.TrimRight(strings.Join(kept, "\n"), "\n")
	u, err := tomlString(endpoint)
	if err != nil {
		return "", err
	}
	block := "# Managed by 'finch connect " + name + " --client codex'.\n[mcp_servers." + codexServerKey(name) + "]\nurl = " + u + "\n"
	if key != "" {
		h, err := tomlString("Bearer " + key)
		if err != nil {
			return "", err
		}
		block += `http_headers = { "Authorization" = ` + h + " }\n"
	}
	// Drop our own marker comment from a previous run so it does not pile up.
	out = strings.TrimRight(strings.ReplaceAll(out, "# Managed by 'finch connect "+name+" --client codex'.", ""), "\n")
	if out != "" {
		out += "\n\n"
	}
	return out + block, nil
}
