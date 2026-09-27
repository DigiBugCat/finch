package core

// finch CLI setup and control commands. The agent-first flow, which an AI agent
// can run end to end with one human approval in the middle:
//
//	finch login --start --json                     # show the human the link + code
//	finch login --poll --json                      # repeat every interval until exit 0
//	finch add notes --service http://127.0.0.1:8000 --json
//	finch service install --json                   # keep `finch run` running
//	finch test notes --json
//	finch connect notes --client claude-code
//
// Every LATER box can skip the browser by piping a token from a box that is
// already logged in (`finch token` needs a login itself, so it cannot bootstrap
// box #1):
//
//	finch token | ssh newbox "finch login --token -"   # token never hits argv
//
// The CLI token is a long-lived tenant assertion the hub issues; the box
// presents it as `Authorization: Bearer <token>` to /api/cli/*. Exit codes and
// the --json envelope are defined in cli_contract.go.

import (
	"bufio"
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// guideText is `finch guide`: the agent manual, byte for byte the same file
// the site serves at https://finchmcp.com/agents.md. agents.md in this package
// is a copy of web/public/agents.md (go:embed cannot reach outside the
// module), and TestGuideIsAgentsMD fails the build when the two differ.
//
//go:embed agents.md
var guideText string

const cliVersionSchema = cliSchemaVersion

// cliVersionInfo is the stable machine-readable identity of this binary. Keep
// existing JSON field names and meanings backward-compatible; add fields only
// when older consumers can safely ignore them, or increment schema_version.
type cliVersionInfo struct {
	SchemaVersion int    `json:"schema_version"`
	Product       string `json:"product"`
	Version       string `json:"version"`
	OS            string `json:"os"`
	Arch          string `json:"arch"`
}

func currentCLIVersionInfo() cliVersionInfo {
	return cliVersionInfo{
		SchemaVersion: cliVersionSchema,
		Product:       "finch",
		Version:       agentVersion,
		OS:            runtime.GOOS,
		Arch:          runtime.GOARCH,
	}
}

func newVersionFlags() (*flag.FlagSet, *bool) {
	fs := flag.NewFlagSet("version", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs, fs.Bool("json", false, "print stable machine-readable JSON")
}

func versionFlagSet() *flag.FlagSet {
	fs, _ := newVersionFlags()
	return fs
}

func writeCLIVersion(out io.Writer, args []string, info cliVersionInfo) error {
	fs, asJSON := newVersionFlags()
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("version accepts no positional arguments")
	}
	if *asJSON {
		return json.NewEncoder(out).Encode(info)
	}
	_, err := fmt.Fprintf(out, "%s %s (%s/%s)\n", info.Product, info.Version, info.OS, info.Arch)
	return err
}

// cliCred is the saved CLI login: which hub, and the tenant token for it.
type cliCred struct {
	Hub    string `json:"hub"`
	Token  string `json:"token"`
	Email  string `json:"email,omitempty"`  // the signed-in user's email (for display)
	Tenant string `json:"tenant,omitempty"` // the tenant the token acts as (for display)
}

func finchHome() string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".finch")
	}
	return ".finch"
}

func cliCredPath() string { return filepath.Join(finchHome(), "cli.json") }

// cli.json holds the ~30-day TENANT-ADMIN token (finch keys mint, finch token,
// finch domain, finch rm). It is strictly more privileged than the per-box
// refresh token in agent.json, so it goes through the same hardened credential
// path — lstat/symlink/mode checks on read, atomic 0600 write in a 0700
// directory that is refused if group/world-writable.
//
// readCliCred returns (nil, nil) when no login is saved.
func readCliCred() (*cliCred, error) {
	b, err := readCredentialFile(cliCredPath(), credentialStateLimit)
	if err != nil || b == nil {
		return nil, err
	}
	var c cliCred
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// loadCliCred is readCliCred that treats "no login" as an error.
func loadCliCred() (*cliCred, error) {
	c, err := readCliCred()
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, fmt.Errorf("not logged in — run 'finch login'")
	}
	return c, nil
}

func saveCliCred(c *cliCred) error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if len(b) > credentialStateLimit {
		return fmt.Errorf("credential state exceeds %d bytes", credentialStateLimit)
	}
	return writeCredentialFile(cliCredPath(), b)
}

// cliRequest calls /api/cli/* with the bearer token. A non-200 answer or a
// transport failure comes back as *hubError.
func cliRequest(method, hub, path, token string, body any) (map[string]any, error) {
	validatedHub, err := validateHubTransportURL(hub)
	if err != nil {
		return nil, err
	}
	hub = validatedHub
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, hub+path, rdr)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json, text/event-stream")
	client := controlPlaneHTTPClient
	if path == "/api/cli/call" {
		client = relayCallHTTPClient
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, &hubError{Msg: err.Error()}
	}
	defer res.Body.Close()
	raw, err := readBoundedControlResponse(res.Body)
	if err != nil {
		return nil, &hubError{Msg: err.Error()}
	}
	out := decodeHubBody(raw)
	if res.StatusCode != 200 {
		msg := strings.TrimSpace(string(raw))
		if out != nil {
			switch e := out["error"].(type) {
			case string:
				msg = e
			case map[string]any: // a relayed JSON-RPC error object
				if m, ok := e["message"].(string); ok && m != "" {
					msg = m
				}
			}
		}
		if msg == "" {
			msg = http.StatusText(res.StatusCode)
		}
		return nil, &hubError{Status: res.StatusCode, Msg: msg}
	}
	return out, nil
}

// decodeHubBody parses a JSON object body, or — when an MCP server answered
// /api/cli/call with a Streamable-HTTP event stream — the last JSON object in
// its `data:` lines. Returns nil when neither parses.
func decodeHubBody(raw []byte) map[string]any {
	var out map[string]any
	if json.Unmarshal(raw, &out) == nil {
		return out
	}
	var last map[string]any
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 64<<10), len(raw)+1)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var m map[string]any
		if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &m) == nil {
			last = m
		}
	}
	return last
}

