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

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
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
	config string         // cursor/codex: the config file to merge into
	cursor map[string]any // cursor: the parsed existing config
	codex  string         // codex: the existing config text
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
			return nil, newCLIError(codeInternal, jsonNext, "%s already defines mcp_servers.%s inline; remove it first so finch can manage the entry", t.config, name)
		}
	}
	return t, nil
}

// serviceMCPURL is the public MCP endpoint of a service: the tenant's slug host
// in production, the hub itself for a loopback (dev) hub or a tenant with no
// slug yet.
func serviceMCPURL(hub, host, name string) string {
	if u, err := url.Parse(hub); err == nil && host != "" && !isLoopbackHost(u.Hostname()) {
		return "https://" + host + "/" + name + "/mcp"
	}
	return strings.TrimRight(hub, "/") + "/" + name + "/mcp"
}

func runConnect(c *cli, args []string) error {
	fs := newFlagSet("connect")
	client := fs.String("client", "", "claude-code | cursor | codex | json")
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
	target, err := preflightClient(*client, name)
	if err != nil {
		return err
	}
	cred, err := requireCred()
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
	endpoint := serviceMCPURL(cred.Hub, host, name)

	// A public service needs no key; everything else gets its own, so revoking
	// one client never cuts off another.
	key, keyID := "", ""
	if !public {
		hostName, _ := os.Hostname()
		label := *client
		if hostName != "" {
			label += " on " + hostName
		}
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
		servers := map[string]any{"mcpServers": map[string]any{name: snippet}}
		if c.json {
			return c.emit(map[string]any{"client": "json", "name": name, "url": endpoint, "key_id": keyID, "mcpServers": servers["mcpServers"]})
		}
		b, _ := json.MarshalIndent(servers, "", "  ")
		fmt.Fprintln(c.stdout, string(b))
		return nil
	case "claude-code":
		args := []string{"mcp", "add", "--transport", "http", name, endpoint}
		if key != "" {
			args = append(args, "--header", "Authorization: Bearer "+key)
		}
		out, err := exec.Command(target.claude, args...).CombinedOutput()
		if err != nil {
			revokeQuietly(cred, keyID)
			msg := strings.TrimSpace(strings.ReplaceAll(string(out), key, "finch_…"))
			if key == "" {
				msg = strings.TrimSpace(string(out))
			}
			return newCLIError(codeUpstream, "claude mcp remove "+name+" && finch connect "+name+" --client claude-code",
				"claude mcp add failed (%v): %s", err, msg)
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

	if c.json {
		p := map[string]any{"client": *client, "name": name, "url": endpoint, "key_id": keyID}
		if configPath != "" {
			p["config"] = configPath
		}
		return c.emit(p)
	}
	where := map[string]string{"claude-code": "Claude Code", "cursor": "Cursor (" + configPath + ")", "codex": "Codex (" + configPath + ")"}[*client]
	c.printf("finch: connected %s to %s → %s\n", name, where, endpoint)
	if keyID != "" {
		c.printf("       using a new key %s (revoke with 'finch keys revoke %s'); the key was not printed\n", keyID, keyID)
	}
	if *client != "claude-code" {
		c.printf("       restart the client (or reload its MCP servers) to pick it up\n")
	}
	return nil
}

func revokeQuietly(cred *cliCred, keyID string) {
	if keyID != "" {
		_, _ = cliRequest("POST", cred.Hub, "/api/cli/keys/revoke", cred.Token, map[string]string{"id": keyID})
	}
}

var tomlHeaderLine = regexp.MustCompile(`^\s*\[`)

// codexServerHeader matches `[mcp_servers.<name>]` and its sub-tables
// (`[mcp_servers.<name>.env]`), bare or quoted, with an optional comment.
func codexServerHeader(name string) *regexp.Regexp {
	q := regexp.QuoteMeta(name)
	return regexp.MustCompile(`^\s*\[\s*mcp_servers\s*\.\s*(?:` + q + `|"` + q + `"|'` + q + `')\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$`)
}

// codexDefinesInline reports whether config.toml defines the server in a form
// line surgery cannot safely replace: a key inside a [mcp_servers] table, or
// an inline mcp_servers = { … } value.
func codexDefinesInline(text, name string) bool {
	q := regexp.QuoteMeta(name)
	inTable := false
	tableHeader := regexp.MustCompile(`^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$`)
	keyLine := regexp.MustCompile(`^\s*(?:` + q + `|"` + q + `"|'` + q + `')\s*=`)
	rootInline := regexp.MustCompile(`^\s*mcp_servers\s*=`)
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

// mergeCodexConfig replaces (or adds) [mcp_servers.<name>] in Codex's
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
	block := "# Managed by 'finch connect " + name + " --client codex'.\n[mcp_servers." + name + "]\nurl = " + u + "\n"
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
