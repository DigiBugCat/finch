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
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// guideText is `finch guide`: a complete, self-contained operating manual an AI
// agent can read once and then drive finch end to end. It mirrors
// https://finchmcp.com/agents.md. (No backticks: this is a Go raw string.)
const guideText = `# Using finch (agent guide)

finch publishes a LOCAL HTTP service (an MCP server, a website, any HTTP or
WebSocket app) at a public https URL with NO open ports: this machine dials OUT
to the finch hub. You drive it from this CLI on macOS or Linux. Every command
below takes --json; decide what to do from exit codes and JSON, not prose.
The same manual is hosted at https://finchmcp.com/agents.md.

## Before you start
  finch status --json
  no "schema_version":1, or "version" below 1.7.0
                        -> an older finch answered. Install 1.7.0 or later:
                           curl -fsSL https://finchmcp.com/install | sh
                           If it warns that an older finch on PATH
                           shadows the new one, run the full path it prints.
  "loggedIn": true      -> skip step 1
  "login_pending": true -> a started login awaits approval: poll (step 1)
  "service"             -> whether the background service is installed / running
  "ingress"             -> what this machine already publishes

## 1. Log in (the only human step)
  finch login --start --json
  -> {"schema_version":1,"user_code":"ABCD-EFGH","verification_uri_complete":"https://...","expires_in":600,"interval":3}
  Show the human the link and the code. Then, every <interval> seconds:
  finch login --poll --json
  -> exit 10 {"status":"pending"}    keep polling
     exit 11 {"status":"expired"}    run 'finch login --start' again
     exit 0  {"status":"approved"}   done: the credential is saved
  Until the poll resolves, every other command answers APPROVAL_PENDING (exit
  10), even over an older saved login. 'finch login --cancel' drops the
  started login and goes back to the saved one.
  Never print, log, or paste tokens or keys.

## 2. Publish the service
  finch add notes --service http://127.0.0.1:8000 --json
  -> {"url":"https://<slug>.finchmcp.com/notes/mcp", ...}
  Add --public only if the human asked for an open endpoint (no key needed).

## 3. Keep it running
  finch service install --json    launchd on macOS, systemd --user on Linux
  finch service status --json     -> {"installed":true,"running":true,...}
  Run install again after every later 'finch add': the service reads finch.yml
  only when it starts, and install restarts it. install exits 1 if 'finch run'
  does not come up; the message says why (for example a 'finch run' already
  serving in a terminal, which must be stopped). On Linux, "linger": false
  means the human should run 'sudo loginctl enable-linger <user>' (never run
  sudo yourself). ('finch run' serves in the foreground instead.)

## 4. Check it
  finch test notes --json         exit 0 = the MCP server answered tools/list
  UPSTREAM: retry up to 3 times, 5s apart (the relay may still be connecting).
  If the message says the service is reachable but rejected finch's one-shot
  request (HTTP 406, or 400 Missing session ID), the server needs a full MCP
  session that 'finch test' does not do yet: do not retry, go on to step 5 and
  ask the human to confirm it from the client. A 401/404 in the message came
  from their MCP server, not from finch.

## 5. Connect it to an MCP client
  finch connect notes --client claude-code     (or cursor | codex)
  Mints a finch_ key for that client and writes it into the client's config
  without printing it. Running it again replaces the entry and revokes the key
  it used. --client json prints an mcpServers snippet instead (the only mode
  that shows the key).

## Exit codes
  0 ok | 1 error | 2 usage | 10 waiting for approval | 11 expired | 12 not logged in
With --json, errors go to stderr as
  {"schema_version":1,"error":{"code":"NOT_LOGGED_IN","message":"...","next":"finch login --start"}}
Codes: NOT_LOGGED_IN, APPROVAL_PENDING, EXPIRED, NOT_FOUND, UPSTREAM, USAGE,
INTERNAL. When "next" is present, run it.

## More
  finch fleet --json                          every service + its state
  finch call notes <tool> --args '{"k":"v"}'  invoke one tool
  finch keys list | keys mint <label> --service notes | keys revoke <id>
  finch auth notes public|key                 open a service, or require a key again
  finch rm notes                              remove a service
  finch service uninstall                     stop the background service
  finch help                                  flag-level reference
`