// cliApprove clears the pending gate for service `id` via the CLI token.
func cliApprove(cred *cliCred, id string) error {
	_, err := cliRequest("POST", cred.Hub, "/api/cli/approve", cred.Token, map[string]string{"id": id})
	return err
}

// runApprove: finch approve <name> [<name>...] — exits 1 if any approval fails.
func runApprove(c *cli, args []string) error {
	fs := newFlagSet("approve")
	fs.Bool("json", false, "JSON output")
	ids, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return usageError("usage: finch approve <name> [<name>...]")
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	approved := []string{}
	var firstErr error
	for _, id := range ids {
		if err := cliApprove(cred, id); err != nil {
			if firstErr == nil {
				firstErr = hubFailure(err, fmt.Sprintf("approve %q", id), "finch fleet")
			}
			continue
		}
		approved = append(approved, id)
		if !c.json {
			c.printf("finch: approved %q\n", id)
		}
	}
	if firstErr != nil {
		return firstErr
	}
	if c.json {
		return c.emit(map[string]any{"approved": approved})
	}
	return nil
}

// cliSetAuth flips a service's public-relay access mode ("key" | "public").
func cliSetAuth(cred *cliCred, appPath, mode string) error {
	_, err := cliRequest("POST", cred.Hub, "/api/cli/auth", cred.Token, map[string]string{"service": appPath, "mode": mode})
	return err
}

// runAuth: finch auth <name> public|key — set whether the service's public
// endpoint requires a finch_ bearer key. "public" makes it open to anyone.
func runAuth(c *cli, args []string) error {
	fs := newFlagSet("auth")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 2 || (pos[1] != "public" && pos[1] != "key") {
		return usageError("usage: finch auth <name> public|key")
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	if err := cliSetAuth(cred, pos[0], pos[1]); err != nil {
		return hubFailure(err, fmt.Sprintf("set auth for %q", pos[0]), "finch fleet")
	}
	if c.json {
		return c.emit(map[string]any{"service": pos[0], "auth": pos[1]})
	}
	c.printf("finch: %q is now %s\n", pos[0], pos[1])
	return nil
}

// resolveCliToken applies argv-free intake for the CLI token, mirroring
// resolveTicket: "-" reads the token from stdin and FINCH_CLI_TOKEN is the env
// fallback. The CLI token is a ~30-day TENANT-ADMIN assertion, so on argv it
// would be readable via /proc/<pid>/cmdline and persisted into shell history.
//
// Returns the resolved token plus whether it came from argv, so the caller can
// warn about that (still-supported) path.
func resolveCliToken(token string, stdin io.Reader) (string, bool, error) {
	if token == "-" {
		b, err := io.ReadAll(io.LimitReader(stdin, 4096))
		if err != nil {
			return "", false, fmt.Errorf("could not read token from stdin: %w", err)
		}
		tok := strings.TrimSpace(string(b))
		if tok == "" {
			return "", false, fmt.Errorf("--token - given but stdin was empty")
		}
		return tok, false, nil
	}
	if token != "" {
		return token, true, nil
	}
	// Empty also covers "no token at all" — runLogin then falls through to the
	// device flow, which is the most argv-free path of all.
	return strings.TrimSpace(os.Getenv("FINCH_CLI_TOKEN")), false, nil
}

// mcpCall relays one JSON-RPC method to the tenant's service through the hub
// and returns its result, turning every failure — hub status, a JSON-RPC
// error, an unparseable body — into a contract error.
func mcpCall(cred *cliCred, service, method string, params any) (map[string]any, error) {
	body := map[string]any{"service": service, "method": method}
	if params != nil {
		body["params"] = params
	}
	out, err := cliRequest("POST", cred.Hub, "/api/cli/call", cred.Token, body)
	if err != nil {
		return nil, relayCallFailure(cred, service, method, err)
	}
	if out == nil {
		return nil, newCLIError(codeUpstream, "", "%s returned a response that is not JSON-RPC", service)
	}
	if e, ok := out["error"]; ok && e != nil {
		msg := fmt.Sprint(e)
		if m, ok := e.(map[string]any); ok {
			if s, ok := m["message"].(string); ok && s != "" {
				msg = s
			}
		}
		return nil, newCLIError(codeUpstream, "", "%s answered %s with an MCP error: %s", service, method, msg)
	}
	res, ok := out["result"].(map[string]any)
	if !ok {
		return nil, newCLIError(codeUpstream, "", "%s answered %s without a result", service, method)
	}
	return res, nil
}

// relayCallFailure classifies a failed /api/cli/call. The hub relays the
// service's own HTTP status unchanged, so a 401 or 404 may come from the MCP
// server behind finch rather than from the hub. Only a 401 the hub confirms
// (whoami rejects the same login) means the login is gone, and only a service
// missing from the account is NOT_FOUND; every other failure is UPSTREAM and
// names the service.
func relayCallFailure(cred *cliCred, service, method string, err error) error {
	var he *hubError
	if !asHubError(err, &he) || he.Status == 0 {
		return hubFailure(err, service, "finch fleet")
	}
	switch {
	case he.Status == 401:
		if _, werr := cliRequest("GET", cred.Hub, "/api/cli/whoami", cred.Token, nil); werr != nil {
			var we *hubError
			if asHubError(werr, &we) && we.Status == 401 {
				return hubFailure(werr, service, "")
			}
		}
		return newCLIError(codeUpstream, "",
			"%s rejected %s with HTTP 401 (%s): the MCP server behind finch asks for its own credentials. Your finch login is fine; the local server has to accept requests that finch relays",
			service, method, he.Msg)
	case he.Status == 404:
		st, serr := cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
		if serr != nil {
			return hubFailure(serr, service, "finch fleet")
		}
		if !stateHasService(st, service) {
			return newCLIError(codeNotFound, "finch fleet", "no service named %q in this account", service)
		}
		return newCLIError(codeUpstream, "",
			"%s answered %s with HTTP 404 (%s): the local server has no MCP endpoint at /mcp under its --service URL",
			service, method, he.Msg)
	case he.Status == 409 && strings.Contains(he.Msg, "no public hostname"):
		// The hub relays through the account's own hostname (the relay picks
		// the account by host), and this account has none registered.
		return newCLIError(codeNotFound, "finch domain add <host>",
			"cannot reach %s: this finch account has no public address for the hub to route through (%s); add one with 'finch domain add <host>'",
			service, he.Msg)
	case he.Status == 502 && strings.Contains(he.Msg, "local service isn't answering"):
		// The relay is up, and the machine answered, but nothing listens at
		// the service's local URL.
		local := localServiceURL(service)
		if local == "" {
			local = "its local URL"
		}
		return newCLIError(codeUpstream, "",
			"finch is connected, but nothing answers at %s on the machine that publishes %s. Start your server, then run 'finch test %s' again",
			local, service, service)
	case he.Status == 503 && strings.Contains(he.Msg, "offline"):
		return newCLIError(codeUpstream, "finch service status",
			"%s is offline: no machine that publishes it is connected to finch right now (%s). On that machine, check the background service", service, he.Msg)
	case he.Status >= 500:
		return newCLIError(codeUpstream, "finch service status", "%s did not answer through finch: %v", service, he)
	case he.Status == 406 || (he.Status == 400 && strings.Contains(strings.ToLower(he.Msg), "session")):
		// The relay reached the server, which refused the MCP handshake the
		// hub ran (initialize, then the request).
		return newCLIError(codeUpstream, "",
			"the server rejected the MCP handshake: %s answered %s with HTTP %d (%s)",
			service, method, he.Status, he.Msg)
	default:
		return newCLIError(codeUpstream, "", "%s answered %s with HTTP %d: %s", service, method, he.Status, he.Msg)
	}
}

// stateHasService reports whether a GET /api/cli/state answer lists service id.
func stateHasService(st map[string]any, id string) bool {
	services, _ := st["services"].([]any)
	for _, s := range services {
		if m, ok := s.(map[string]any); ok && m["id"] == id {
			return true
		}
	}
	return false
}

// runTest: finch test <name> — list the service's MCP tools through the hub (a
// quick "does my endpoint work" check). Exits non-zero whenever the call fails.
func runTest(c *cli, args []string) error {
	fs := newFlagSet("test")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usageError("usage: finch test <name>")
	}
	app := pos[0]
	cred, err := requireCred()
	if err != nil {
		return err
	}
	res, err := mcpCall(cred, app, "tools/list", nil)
	if err != nil {
		return err
	}
	raw, ok := res["tools"].([]any)
	if !ok {
		return newCLIError(codeUpstream, "", "%s answered tools/list without a tools array", app)
	}
	tools := make([]map[string]any, 0, len(raw))
	for _, t := range raw {
		m, _ := t.(map[string]any)
		name, _ := m["name"].(string)
		desc, _ := m["description"].(string)
		tools = append(tools, map[string]any{"name": name, "description": desc})
	}
	if c.json {
		return c.emit(map[string]any{"service": app, "ok": true, "tools": tools})
	}
	c.printf("%s — %d tool(s):\n", app, len(tools))
	for _, t := range tools {
		c.printf("  • %-16v %v\n", t["name"], t["description"])
	}
	return nil
}