// usageText is `finch help`.
const usageText = `finch — publish a local MCP server (or any HTTP app) at a public https URL from
macOS or Linux. This machine dials OUT to the finch hub: nothing listens and no
ports open.

Agent flow (every step takes --json; 'finch guide' explains it):
  finch status --json                                  what is set up already?
  finch login --start --json                           show the human the link + code
  finch login --poll --json                            repeat every <interval>s until exit 0
  finch add <name> --service <url> [--public] --json   publish it; prints the public URL
  finch service install --json                         keep 'finch run' running
  finch test <name> --json                             does it answer? (non-zero if not)
  finch connect <name> --client claude-code|cursor|codex|json

Commands:
  login [--hub URL]                  Log in and wait for approval (link + code, any device)
  login --start | --poll             Two-step login: exit 10 pending, 11 expired, 0 approved
  login --cancel                     Drop a started login; the saved login works again
  login --token -                    Log in with a token on stdin (or FINCH_CLI_TOKEN)
  add <name> --service <url>         Enroll a service and add it to finch.yml [--public]
  run [--config finch.yml]           Serve every finch.yml rule in the foreground
  service install|uninstall|status   Run 'finch run' as a login service (launchd / systemd --user)
  connect <name> --client <client>   Wire a service into claude-code, cursor, codex, or print json
  test <name>                        List the service's MCP tools through the hub
  call <name> <tool> [--args '{}']   Invoke one tool through the hub
  status                             Login, finch.yml and background service at a glance
  fleet  (alias: ls)                 Every service in the account + its state
  keys [list | mint <label> --service <name> | revoke <id>]   Client finch_ keys
  auth <name> public|key             Open a service to anyone, or require a finch_ key
  rm <name>                          Remove a service
  approve <name>                     Clear a pending gate (only needed when not logged in)
  domain [ls | add <host> | rm <host>]   Custom hostnames
  token [--login]                    Mint a CLI token for another box (pipe it; never argv)
  enroll <name> --ticket -           Save a box credential from a one-shot join ticket
  update [--force]                   Self-update and restart the running serve cleanly
  revoke-tokens                      De-authorize every CLI login
  version                            Show version and platform
  guide                              Step-by-step manual for AI agents
  help                               Show this help

Exit codes: 0 ok, 1 error, 2 usage, 10 waiting for approval, 11 expired,
12 not logged in. With --json, success payloads carry "schema_version":1 and
errors go to stderr as {"schema_version":1,"error":{"code","message","next"}}.

Boxes enrolled with the original one-liner keep working: 'finch join --upstream
<url>' serves a single service from ~/.finch/agent.json.

Run 'finch <command> -h' for a command's flags.
`

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

func writeCLIVersion(out io.Writer, args []string, info cliVersionInfo) error {
	fs := flag.NewFlagSet("version", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	asJSON := fs.Bool("json", false, "print stable machine-readable JSON")
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
		return nil, fmt.Errorf("not logged in — run `finch login --start`")
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
	res, err := controlPlaneHTTPClient.Do(req)
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
	case he.Status >= 500:
		return newCLIError(codeUpstream, "finch service status", "%s did not answer through the hub: %v (is 'finch run' serving it?)", service, he)
	case he.Status == 406 || (he.Status == 400 && strings.Contains(strings.ToLower(he.Msg), "session")):
		// The relay reached the server, which rejected finch's single
		// stateless request: Streamable-HTTP servers that require an
		// SSE-capable Accept header or an initialized session answer 406 or
		// 400 "Missing session ID".
		return newCLIError(codeUpstream, "finch connect "+service+" --client <client>",
			"%s is reachable through finch, but it rejected finch's one-shot %s with HTTP %d (%s). finch test cannot check servers that require an MCP session or an SSE-capable client yet, so this does not mean the service is down; check it from an MCP client instead",
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
	argsJSON := fs.String("args", "{}", "tool arguments as a JSON object")
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
			c.printf("no custom hostnames — `finch domain add <hostname>`\n")
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
	all := fs.Bool("all", false, "mint: key reaches EVERY service (default: none — scope it)")
	service := fs.String("service", "", "mint: scope the key to one service")
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
			c.printf("no keys — `finch keys mint <label> --service <name>`\n")
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
	if c.json {
		return c.emit(map[string]any{"services": apps})
	}
	if len(apps) == 0 {
		c.printf("no services — `finch add <name> --service <url>`\n")
		return nil
	}
	for _, a := range apps {
		m, _ := a.(map[string]any)
		c.printf("  %-16v %v\n", m["id"], m["state"])
	}
	return nil
}

// runRm: finch rm <name> — remove a service from the tenant.
func runRm(c *cli, args []string) error {
	fs := newFlagSet("rm")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usageError("usage: finch rm <name>")
	}
	if err := validateServiceID(pos[0]); err != nil {
		return usageError("%v", err)
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}
	if _, err := cliRequest("POST", cred.Hub, "/api/cli/services/release", cred.Token, map[string]string{"id": pos[0]}); err != nil {
		return hubFailure(err, "remove "+pos[0], "finch fleet")
	}
	if c.json {
		return c.emit(map[string]any{"removed": pos[0]})
	}
	c.printf("finch: removed %s\n", pos[0])
	return nil
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
	c.printf("finch: revoked all CLI tokens — every logged-in box (including this one) must `finch login` again\n")
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
	asLogin := fs.Bool("login", false, "print a ready-to-run `finch login` block instead of just the token (heredoc: the token is fed on stdin, never on argv)")
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
}

// runStatus: finch status [--json] — login, finch.yml, and the background
// service at a glance. It reports rather than fails: not being logged in is a
// normal answer ("loggedIn": false, exit 0), so an agent can read one payload
// and decide which step to start from.
func runStatus(c *cli, args []string) error {
	fs := newFlagSet("status")
	fs.Bool("json", false, "JSON output")
	configPath := fs.String("config", defaultManifestPath(), "finch.yml to summarize")
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
		for _, ing := range cfg.Ingress {
			ingress = append(ingress, ingressStatus{AppPath: ing.AppPath, Service: ing.Service})
		}
	}
	svc := currentServiceStatus()

	if c.json {
		payload := map[string]any{
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
	case loggedIn:
		who := tenant
		if account != "" {
			who = account
		}
		c.printf("logged in: %s  (%s)\n", hub, who)
	case loginPending:
		c.printf("login waiting for approval — open %s and confirm code %s, then run `finch login --poll`\n", pending.VerificationURIComplete, pending.UserCode)
	default:
		c.printf("not logged in — run `finch login --start`\n")
	}
	if cfgPath != "" {
		c.printf("%s serves %d rule(s):\n", cfgPath, len(ingress))
		for _, ing := range ingress {
			c.printf("  • %-16s → %s\n", ing.AppPath, ing.Service)
		}
	} else {
		c.printf("no finch.yml yet — `finch add <name> --service <url>` creates one\n")
	}
	c.printf("background service (%s): %s\n", svc.Manager, svc.describe())
	return nil
}

// runAdd: finch add <name> --service <url> [--public] [--config finch.yml] [--json]
//
// One-shot convenience for a logged-in box: it enrolls the service via the CLI
// token, saves the box-side refresh credential (so `finch run` resumes without a
// ticket), appends a ticketless ingress rule to finch.yml, and — with --public —
// opens the endpoint to callers without a key.
func runAdd(c *cli, args []string) error {
	fs := newFlagSet("add")
	service := fs.String("service", "", "local server URL to expose (required), e.g. http://127.0.0.1:8000")
	configPath := fs.String("config", defaultManifestPath(), "finch.yml to append the ingress rule to")
	public := fs.Bool("public", false, "make the endpoint open to anyone (no finch_ key needed)")
	fs.Bool("json", false, "print the result as JSON")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 || *service == "" {
		return usageError("usage: finch add <name> --service <url> [--public]  (<name> becomes https://<your-slug>.finchmcp.com/<name>/)")
	}
	wantPath := pos[0]
	if err := validateServiceID(wantPath); err != nil {
		return usageError("%v", err)
	}
	if _, err := parseUpstreamTransportURL(*service); err != nil {
		return usageError("--service %q has invalid transport: %v", *service, err)
	}
	if err := validateManifestMutationTarget(*configPath); err != nil {
		return newCLIError(codeInternal, "", "cannot safely update %s: %v", *configPath, err)
	}
	cred, err := requireCred()
	if err != nil {
		return err
	}

	// Enroll the service via the CLI token. The hub slugifies the name into the
	// real service id; use THAT as the app_path so the URL matches.
	out, err := cliRequest("POST", cred.Hub, "/api/cli/enroll", cred.Token, map[string]string{"name": wantPath})
	if err != nil {
		return hubFailure(err, "enroll "+wantPath, "")
	}
	id, _ := out["id"].(string)
	ticket, _ := out["ticket"].(string)
	pubURL, _ := out["url"].(string)
	if id == "" || ticket == "" {
		return newCLIError(codeUpstream, "", "enroll %s: the hub returned no service id or ticket", wantPath)
	}
	if err := validateServiceID(id); err != nil {
		return newCLIError(codeUpstream, "", "enroll %s: unsafe service id returned by hub: %v", wantPath, err)
	}
	if id != wantPath {
		c.printf("finch: note: %q was registered as %q (host-safe slug)\n", wantPath, id)
	}

	// Honor the finch.yml at --config (best-effort): the box should register under
	// the manifest's `box:` (falling back to the hostname), and the credential
	// MUST land in the manifest's credentials-dir so `finch run` finds it.
	host, _ := os.Hostname()
	box, credDir := addPaths(*configPath, host)

	// Trade the ticket for a saved box-side credential now (so the ticket never
	// lands in the manifest), then append a ticketless ingress rule.
	statePath := filepath.Join(credDir, id+".json")
	if _, _, err := enrollToState(cred.Hub, box, ticket, statePath); err != nil {
		return newCLIError(codeUpstream, "", "enroll %s: %v", id, err)
	}
	if err := appendIngress(*configPath, cred.Hub, id, *service, box); err != nil {
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
	if c.json {
		return c.emit(map[string]any{"app_path": id, "service": *service, "url": pubURL, "config": *configPath, "auth": auth})
	}
	c.printf("finch: added %q → %s\n", id, *service)
	if pubURL != "" {
		c.printf("       public URL: %s\n", pubURL)
	}
	if auth == "public" {
		c.printf("       access: public — anyone with the URL can call it\n")
	} else {
		c.printf("       access: callers need a finch_ key — `finch connect %s --client claude-code|cursor|codex|json`\n", id)
	}
	c.printf("       wrote rule to %s — next: `finch service install` (or `finch run` in the foreground)\n", *configPath)
	return nil
}

// runEnroll: finch enroll <name> --ticket - [--hub …] [--box …] [--credentials-dir …]
//
// The one-time, imperative enrollment step for a box that has a ticket but no
// CLI login: it trades a one-shot join ticket for the long-lived box-side
// refresh credential and writes it to <credentials-dir>/<service>.json, where
// `finch run` resumes it ticketless. A logged-in box uses `finch add` instead.
func runEnroll(c *cli, args []string) error {
	fs := newFlagSet("enroll")
	ticket := fs.String("ticket", "", "one-shot enrollment ticket (required; '-' reads it from stdin, or set FINCH_TICKET)")
	hub := fs.String("hub", "https://finchmcp.com", "finch hub base URL")
	host, _ := os.Hostname()
	defBox, defCredDir := addPaths("finch.yml", host)
	box := fs.String("box", defBox, "this box's name")
	credDir := fs.String("credentials-dir", defCredDir, "directory the saved credential is written to")
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
		return newCLIError(codeUpstream, "", "enroll failed: %v", err)
	}
	if c.json {
		return c.emit(map[string]any{"app_path": id, "credential": statePath})
	}
	if id != appPath {
		c.printf("finch: note: %q was registered as %q (host-safe slug)\n", appPath, id)
	}
	c.printf("finch: enrolled %q — credential saved to %s\n", id, statePath)
	c.printf("       add it to finch.yml and run `finch run`:\n")
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