// runCall: finch call <name> <tool> [--args '{...}'] — invoke one tool. A tool
// that reports isError exits 1 like any other failure.
func runCall(c *cli, args []string) error {
	fs := newFlagSet("call")
	argsJSON := fs.String("args", "{}", "the tool's arguments as a `json` object")
	fs.Bool("json", false, "print the tool result as JSON")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 2 {
		return usageError(`usage: finch call <name> <tool> [--args '{"k":"v"}']`)
	}
	var toolArgs map[string]any
	if err := json.Unmarshal([]byte(*argsJSON), &toolArgs); err != nil || toolArgs == nil {
		return usageError("--args must be a JSON object")
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	res, err := mcpCall(cred, pos[0], "tools/call", map[string]any{"name": pos[1], "arguments": toolArgs})
	if err != nil {
		return err
	}
	texts := []string{}
	if content, ok := res["content"].([]any); ok {
		for _, item := range content {
			if m, ok := item.(map[string]any); ok && m["type"] == "text" {
				texts = append(texts, fmt.Sprint(m["text"]))
			}
		}
	}
	if isErr, _ := res["isError"].(bool); isErr {
		return newCLIError(codeUpstream, "", "tool %s on %s failed: %s", pos[1], pos[0], strings.Join(texts, " "))
	}
	if c.json {
		return c.emit(map[string]any{"service": pos[0], "tool": pos[1], "result": res})
	}
	if len(texts) > 0 {
		for _, t := range texts {
			c.printf("%s\n", t)
		}
		return nil
	}
	b, _ := json.Marshal(res)
	c.printf("%s\n", b)
	return nil
}

// runDomain: finch domain [ls|add|rm] — manage custom hostnames mapped to this
// tenant. The hub enforces ownership and, for BYO domains, returns the DNS CNAME
// instruction the operator must configure before traffic becomes live.
func runDomain(c *cli, args []string) error {
	fs := newFlagSet("domain")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	sub := "ls"
	if len(pos) > 0 {
		sub, pos = pos[0], pos[1:]
	}
	switch sub {
	case "ls", "list", "add", "rm", "remove", "delete":
	default:
		return usageError("usage: finch domain [ls | add <hostname> | rm <hostname>]")
	}
	if sub != "ls" && sub != "list" && len(pos) != 1 {
		return usageError("usage: finch domain %s <hostname>", sub)
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	switch sub {
	case "ls", "list":
		out, err := cliRequest("GET", cred.Hub, "/api/cli/hostnames", cred.Token, nil)
		if err != nil {
			return hubFailure(err, "list hostnames", "")
		}
		hostnames, _ := out["hostnames"].([]any)
		if hostnames == nil {
			hostnames = []any{}
		}
		if c.json {
			return c.emit(map[string]any{"hostnames": hostnames})
		}
		if len(hostnames) == 0 {
			c.printf("no custom hostnames — 'finch domain add <hostname>' adds one\n")
			return nil
		}
		for _, h := range hostnames {
			c.printf("  %v\n", h)
		}
	case "add":
		out, err := cliRequest("POST", cred.Hub, "/api/cli/hostnames", cred.Token, map[string]string{"hostname": pos[0]})
		if err != nil {
			return hubFailure(err, "add hostname "+pos[0], "")
		}
		if c.json {
			return c.emit(out)
		}
		c.printf("finch: added %v hostname %v\n", out["tier"], out["hostname"])
		if instr, _ := out["instructions"].(string); instr != "" {
			c.printf("%s\n", instr)
		}
		if ssl, ok := out["ssl"]; ok && ssl != nil {
			c.printf("ssl: %v\n", ssl)
		}
	default: // rm
		if _, err := cliRequest("DELETE", cred.Hub, "/api/cli/hostnames", cred.Token, map[string]string{"hostname": pos[0]}); err != nil {
			return hubFailure(err, "remove hostname "+pos[0], "finch domain ls")
		}
		if c.json {
			return c.emit(map[string]any{"removed": pos[0]})
		}
		c.printf("finch: removed hostname %s\n", pos[0])
	}
	return nil
}

// mintClientKey mints a finch_ key scoped to one service (or every service).
func mintClientKey(cred *cliCred, label string, scope any) (map[string]any, error) {
	out, err := cliRequest("POST", cred.Hub, "/api/cli/keys", cred.Token, map[string]any{"label": label, "scope": scope})
	if err != nil {
		return nil, hubFailure(err, "mint key", "finch fleet")
	}
	if key, _ := out["key"].(string); !strings.HasPrefix(key, "finch_") {
		return nil, newCLIError(codeUpstream, "", "mint key: the hub did not return a finch_ key")
	}
	return out, nil
}

// runKeys: finch keys [list|mint|revoke] — manage the client finch_ keys that
// callers present to reach your services.
func runKeys(c *cli, args []string) error {
	fs := newFlagSet("keys")
	all := fs.Bool("all", false, "mint: the key reaches every service")
	service := fs.String("service", "", "mint: the service (`name`) the key reaches")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	sub := "list"
	if len(pos) > 0 {
		sub, pos = pos[0], pos[1:]
	}
	var scope any
	switch sub {
	case "list":
		if len(pos) != 0 {
			return usageError("usage: finch keys list")
		}
	case "mint":
		if len(pos) != 1 {
			return usageError("usage: finch keys mint <label> (--service <name> | --all)")
		}
		switch {
		case *all && *service != "":
			return usageError("keys mint: pass --service or --all, not both")
		case *all:
			scope = map[string]bool{"all": true}
		case *service != "":
			scope = map[string][]string{"services": {*service}}
		default:
			return usageError("keys mint: scope the key with --service <name> (or --all)")
		}
	case "revoke":
		if len(pos) != 1 {
			return usageError("usage: finch keys revoke <id>")
		}
	default:
		return usageError("usage: finch keys [list | mint <label> --service <name> | revoke <id>]")
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	switch sub {
	case "list":
		st, err := cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
		if err != nil {
			return hubFailure(err, "list keys", "")
		}
		keys, _ := st["keys"].([]any)
		if keys == nil {
			keys = []any{}
		}
		if c.json {
			return c.emit(map[string]any{"keys": keys})
		}
		if len(keys) == 0 {
			c.printf("no keys — 'finch keys mint <label> --service <name>' creates one\n")
			return nil
		}
		for _, k := range keys {
			m, _ := k.(map[string]any)
			c.printf("  %-12v %v\n", m["id"], m["label"])
		}
	case "mint":
		out, err := mintClientKey(cred, pos[0], scope)
		if err != nil {
			return err
		}
		if c.json {
			return c.emit(out)
		}
		c.printf("%v\n", out["key"]) // the finch_ key — shown once
	case "revoke":
		if _, err := cliRequest("POST", cred.Hub, "/api/cli/keys/revoke", cred.Token, map[string]string{"id": pos[0]}); err != nil {
			return hubFailure(err, "revoke key "+pos[0], "finch keys list")
		}
		if c.json {
			return c.emit(map[string]any{"revoked": pos[0]})
		}
		c.printf("finch: revoked key %s\n", pos[0])
	}
	return nil
}

// runFleet: finch fleet [--json] — list this tenant's services + state.
func runFleet(c *cli, args []string) error {
	fs := newFlagSet("fleet")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 0 {
		return usageError("usage: finch fleet [--json]")
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	st, err := cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
	if err != nil {
		return hubFailure(err, "fleet", "")
	}
	apps, _ := st["services"].([]any)
	if apps == nil {
		apps = []any{}
	}
	local := localForwardAll()
	for _, a := range apps {
		if m, ok := a.(map[string]any); ok {
			if id, _ := m["id"].(string); id != "" {
				m["url"] = serviceURLFromState(cred.Hub, st, id, local[id])
			}
		}
	}
	if c.json {
		return c.emit(map[string]any{"services": apps})
	}
	if len(apps) == 0 {
		c.printf("no services yet — 'finch add <name> --service <url>'\n")
		return nil
	}
	for _, a := range apps {
		m, _ := a.(map[string]any)
		c.printf("  %-16v %-8v %v\n", m["id"], m["state"], m["url"])
	}
	return nil
}

// serviceURLFromState is the public URL of service id, from a GET
// /api/cli/state answer: /<id>/mcp for an MCP server, /<id>/ when finch
// forwards every path.
func serviceURLFromState(hub string, st map[string]any, id string, forwardAll bool) string {
	host, _ := st["host"].(string)
	serviceBase, _ := st["serviceBase"].(string)
	u := serviceMCPURL(hub, serviceBase, host, id)
	if forwardAll {
		u = strings.TrimSuffix(u, "mcp")
	}
	return u
}

// localForwardAll maps each service this machine's finch.yml publishes to its
// forward_all setting (empty when there is no finch.yml).
func localForwardAll() map[string]bool {
	out := map[string]bool{}
	if p := findManifest(); p != "" {
		host, _ := os.Hostname()
		if cfg, err := loadConfig(p, host); err == nil {
			for _, ing := range cfg.Ingress {
				out[ing.AppPath] = ing.ForwardAll
			}
		}
	}
	return out
}

// localServiceURL is the local URL this machine's finch.yml forwards service
// id to, or "" when this machine does not publish it.
func localServiceURL(id string) string {
	if p := findManifest(); p != "" {
		host, _ := os.Hostname()
		if cfg, err := loadConfig(p, host); err == nil {
			for _, ing := range cfg.Ingress {
				if ing.AppPath == id {
					return ing.Service
				}
			}
		}
	}
	return ""
}

// runRevokeTokens: finch revoke-tokens — de-authorize every CLI login (incl. this).
func runRevokeTokens(c *cli, args []string) error {
	fs := newFlagSet("revoke-tokens")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 0 {
		return usageError("usage: finch revoke-tokens")
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	if _, err := cliRequest("POST", cred.Hub, "/api/cli/revoke-tokens", cred.Token, struct{}{}); err != nil {
		return hubFailure(err, "revoke tokens", "")
	}
	if c.json {
		return c.emit(map[string]any{"revoked": true})
	}
	c.printf("finch: revoked all CLI tokens — every logged-in machine (including this one) must run 'finch login' again\n")
	return nil
}

// loginHeredocDelimiter terminates the token heredoc in loginCommand. It is
// quoted at the use site (<<'...') so the shell performs NO expansion on the
// body: a token containing $, `, or \ is delivered byte-for-byte. The body
// cannot terminate itself early either — a heredoc ends only on a line that is
// exactly the delimiter, and the token occupies one whole line with no newline
// in it (it is a bearer token: it travels in an Authorization header, where a
// newline is not representable).
const loginHeredocDelimiter = "FINCH_CLI_TOKEN"

// loginCommand renders a copy-pasteable `finch login` that keeps the ~30-day
// tenant-admin token OFF argv, for `finch token --login`. A heredoc delivers
// the token on the login process's STDIN (resolveCliToken reads "-" from
// stdin), so nothing but the hub is ever visible in the process table.
func loginCommand(hub, token string) string {
	return fmt.Sprintf("finch login --hub %s --token - <<'%s'\n%s\n%s",
		hub, loginHeredocDelimiter, token, loginHeredocDelimiter)
}

// runToken: finch token [--json] [--login] — an authed box mints a FRESH CLI
// token, for non-interactive provisioning of a new box:
//
//	finch token | ssh newbox "finch login --token -"
func runToken(c *cli, args []string) error {
	fs := newFlagSet("token")
	fs.Bool("json", false, "print {token,hub,expiresAt} as JSON")
	asLogin := fs.Bool("login", false, "print a ready-to-run 'finch login' command instead of just the token (it feeds the token on stdin, never on the command line)")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 0 {
		return usageError("usage: finch token [--json | --login]")
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	out, err := cliRequest("POST", cred.Hub, "/api/cli/token", cred.Token, struct{}{})
	if err != nil {
		return hubFailure(err, "mint token", "")
	}
	token, _ := out["token"].(string)
	hub, _ := out["hub"].(string)
	if token == "" {
		return newCLIError(codeUpstream, "", "mint token: the hub returned no token")
	}
	switch {
	case c.json:
		return c.emit(out)
	case *asLogin:
		c.printf("%s\n", loginCommand(hub, token))
	default:
		c.printf("%s\n", token) // bare token, for `finch token | ssh host "finch login --token -"`
	}
	return nil
}

type ingressStatus struct {
	AppPath string `json:"app_path"`
	Service string `json:"service"`
	// URL is the public URL, known when the hub answered.
	URL string `json:"url,omitempty"`
}

// runStatus: finch status [--json] — login, finch.yml, and the background
// service at a glance. It reports rather than fails: not being logged in is a
// normal answer ("loggedIn": false, exit 0), so an agent can read one payload
// and decide which step to start from.
func runStatus(c *cli, args []string) error {
	fs := newFlagSet("status")
	fs.Bool("json", false, "JSON output")
	configPath := fs.String("config", defaultManifestPath(), "the `finch.yml` to summarize")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 0 {
		return usageError("usage: finch status [--json]")
	}

	loggedIn, hubReachable := false, true
	hub, tenant, account := "", "", ""
	cred, credErr := readCliCred()
	if credErr != nil {
		return newCLIError(codeInternal, "", "reading %s: %v", cliCredPath(), credErr)
	}
	// A started login blocks the saved one (requireCred), so while it is
	// pending the box reads as not logged in: the next step is --poll.
	pending, _ := readPendingLogin()
	loginPending := pending != nil && !pending.expired()
	if loginPending {
		hub = pending.Hub
		cred = nil
	}
	if cred != nil && cred.Token != "" {
		hub, tenant, account = cred.Hub, cred.Tenant, cred.Email
		who, err := cliRequest("GET", cred.Hub, "/api/cli/whoami", cred.Token, nil)
		var he *hubError
		switch {
		case err == nil:
			loggedIn = true
			if t, _ := who["tenant"].(string); t != "" {
				tenant = t
			}
		case asHubError(err, &he) && he.Status == 401:
			loggedIn = false // expired or revoked
		default:
			// The hub is unreachable: the saved login is unverified, not invalid.
			loggedIn, hubReachable = true, false
		}
	}

	ingress := []ingressStatus{}
	cfgPath := ""
	hostName, _ := os.Hostname()
	if cfg, err := loadConfig(*configPath, hostName); err == nil {
		cfgPath = *configPath
		if hub == "" {
			hub = cfg.Hub
		}
		var st map[string]any
		if loggedIn && hubReachable && len(cfg.Ingress) > 0 {
			st, _ = cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
		}
		for _, ing := range cfg.Ingress {
			is := ingressStatus{AppPath: ing.AppPath, Service: ing.Service}
			if st != nil && stateHasService(st, ing.AppPath) {
				is.URL = serviceURLFromState(cred.Hub, st, ing.AppPath, ing.ForwardAll)
			}
			ingress = append(ingress, is)
		}
	}
	svc := currentServiceStatus()

	if c.json {
		payload := map[string]any{
			// logged_in is the snake_case name every other field uses;
			// loggedIn stays for agents written against 1.7.
			"logged_in":     loggedIn,
			"loggedIn":      loggedIn,
			"login_pending": loginPending,
			"ingress":       ingress,
			"service":       svc.payload(),
			"version":       agentVersion,
		}
		if cred != nil && cred.Token != "" {
			// Only meaningful when there was a saved login to verify.
			payload["hub_reachable"] = hubReachable
		}
		for k, v := range map[string]string{"hub": hub, "tenant": tenant, "account": account, "config": cfgPath} {
			if v != "" {
				payload[k] = v
			}
		}
		return c.emit(payload)
	}
	switch {
	case loggedIn && !hubReachable:
		c.printf("logged in to %s (could not reach the hub to verify)\n", hub)
	case loggedIn && account != "":
		c.printf("logged in as %s at %s\n", account, hub)
	case loggedIn:
		c.printf("logged in at %s\n", hub)
	case loginPending:
		c.printf("login waiting for approval — open %s and confirm code %s, then run 'finch login --poll'\n", pending.VerificationURIComplete, pending.UserCode)
	default:
		c.printf("not logged in — run 'finch login'\n")
	}
	if cfgPath != "" {
		c.printf("this machine publishes %d service(s) (%s):\n", len(ingress), cfgPath)
		for _, ing := range ingress {
			if ing.URL != "" {
				c.printf("  • %-16s %s  →  %s\n", ing.AppPath, ing.URL, ing.Service)
			} else {
				c.printf("  • %-16s → %s\n", ing.AppPath, ing.Service)
			}
		}
	} else {
		c.printf("no services on this machine yet — 'finch add <name> --service <url>' publishes one\n")
	}
	c.printf("background service (%s): %s\n", svc.Manager, svc.describe())
	return nil
}

// runAdd: finch add <name> --service <url> [--public] [--forward-all] [--config finch.yml] [--json]
//
// One-shot convenience for a logged-in machine: it enrolls the service via the
// CLI token, saves the machine-side refresh credential (so `finch run` resumes
// without a ticket), adds the service to finch.yml, and — with --public —
// opens the endpoint to callers without a key.
//
// Run again for a service this machine already publishes, it updates that
// service's local URL (and --public / --forward-all when given) in place: the
// service keeps its name, URL and credential, and nothing new is enrolled.
func runAdd(c *cli, args []string) error {
	fs := newFlagSet("add")
	service := fs.String("service", "", "the `url` of the local server, for example http://127.0.0.1:8000 (required)")
	configPath := fs.String("config", defaultManifestPath(), "the `finch.yml` to add the service to")
	public := fs.Bool("public", false, "let anyone call it, with no finch_ key")
	forwardAll := fs.Bool("forward-all", false, "forward every path (a web app or REST API), not just /<name>/mcp")
	fs.Bool("json", false, "print the result as JSON")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 || *service == "" {
		return usageError("usage: finch add <name> --service <url> [--public] [--forward-all]  (<name> becomes https://<your-address>/<name>/)")
	}
	wantPath := pos[0]
	if err := validateServiceName(wantPath); err != nil {
		return err
	}
	if err := checkServiceFlag(*service, wantPath); err != nil {
		return err
	}
	if err := validateManifestMutationTarget(*configPath); err != nil {
		return newCLIError(codeInternal, "", "cannot safely update %s: %v", *configPath, err)
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	var fwd *bool
	if set["forward-all"] {
		fwd = forwardAll
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	st, err := cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
	if err != nil {
		return hubFailure(err, "add "+wantPath, "")
	}

	host, _ := os.Hostname()
	box, credDir := addPaths(*configPath, host)
	id := slugifyServiceName(wantPath)

	// Already published from this machine: update it in place.
	if rule := localRule(*configPath, host, id); rule != nil && stateHasService(st, id) {
		if statePath := filepath.Join(credDir, id+".json"); !fileExists(statePath) {
			return newCLIError(codeInternal, "",
				"%q is in %s, but its saved credential (%s) is missing, so this machine cannot publish it. Remove it with 'finch rm %s', then add it again",
				id, *configPath, statePath, id)
		}
		return updateService(c, cred, st, *configPath, rule, *service, fwd, *public)
	}
	if hubServiceHasMachines(st, id) {
		// Another machine publishes it (this one has no entry for it): adding
		// it here would enroll a second, differently named service.
		return newCLIError(codeUsage, "finch fleet",
			"a service named %q already exists in your account, published from another machine. Pick another name, or remove it first with 'finch rm %s'", id, id)
	}
	// A stale entry for a service the account no longer has (removed from
	// another machine) is replaced by the new enrollment below.

	// Enroll the service via the CLI token. The hub turns the name into the
	// service id (lowercase, dashes); use THAT as the name so the URL matches.
	out, err := cliRequest("POST", cred.Hub, "/api/cli/enroll", cred.Token, map[string]string{"name": wantPath})
	if err != nil {
		return hubFailure(err, "add "+wantPath, "")
	}
	id, _ = out["id"].(string)
	ticket, _ := out["ticket"].(string)
	pubURL, _ := out["url"].(string)
	if id == "" || ticket == "" {
		return newCLIError(codeUpstream, "", "add %s: the hub returned no service id or ticket", wantPath)
	}
	if err := validateServiceID(id); err != nil {
		return newCLIError(codeUpstream, "", "add %s: the hub returned an unsafe service name: %v", wantPath, err)
	}
	if id != wantPath {
		if id == slugifyServiceName(wantPath) {
			c.printf("finch: note: service names are lowercase letters, digits and dashes, so %q is published as %q\n", wantPath, id)
		} else {
			c.printf("finch: note: %q already exists in your account, so this one is published as %q\n", wantPath, id)
		}
	}

	// Trade the ticket for a saved machine credential now (so the ticket never
	// lands in the manifest), then add the service to finch.yml.
	statePath := filepath.Join(credDir, id+".json")
	if _, _, err := enrollToState(cred.Hub, box, ticket, statePath); err != nil {
		var pe *persistError
		if errors.As(err, &pe) {
			// The join succeeded: the hub has the service and the ticket is
			// spent. Retrying `finch add` would register "<name>-2" beside it.
			return newCLIError(codeInternal, "finch rm "+id,
				"finch registered %q, but saving its credential on this machine failed (%v). Nothing was added to %s. Make %s writable, then run 'finch rm %s' and 'finch add %s --service %s' again",
				id, pe, *configPath, filepath.Dir(pe.Path), id, wantPath, *service)
		}
		return newCLIError(codeUpstream, "", "add %s: %v", id, err)
	}
	if err := appendIngressOpts(*configPath, cred.Hub, id, *service, box, fwd); err != nil {
		return newCLIError(codeInternal, "", "could not write %s: %v", *configPath, err)
	}
	auth := "key"
	if *public {
		if err := cliSetAuth(cred, id, "public"); err != nil {
			e := hubFailure(err, "make "+id+" public", "")
			if ce, ok := e.(*cliError); ok && ce.Next == "" {
				ce.Next = "finch auth " + id + " public"
			}
			return e
		}
		auth = "public"
	}
	if *forwardAll && pubURL != "" {
		pubURL = strings.TrimSuffix(pubURL, "mcp")
	}
	if c.json {
		return c.emit(map[string]any{"app_path": id, "service": *service, "url": pubURL, "config": *configPath, "auth": auth, "forward_all": *forwardAll})
	}
	c.printf("finch: added %q → %s\n", id, *service)
	if pubURL != "" {
		c.printf("       public URL: %s\n", pubURL)
	}
	if *forwardAll {
		c.printf("       forwards every path under /%s/\n", id)
	}
	if auth == "public" {
		c.printf("       access: public — anyone with the URL can call it\n")
	} else {
		c.printf("       access: callers need a finch_ key — 'finch connect %s --client claude-code' (or cursor, codex, json) sets one up\n", id)
	}
	c.printf("       next: 'finch service install' keeps it running (or 'finch run' in the foreground)\n")
	return nil
}

// updateService is `finch add` for a service this machine already publishes:
// point it at the new local URL (and apply --forward-all / --public) without
// enrolling anything. The running service reads finch.yml only at start, so
// a managed one is restarted.
func updateService(c *cli, cred *cliCred, st map[string]any, configPath string, rule *ingress, service string, fwd *bool, public bool) error {
	id := rule.AppPath
	before := rule.Service
	if err := appendIngressOpts(configPath, cred.Hub, id, service, "", fwd); err != nil {
		return newCLIError(codeInternal, "", "could not write %s: %v", configPath, err)
	}
	forwardAll := rule.ForwardAll
	if fwd != nil {
		forwardAll = *fwd
	}
	auth := "key"
	if serviceIsPublic(st, id) {
		auth = "public"
	}
	if public && auth != "public" {
		if err := cliSetAuth(cred, id, "public"); err != nil {
			e := hubFailure(err, "make "+id+" public", "")
			if ce, ok := e.(*cliError); ok && ce.Next == "" {
				ce.Next = "finch auth " + id + " public"
			}
			return e
		}
		auth = "public"
	}
	restarted := false
	if s := currentServiceStatus(); s.Running {
		if err := restartManagedService(); err != nil {
			return newCLIError(codeInternal, "finch service install", "updated %s in %s, but restarting the background service failed: %v", id, configPath, err)
		}
		restarted = true
	}
	pubURL := serviceURLFromState(cred.Hub, st, id, forwardAll)
	if c.json {
		return c.emit(map[string]any{"app_path": id, "service": service, "url": pubURL, "config": configPath, "auth": auth, "forward_all": forwardAll, "updated": true, "restarted": restarted})
	}
	if before != service {
		c.printf("finch: updated %q → %s (was %s)\n", id, service, before)
	} else {
		c.printf("finch: %q already forwards to %s\n", id, service)
	}
	c.printf("       public URL: %s\n", pubURL)
	if restarted {
		c.printf("       restarted the background service to apply it\n")
	} else {
		c.printf("       next: 'finch service install' (or restart 'finch run') to apply it\n")
	}
	return nil
}

// validateServiceName checks a <name> from the command line and explains the
// rule when it fails.
func validateServiceName(name string) error {
	if validateServiceID(name) == nil {
		return nil
	}
	return newCLIError(codeUsage, "finch help",
		"%q cannot be a service name: use letters, digits and '-' (also '_' or '.' between them), at most %d characters, for example notes or team-wiki",
		name, maxAppPathLength)
}

// checkServiceFlag validates --service, suggesting the fix for the common
// mistake of leaving out the scheme.
func checkServiceFlag(service, name string) error {
	if _, err := parseUpstreamTransportURL(service); err == nil {
		return nil
	}
	if !strings.Contains(service, "://") {
		fixed := "http://" + strings.TrimPrefix(service, "//")
		if _, err := parseUpstreamTransportURL(fixed); err == nil {
			return newCLIError(codeUsage, "finch add "+name+" --service "+fixed,
				"--service needs a full URL — did you mean %s?", fixed)
		}
	}
	return newCLIError(codeUsage, "finch help",
		"--service %q is not a URL finch can forward to: use the local server's full URL, like http://127.0.0.1:8000 (plain http only for this machine or a container name; anything else needs https)", service)
}

// slugifyServiceName is the service id the hub makes from a name (tenant-do
// slugify): lowercase, every run of other characters one '-', trimmed.
func slugifyServiceName(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > maxAppPathLength {
		s = strings.TrimRight(s[:maxAppPathLength], "-")
	}
	if s == "" {
		s = "service"
	}
	return s
}

// localRule returns this machine's finch.yml rule for service id, or nil.
func localRule(configPath, host, id string) *ingress {
	cfg, err := loadConfig(configPath, host)
	if err != nil {
		return nil
	}
	for i := range cfg.Ingress {
		if cfg.Ingress[i].AppPath == id {
			return &cfg.Ingress[i]
		}
	}
	return nil
}

// hubServiceHasMachines reports whether the account's service id has at least
// one machine registered.
func hubServiceHasMachines(st map[string]any, id string) bool {
	services, _ := st["services"].([]any)
	for _, s := range services {
		if m, ok := s.(map[string]any); ok && m["id"] == id {
			boxes, _ := m["boxes"].([]any)
			return len(boxes) > 0
		}
	}
	return false
}

func serviceIsPublic(st map[string]any, id string) bool {
	services, _ := st["services"].([]any)
	for _, s := range services {
		if m, ok := s.(map[string]any); ok && m["id"] == id {
			return m["auth"] == "public"
		}
	}
	return false
}

// runEnroll: finch enroll <name> --ticket - [--hub …] [--box …] [--credentials-dir …]
//
// The one-time, imperative enrollment step for a box that has a ticket but no
// CLI login: it trades a one-shot join ticket for the long-lived box-side
// refresh credential and writes it to <credentials-dir>/<service>.json, where
// `finch run` resumes it ticketless. A logged-in box uses `finch add` instead.
func runEnroll(c *cli, args []string) error {
	fs := newFlagSet("enroll")
	ticket := fs.String("ticket", "", "the one-time enrollment `ticket` (required; '-' reads it from stdin, or set FINCH_TICKET)")
	hub := fs.String("hub", "https://finchmcp.com", "the finch hub `url`")
	host, _ := os.Hostname()
	defBox, defCredDir := addPaths("finch.yml", host)
	box := fs.String("box", defBox, "this machine's `name`")
	credDir := fs.String("credentials-dir", defCredDir, "the `directory` the credential is saved in")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	ticketVal, err := resolveTicketFrom(*ticket, c.stdin)
	if err != nil {
		return usageError("%v", err)
	}
	if len(pos) != 1 || ticketVal == "" {
		return usageError("usage: finch enroll <name> --ticket -   (reads the ticket from stdin, or set FINCH_TICKET)")
	}
	appPath := pos[0]
	if err := validateServiceID(appPath); err != nil {
		return usageError("%v", err)
	}
	id, statePath, err := enrollWithTicket(*hub, *box, ticketVal, expandHome(*credDir))
	if err != nil {
		var pe *persistError
		if errors.As(err, &pe) {
			// The join succeeded: the hub registered the box and the one-shot
			// ticket is spent, so re-running this command cannot succeed.
			return newCLIError(codeInternal, "",
				"finch registered %q, but saving its credential on this machine failed (%v). The ticket is used up: make %s writable (or pick another --credentials-dir), remove the service with 'finch rm %s' from a logged-in machine, and enroll again with a new ticket",
				pe.Service, pe, filepath.Dir(pe.Path), pe.Service)
		}
		return newCLIError(codeUpstream, "", "enroll failed: %v", err)
	}
	if c.json {
		return c.emit(map[string]any{"app_path": id, "credential": statePath})
	}
	if id != appPath {
		c.printf("finch: note: %q was registered as %q (host-safe slug)\n", appPath, id)
	}
	c.printf("finch: enrolled %q — credential saved to %s\n", id, statePath)
	c.printf("       add it to finch.yml and run 'finch run':\n")
	c.printf("         ingress:\n           - app_path: %s\n             service: http://127.0.0.1:8000\n", id)
	return nil
}

// enrollWithTicket joins FIRST so the credential is named by the hub's
// slugified service id: the relay resolves the service by THAT id, so
// `finch enroll Printer` must land as printer.json, not the raw argument, or
// `finch run` never finds it.
func enrollWithTicket(hub, box, ticket, credDir string) (id, statePath string, err error) {
	hub, err = validateHubTransportURL(hub)
	if err != nil {
		return "", "", err
	}
	jr, err := join(hub, ticket, box)
	if err != nil {
		return "", "", err
	}
	statePath = filepath.Join(credDir, jr.Service+".json")
	if _, err := persistJoin(hub, jr, statePath); err != nil {
		return "", "", err
	}
	return jr.Service, statePath, nil
}

// resolveTicketFrom applies argv-free intake for an enrollment ticket: "-"
// reads it from stdin and FINCH_TICKET from the env — so a one-shot ticket
// (which mints the long-lived refresh token) need not land on the process
// table / shell history. A literal value passes through unchanged.
func resolveTicketFrom(ticket string, stdin io.Reader) (string, error) {
	if ticket == "-" {
		b, err := io.ReadAll(io.LimitReader(stdin, 4096))
		if err != nil {
			return "", fmt.Errorf("could not read ticket from stdin: %w", err)
		}
		ticket = strings.TrimSpace(string(b))
		if ticket == "" {
			return "", fmt.Errorf("--ticket - given but stdin was empty")
		}
	}
	if ticket == "" {
		ticket = strings.TrimSpace(os.Getenv("FINCH_TICKET"))
	}
	return ticket, nil
}

// resolveTicket is resolveTicketFrom on os.Stdin for the relay agent's
// `finch join --ticket -`, where a bad ticket is fatal.
func resolveTicket(ticket string) string {
	t, err := resolveTicketFrom(ticket, os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(exitUsage)
	}
	return t
}
