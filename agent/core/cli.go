package core

// finch CLI setup commands — `finch login` and `finch add`. Together they let a
// box enroll appliances and build its finch.yml without ever touching the
// dashboard (cloudflared's `tunnel login` + `tunnel create`):
//
//	finch login <token>                         # paste the CLI token from the dashboard
//	finch add printer --service http://:8000     # enroll + append an ingress rule
//	finch run                                    # serve everything in finch.yml
//
// The CLI token is a long-lived tenant assertion the dashboard issues; the box
// presents it as `Authorization: Bearer <token>` to /api/cli/*.

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// printGuide is `finch guide` — a complete, self-contained operating manual an
// AI agent can read once and then drive finch end to end. Point an agent at it:
// "run 'finch guide' and use finch to host this MCP server."
// (No backticks below — this is a Go raw string, which backticks would close.)
func printGuide() {
	fmt.Print(`# Using finch (agent guide)

finch publishes a LOCAL service on the public internet — authenticated, with NO
open ports. The box dials OUT to the finch hub; clients reach it at a stable
https://<your-slug>.finchmcp.com/<app_path>/ URL. finch is a protocol-agnostic
tunnel: the service can be an MCP server, a website, or any HTTP/WebSocket app.
You (an agent) drive everything from this CLI. Every command is non-interactive
and supports --json.

## The only human step
'finch login' needs a human ONCE (it opens a browser to approve a short code).
After that you operate freely. Already logged in? Check:  finch status --json

## Host a service (the core loop)
1. Make sure your service is running locally over HTTP, e.g. http://127.0.0.1:8000
   (an MCP server, a web app, any HTTP/WS app. Service MUST be an http(s) URL.)
2. Expose it:        finch add printer --service http://127.0.0.1:8000 --json
3. Serve it:         finch run
   -> prints the public URL, e.g. https://<slug>.finchmcp.com/printer/
      (an MCP server answers at https://<slug>.finchmcp.com/printer/mcp)
'finch add' writes/extends finch.yml; 'finch run' serves EVERY rule in it (add
more services with more 'finch add' calls — one process fronts them all, and it
auto-approves while you are logged in).

## Enroll on another box (no CLI login there)
Mint a ticket in the dashboard (Add device), then on the box:
  finch enroll printer --ticket <ticket>     # writes the credential, one time
  finch run                                  # resumes ticketless thereafter
Tickets are one-shot credentials — they live on disk via enroll, NEVER in finch.yml.
Keep the ticket off the remote argv/shell history: pipe it to stdin with
'--ticket -' (or set FINCH_TICKET), e.g.
  echo <ticket> | ssh newbox "finch enroll printer --ticket -"

## Test an endpoint
  finch test printer                          # list the appliance's MCP tools
  finch call printer echo --args '{"text":"hi"}'   # invoke one tool

## Grant + REVOKE client access
A caller (another agent/app) reaches your server with a finch_ bearer key:
  finch keys mint web-client --appliance printer   # prints a finch_ key ONCE
  finch keys list
  finch keys revoke <id>                            # access stops immediately
The client then calls:
  POST https://<slug>.finchmcp.com/printer/mcp   with header  Authorization: Bearer finch_...

## Provision ANOTHER box, no human in the loop
From a box that is already logged in:
  ssh user@newbox "finch login --token $(finch token)"
  ssh user@newbox "finch add api --service http://127.0.0.1:9000 && finch run"
'finch token' mints a fresh, revocable CLI token. The browser step is only ever
needed for your FIRST box.

## Inspect state
  finch status --json     # am I logged in (which tenant)? what does finch.yml serve?
  finch fleet --json      # every appliance + its state (chirping/resting/pending)
  finch domain ls         # custom hostnames mapped to this account

## finch.yml (what 'finch add' writes — holds NO secrets)
  hub: https://finchmcp.com
  machine: this-box
  ingress:
    - app_path: printer                # becomes <slug>.finchmcp.com/printer/
      service: http://127.0.0.1:8000

## Good to know
- --json works on add / token / status / fleet / keys / test / call for parsing.
- The CLI token is a tenant-admin credential (~30 days). Revoke everything with:
    finch revoke-tokens   (or the dashboard -> Settings -> CLI access)
- 'finch rm <appliance>' removes an appliance; 'finch approve <app_path>' is only
  needed if you are not logged in (otherwise 'finch run' approves automatically).
- See 'finch help' for the flag-level reference.
`)
}

// printUsage is the top-level `finch help` — an overview of the subcommands.
// (Go's flag package only prints per-flag usage; this ties it together.)
func printUsage() {
	fmt.Print(`finch — publish local services (MCP servers, web apps, any HTTP/WS) through the
finch hub. Your box dials OUT, so nothing listens and no ports are opened.

Usage:
  finch login [--hub URL]              Log in (opens the browser to approve a code)
  finch add <app_path> --service <url> Enroll an appliance and append it to finch.yml
                                          <app_path> becomes the URL: <slug>.finchmcp.com/<app_path>/
  finch enroll <app_path> --ticket <t> Save a box-side credential from a dashboard ticket (one time)
  finch run [--config finch.yml]       Serve every ingress rule (auto-approves when logged in)
  finch approve <app_path>             Approve an appliance (clear the pending gate)
  finch token [--json|--login]         Mint a fresh CLI token (provision a new box, no browser)
  finch status [--json]                Show login + what finch.yml serves
  finch fleet [--json]   (alias: ls)   List this account's appliances + state
  finch test <appliance>               List an appliance's MCP tools (does-it-work check)
  finch call <appliance> <tool> [--args '{...}']   Invoke one tool through the hub
  finch keys [list|mint <label> --appliance <id>|revoke <id>]   Manage client finch_ keys
  finch domain [ls|add <hostname>|rm <hostname>]   Manage custom hostnames
  finch rm <appliance>                 Remove an appliance
  finch revoke-tokens                  De-authorize every CLI login (incl. this box)
  finch join --ticket <t> --upstream <url>   Run one appliance straight from flags
  finch guide                          Full agent operating manual (point an AI agent at this)
  finch help                           Show this help

Driving finch with an AI agent? Run 'finch guide' for a complete manual it can
follow, or just tell it: "use finch — run 'finch guide' first."

Typical first-time setup:
  finch login --hub https://finchmcp.com   # browser approval, once
  finch add printer --service http://127.0.0.1:8000
  finch run

Automation / driving finch from an agent (after the one-time 'finch login'):
  Everything below is non-interactive and supports --json. No browser, no
  dashboard. The CLI token is a tenant-admin credential, so an agent can do the
  whole loop: introspect, serve, test, and grant/revoke access.

  Introspect:
    finch status --json            # am I logged in? what does finch.yml serve?
    finch fleet --json             # every appliance + its state

  Serve a local service:
    finch add scraper --service http://127.0.0.1:8001 --json
    finch run                      # serves all finch.yml rules, auto-approves

  Test an endpoint:
    finch test scraper             # list its MCP tools
    finch call scraper search --args '{"q":"finch"}'   # invoke one tool

  Grant + REVOKE client access (the finch_ keys callers present):
    finch keys mint web-client --appliance scraper     # prints a finch_ key once
    finch keys list
    finch keys revoke <id>         # access stops immediately
    finch domain add mcp.example.com
    finch revoke-tokens            # de-authorize every CLI login at once

  Provision a NEW box from this already-authed one, zero human in the loop:
    ssh user@newbox 'finch login --token '"$(finch token)"
    ssh user@newbox 'finch add api --service http://127.0.0.1:9000 && finch run'

Run 'finch <command> -h' for a command's own flags.
`)
}

// cliCred is the saved CLI login: which hub, and the tenant token for it.
type cliCred struct {
	Hub   string `json:"hub"`
	Token string `json:"token"`
	Email string `json:"email,omitempty"` // the signed-in user's email (for display)
}

func cliCredPath() string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".finch", "cli.json")
	}
	return ".finch-cli.json"
}

func loadCliCred() (*cliCred, error) {
	b, err := os.ReadFile(cliCredPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("not logged in — run `finch login <token>` first (get a token from the dashboard → Settings → CLI access)")
		}
		return nil, err
	}
	var c cliCred
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func saveCliCred(c *cliCred) error {
	p := cliCredPath()
	if dir := filepath.Dir(p); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(p, b, 0o600)
}

// cliGET/cliPOST hit /api/cli/* with the bearer token.
func cliRequest(method, hub, path, token string, body any) (map[string]any, error) {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, strings.TrimRight(hub, "/")+path, rdr)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if res.StatusCode != 200 {
		msg := strings.TrimSpace(string(raw))
		if out != nil {
			if e, ok := out["error"].(string); ok {
				msg = e
			}
		}
		return nil, fmt.Errorf("hub %d: %s", res.StatusCode, msg)
	}
	return out, nil
}

// loadCliCredQuiet returns the saved CLI credential, or nil if not logged in
// (no error) — for best-effort auto-approve in `finch run`.
func loadCliCredQuiet() *cliCred {
	c, err := loadCliCred()
	if err != nil {
		return nil
	}
	return c
}

// cliApprove clears the pending gate for appliance `id` via the CLI token.
func cliApprove(cred *cliCred, id string) error {
	_, err := cliRequest("POST", cred.Hub, "/api/cli/approve", cred.Token, map[string]string{"id": id})
	return err
}

// cmdApprove: finch approve <path> [<path>...]
func cmdApprove(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: finch approve <path> [<path>...]")
		os.Exit(2)
	}
	cred, err := loadCliCred()
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	for _, id := range args {
		if err := cliApprove(cred, id); err != nil {
			fmt.Fprintf(os.Stderr, "finch: approve %q failed: %v\n", id, err)
			continue
		}
		fmt.Printf("finch: approved %q\n", id)
	}
}

// cliSetAuth flips an appliance's public-relay access mode ("key" | "public").
func cliSetAuth(cred *cliCred, appPath, mode string) error {
	_, err := cliRequest("POST", cred.Hub, "/api/cli/auth", cred.Token, map[string]string{"appliance": appPath, "mode": mode})
	return err
}

// cmdAuth: finch auth <app_path> public|key — set whether the appliance's public
// endpoint requires a finch_ bearer key. "public" makes it an open webpage.
func cmdAuth(args []string) {
	if len(args) != 2 || (args[1] != "public" && args[1] != "key") {
		fmt.Fprintln(os.Stderr, "usage: finch auth <app_path> public|key")
		os.Exit(2)
	}
	cred, err := loadCliCred()
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	if err := cliSetAuth(cred, args[0], args[1]); err != nil {
		fmt.Fprintf(os.Stderr, "finch: set auth %q failed: %v\n", args[0], err)
		os.Exit(1)
	}
	fmt.Printf("finch: %q is now %s\n", args[0], args[1])
}

// cmdLogin: finch login [--hub URL] <token>
func cmdLogin(args []string) {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	hub := fs.String("hub", "https://finchmcp.com", "finch hub base URL")
	tokenFlag := fs.String("token", "", "CLI token (or pass as a positional argument)")
	_ = fs.Parse(args)

	token := *tokenFlag
	if token == "" && fs.NArg() > 0 {
		token = fs.Arg(0)
	}
	// No token → run the interactive device flow (open browser, approve a code).
	// The device flow also hands back the approver's email (for the account label);
	// the --token path has none.
	email := ""
	if token == "" {
		token, email = deviceLogin(*hub)
	}

	// Validate against the hub and learn which tenant the token acts as.
	who, err := cliRequest("GET", *hub, "/api/cli/whoami", token, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: login failed: %v\n", err)
		os.Exit(1)
	}
	if err := saveCliCred(&cliCred{Hub: *hub, Token: token, Email: email}); err != nil {
		fmt.Fprintf(os.Stderr, "finch: could not save credential: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("finch: logged in to tenant %v at %s (saved to %s)\n", who["tenant"], *hub, cliCredPath())
}

// deviceLogin runs the browser device-authorization flow (`finch login` with no
// token): start a code, point the user at the dashboard to approve it, poll until
// approved, and return the issued token plus the approver's email (for the account
// label; may be ""). Exits on error/expiry/timeout.
func deviceLogin(hub string) (string, string) {
	start, err := cliRequest("POST", hub, "/api/cli/device/start", "", struct{}{})
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: could not start login: %v\n", err)
		os.Exit(1)
	}
	deviceCode, _ := start["device_code"].(string)
	userCode, _ := start["user_code"].(string)
	uri, _ := start["verification_uri_complete"].(string)
	if uri == "" {
		uri, _ = start["verification_uri"].(string)
	}
	interval := 3.0
	if v, ok := start["interval"].(float64); ok && v > 0 {
		interval = v
	}
	expires := 600.0
	if v, ok := start["expires_in"].(float64); ok && v > 0 {
		expires = v
	}

	fmt.Printf("\n  To finish login, open this page in your browser:\n\n      %s\n\n  and confirm this code:  %s\n\n", uri, userCode)
	openBrowser(uri)
	fmt.Print("  Waiting for approval")

	deadline := time.Now().Add(time.Duration(expires) * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(time.Duration(interval) * time.Second)
		poll, err := cliRequest("POST", hub, "/api/cli/device/poll", "", map[string]string{"device_code": deviceCode})
		if err != nil {
			fmt.Print(".")
			continue
		}
		switch poll["status"] {
		case "approved":
			fmt.Println("  ✓")
			if tok, _ := poll["token"].(string); tok != "" {
				email, _ := poll["email"].(string)
				return tok, email
			}
			fmt.Fprintln(os.Stderr, "\nfinch: approval returned no token")
			os.Exit(1)
		case "expired", "not_found":
			fmt.Fprintln(os.Stderr, "\nfinch: login code expired — run `finch login` again")
			os.Exit(1)
		default: // pending
			fmt.Print(".")
		}
	}
	fmt.Fprintln(os.Stderr, "\nfinch: timed out waiting for approval")
	os.Exit(1)
	return "", ""
}

// openBrowser best-effort opens a URL in the user's browser.
func openBrowser(u string) {
	var name string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		name, args = "open", []string{u}
	case "windows":
		name, args = "rundll32", []string{"url.dll,FileProtocolHandler", u}
	default:
		name, args = "xdg-open", []string{u}
	}
	_ = exec.Command(name, args...).Start()
}

// cmdTest: finch test <appliance> — list the appliance's MCP tools (a quick
// "does my endpoint work" check, relayed through the hub via the CLI token).
func cmdTest(args []string) {
	fs := flag.NewFlagSet("test", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "machine-readable JSON")
	app := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		app, args = args[0], args[1:]
	}
	_ = fs.Parse(args)
	if app == "" {
		fmt.Fprintln(os.Stderr, "usage: finch test <appliance>")
		os.Exit(2)
	}
	cred := mustCliCred()
	out, err := cliRequest("POST", cred.Hub, "/api/cli/call", cred.Token, map[string]any{"appliance": app, "method": "tools/list"})
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	if *asJSON {
		b, _ := json.Marshal(out)
		fmt.Println(string(b))
		return
	}
	res, _ := out["result"].(map[string]any)
	tools, _ := res["tools"].([]any)
	if e, ok := out["error"]; ok && e != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", e)
		os.Exit(1)
	}
	fmt.Printf("%s — %d tool(s):\n", app, len(tools))
	for _, t := range tools {
		m, _ := t.(map[string]any)
		fmt.Printf("  • %-16v %v\n", m["name"], m["description"])
	}
}

// cmdCall: finch call <appliance> <tool> [--args '{...}'] — invoke one tool.
func cmdCall(args []string) {
	fs := flag.NewFlagSet("call", flag.ExitOnError)
	argsJSON := fs.String("args", "{}", "tool arguments as a JSON object")
	asJSON := fs.Bool("json", false, "print the raw JSON-RPC result")
	pos := []string{}
	for len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		pos = append(pos, args[0])
		args = args[1:]
	}
	_ = fs.Parse(args)
	if len(pos) < 2 {
		fmt.Fprintln(os.Stderr, "usage: finch call <appliance> <tool> [--args '{\"k\":\"v\"}']")
		os.Exit(2)
	}
	var toolArgs any
	if err := json.Unmarshal([]byte(*argsJSON), &toolArgs); err != nil {
		fmt.Fprintf(os.Stderr, "finch: --args is not valid JSON: %v\n", err)
		os.Exit(2)
	}
	cred := mustCliCred()
	out, err := cliRequest("POST", cred.Hub, "/api/cli/call", cred.Token, map[string]any{
		"appliance": pos[0],
		"method":    "tools/call",
		"params":    map[string]any{"name": pos[1], "arguments": toolArgs},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	if *asJSON {
		b, _ := json.Marshal(out)
		fmt.Println(string(b))
		return
	}
	if e, ok := out["error"]; ok && e != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", e)
		os.Exit(1)
	}
	// Pretty-print the text content if present, else the raw result.
	if res, ok := out["result"].(map[string]any); ok {
		if content, ok := res["content"].([]any); ok {
			for _, c := range content {
				if m, ok := c.(map[string]any); ok && m["type"] == "text" {
					fmt.Println(m["text"])
				}
			}
			return
		}
		b, _ := json.Marshal(res)
		fmt.Println(string(b))
		return
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}

// mustCliCred loads the CLI credential or exits with the login hint.
func mustCliCred() *cliCred {
	cred, err := loadCliCred()
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	return cred
}

// cmdDomain: finch domain [ls|add|rm] — manage custom hostnames mapped to this
// tenant. The hub enforces ownership and, for BYO domains, returns the DNS CNAME
// instruction the operator must configure before traffic becomes live.
func cmdDomain(args []string) {
	sub := "ls"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}
	cred, err := loadCliCred()
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	switch sub {
	case "ls", "list":
		fs := flag.NewFlagSet("domain ls", flag.ExitOnError)
		asJSON := fs.Bool("json", false, "machine-readable JSON")
		_ = fs.Parse(args)
		out, err := cliRequest("GET", cred.Hub, "/api/cli/hostnames", cred.Token, nil)
		if err != nil {
			fmt.Fprintf(os.Stderr, "finch: %v\n", err)
			os.Exit(1)
		}
		hostnames, _ := out["hostnames"].([]any)
		if *asJSON {
			b, _ := json.Marshal(hostnames)
			fmt.Println(string(b))
			return
		}
		if len(hostnames) == 0 {
			fmt.Println("no custom hostnames — `finch domain add <hostname>`")
			return
		}
		for _, h := range hostnames {
			fmt.Printf("  %v\n", h)
		}
	case "add":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: finch domain add <hostname>")
			os.Exit(2)
		}
		out, err := cliRequest("POST", cred.Hub, "/api/cli/hostnames", cred.Token, map[string]string{"hostname": args[0]})
		if err != nil {
			fmt.Fprintf(os.Stderr, "finch: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("finch: added %v hostname %v\n", out["tier"], out["hostname"])
		if instr, _ := out["instructions"].(string); instr != "" {
			fmt.Println(instr)
		}
		if ssl, ok := out["ssl"]; ok && ssl != nil {
			fmt.Printf("ssl: %v\n", ssl)
		}
	case "rm", "remove", "delete":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: finch domain rm <hostname>")
			os.Exit(2)
		}
		if _, err := cliRequest("DELETE", cred.Hub, "/api/cli/hostnames", cred.Token, map[string]string{"hostname": args[0]}); err != nil {
			fmt.Fprintf(os.Stderr, "finch: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("finch: removed hostname %s\n", args[0])
	default:
		fmt.Fprintln(os.Stderr, "usage: finch domain [ls | add <hostname> | rm <hostname>]")
		os.Exit(2)
	}
}

// cmdKeys: finch keys [list|mint|revoke] — manage the client finch_ keys that
// callers present to reach your appliances. The control plane an agent uses to
// grant + REVOKE access without the dashboard.
func cmdKeys(args []string) {
	sub := "list"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}
	cred, err := loadCliCred()
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	switch sub {
	case "list":
		fs := flag.NewFlagSet("keys", flag.ExitOnError)
		asJSON := fs.Bool("json", false, "machine-readable JSON")
		_ = fs.Parse(args)
		st, err := cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
		if err != nil {
			fmt.Fprintf(os.Stderr, "finch: %v\n", err)
			os.Exit(1)
		}
		keys, _ := st["keys"].([]any)
		if *asJSON {
			b, _ := json.Marshal(keys)
			fmt.Println(string(b))
			return
		}
		if len(keys) == 0 {
			fmt.Println("no keys — `finch keys mint <label> --appliance <id>`")
			return
		}
		for _, k := range keys {
			m, _ := k.(map[string]any)
			fmt.Printf("  %-12v %v\n", m["id"], m["label"])
		}
	case "mint":
		fs := flag.NewFlagSet("keys mint", flag.ExitOnError)
		all := fs.Bool("all", false, "key reaches EVERY appliance (default: none — scope it)")
		appliance := fs.String("appliance", "", "scope the key to one appliance id")
		asJSON := fs.Bool("json", false, "machine-readable JSON")
		label := ""
		if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
			label, args = args[0], args[1:]
		}
		_ = fs.Parse(args)
		if label == "" {
			fmt.Fprintln(os.Stderr, "usage: finch keys mint <label> (--appliance <id> | --all)")
			os.Exit(2)
		}
		var scope any
		switch {
		case *all:
			scope = map[string]bool{"all": true}
		case *appliance != "":
			scope = map[string][]string{"appliances": {*appliance}}
		default:
			fmt.Fprintln(os.Stderr, "finch: scope the key with --appliance <id> (or --all)")
			os.Exit(2)
		}
		out, err := cliRequest("POST", cred.Hub, "/api/cli/keys", cred.Token, map[string]any{"label": label, "scope": scope})
		if err != nil {
			fmt.Fprintf(os.Stderr, "finch: %v\n", err)
			os.Exit(1)
		}
		if *asJSON {
			b, _ := json.Marshal(out)
			fmt.Println(string(b))
			return
		}
		fmt.Println(out["key"]) // the finch_ key — shown once
	case "revoke":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "usage: finch keys revoke <id>")
			os.Exit(2)
		}
		if _, err := cliRequest("POST", cred.Hub, "/api/cli/keys/revoke", cred.Token, map[string]string{"id": args[0]}); err != nil {
			fmt.Fprintf(os.Stderr, "finch: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("finch: revoked key %s\n", args[0])
	default:
		fmt.Fprintln(os.Stderr, "usage: finch keys [list | mint <label> --appliance <id> | revoke <id>]")
		os.Exit(2)
	}
}

// cmdFleet: finch fleet [--json] — list this tenant's appliances + state.
func cmdFleet(args []string) {
	fs := flag.NewFlagSet("fleet", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "machine-readable JSON")
	_ = fs.Parse(args)
	cred, err := loadCliCred()
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	st, err := cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	apps, _ := st["appliances"].([]any)
	if *asJSON {
		b, _ := json.Marshal(apps)
		fmt.Println(string(b))
		return
	}
	if len(apps) == 0 {
		fmt.Println("no appliances — `finch add <path> --service <url>`")
		return
	}
	for _, a := range apps {
		m, _ := a.(map[string]any)
		fmt.Printf("  %-16v %v\n", m["id"], m["state"])
	}
}

// cmdRm: finch rm <appliance> — remove an appliance from the tenant.
func cmdRm(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: finch rm <appliance>")
		os.Exit(2)
	}
	cred, err := loadCliCred()
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	if _, err := cliRequest("POST", cred.Hub, "/api/cli/appliances/release", cred.Token, map[string]string{"id": args[0]}); err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("finch: removed %s\n", args[0])
}

// cmdRevokeTokens: finch revoke-tokens — de-authorize every CLI login (incl. this).
func cmdRevokeTokens(args []string) {
	cred, err := loadCliCred()
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	if _, err := cliRequest("POST", cred.Hub, "/api/cli/revoke-tokens", cred.Token, struct{}{}); err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("finch: revoked all CLI tokens — every logged-in box (including this one) must `finch login` again")
}

// cmdToken: finch token [--json] [--login] — an authed box mints a FRESH CLI
// token, for non-interactive provisioning of a new box:
//
//	ssh newbox "finch login --token $(finch token)"
func cmdToken(args []string) {
	fs := flag.NewFlagSet("token", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "print the raw {token,hub,expiresAt} JSON")
	asLogin := fs.Bool("login", false, "print a full `finch login` command instead of just the token")
	_ = fs.Parse(args)

	cred, err := loadCliCred()
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	out, err := cliRequest("POST", cred.Hub, "/api/cli/token", cred.Token, struct{}{})
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: could not mint token: %v\n", err)
		os.Exit(1)
	}
	token, _ := out["token"].(string)
	hub, _ := out["hub"].(string)
	if token == "" {
		fmt.Fprintf(os.Stderr, "finch: unexpected response: %v\n", out)
		os.Exit(1)
	}
	switch {
	case *asJSON:
		b, _ := json.Marshal(out)
		fmt.Println(string(b))
	case *asLogin:
		fmt.Printf("finch login --hub %s %s\n", hub, token)
	default:
		fmt.Println(token) // bare token, for `ssh host "finch login --token $(finch token)"`
	}
}

// cmdStatus: finch status [--json] — introspect login + finch.yml (for agents).
func cmdStatus(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "machine-readable JSON")
	configPath := fs.String("config", "finch.yml", "finch.yml to summarize")
	_ = fs.Parse(args)

	type ingressStatus struct {
		AppPath string `json:"app_path"`
		Service string `json:"service"`
	}
	st := struct {
		LoggedIn bool            `json:"loggedIn"`
		Hub      string          `json:"hub,omitempty"`
		Tenant   string          `json:"tenant,omitempty"`
		Config   string          `json:"config,omitempty"`
		Ingress  []ingressStatus `json:"ingress"`
	}{Ingress: []ingressStatus{}}

	if cred := loadCliCredQuiet(); cred != nil {
		st.Hub = cred.Hub
		if who, err := cliRequest("GET", cred.Hub, "/api/cli/whoami", cred.Token, nil); err == nil {
			st.LoggedIn = true
			st.Tenant, _ = who["tenant"].(string)
		}
	}
	hostName, _ := os.Hostname()
	if cfg, err := loadConfig(*configPath, hostName); err == nil {
		st.Config = *configPath
		if st.Hub == "" {
			st.Hub = cfg.Hub
		}
		for _, ing := range cfg.Ingress {
			st.Ingress = append(st.Ingress, ingressStatus{AppPath: ing.AppPath, Service: ing.Service})
		}
	}

	if *asJSON {
		b, _ := json.MarshalIndent(st, "", "  ")
		fmt.Println(string(b))
		return
	}
	if st.LoggedIn {
		fmt.Printf("logged in: %s  (tenant %s)\n", st.Hub, st.Tenant)
	} else {
		fmt.Printf("not logged in%s — run `finch login`\n", func() string {
			if st.Hub != "" {
				return " to " + st.Hub
			}
			return ""
		}())
	}
	if st.Config != "" {
		fmt.Printf("%s serves %d rule(s):\n", st.Config, len(st.Ingress))
		for _, ing := range st.Ingress {
			fmt.Printf("  • %-16s → %s\n", ing.AppPath, ing.Service)
		}
	} else {
		fmt.Println("no finch.yml here — `finch add <app_path> --service <url>` to create one")
	}
}

// cmdAdd: finch add <app_path> --service <url> [--config finch.yml]
//
// One-shot convenience for a logged-in box: it enrolls the appliance via the CLI
// token, saves the box-side refresh credential (so `finch run` resumes without a
// ticket), and appends a ticketless ingress rule to finch.yml.
func cmdAdd(args []string) {
	fs := flag.NewFlagSet("add", flag.ExitOnError)
	service := fs.String("service", "", "local server URL to expose (required), e.g. http://127.0.0.1:8000")
	configPath := fs.String("config", "finch.yml", "finch.yml to append the ingress rule to")
	asJSON := fs.Bool("json", false, "print the result as JSON (for scripts/agents)")

	// Go's flag parser stops at the first positional, so pull a leading <app_path>
	// (the natural `finch add printer --service …` order) before parsing flags.
	wantPath := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		wantPath = args[0]
		args = args[1:]
	}
	_ = fs.Parse(args)
	if wantPath == "" && fs.NArg() > 0 {
		wantPath = fs.Arg(0)
	}

	if wantPath == "" || *service == "" {
		fmt.Fprintln(os.Stderr, "usage: finch add <app_path> --service <url>")
		fmt.Fprintln(os.Stderr, "  <app_path> becomes the public URL segment: https://<your-slug>.finchmcp.com/<app_path>/")
		os.Exit(2)
	}
	if strings.ContainsAny(wantPath, "/ ") {
		fmt.Fprintf(os.Stderr, "finch: <app_path> %q must be a single URL segment (no slashes or spaces)\n", wantPath)
		os.Exit(2)
	}
	if u, err := url.Parse(strings.TrimRight(*service, "/")); err != nil || u.Scheme == "" || u.Host == "" {
		fmt.Fprintf(os.Stderr, "finch: --service %q is not a valid absolute URL\n", *service)
		os.Exit(2)
	}

	cred, err := loadCliCred()
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}

	// Enroll the appliance via the CLI token. The hub slugifies the name into the
	// real appliance id; use THAT as the app_path so the URL matches.
	out, err := cliRequest("POST", cred.Hub, "/api/cli/enroll", cred.Token, map[string]string{"name": wantPath})
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: enroll failed: %v\n", err)
		os.Exit(1)
	}
	id, _ := out["id"].(string)
	ticket, _ := out["ticket"].(string)
	pubURL, _ := out["url"].(string)
	if id == "" || ticket == "" {
		fmt.Fprintf(os.Stderr, "finch: unexpected enroll response: %v\n", out)
		os.Exit(1)
	}
	if id != wantPath {
		fmt.Printf("finch: note: %q was registered as %q (host-safe slug)\n", wantPath, id)
	}

	// Honor the finch.yml at --config (best-effort): the box should register under
	// the manifest's `machine:` (falling back to the hostname), and the credential
	// MUST land in the manifest's credentials-dir so `finch run` finds it.
	host, _ := os.Hostname()
	machine, credDir := addPaths(*configPath, host)

	// Trade the ticket for a saved box-side credential now (so the ticket never
	// lands in the manifest), then append a ticketless ingress rule.
	statePath := filepath.Join(credDir, id+".json")
	if _, _, eerr := enrollToState(cred.Hub, machine, ticket, statePath); eerr != nil {
		fmt.Fprintf(os.Stderr, "finch: enroll failed: %v\n", eerr)
		os.Exit(1)
	}
	if err := appendIngress(*configPath, cred.Hub, id, *service, machine); err != nil {
		fmt.Fprintf(os.Stderr, "finch: could not write %s: %v\n", *configPath, err)
		os.Exit(1)
	}
	if *asJSON {
		b, _ := json.Marshal(map[string]string{"app_path": id, "service": *service, "url": pubURL, "config": *configPath})
		fmt.Println(string(b))
		return
	}
	fmt.Printf("finch: added %q → %s\n", id, *service)
	if pubURL != "" {
		fmt.Printf("       public endpoint: %s\n", pubURL)
	}
	fmt.Printf("       wrote rule to %s — run `finch run` to serve it\n", *configPath)
}

// cmdEnroll: finch enroll <app_path> --ticket <t> [--hub …] [--machine …] [--credentials-dir …]
//
// The one-time, imperative enrollment step: it trades a one-shot dashboard ticket
// for the long-lived box-side refresh credential and writes it to
// <credentials-dir>/<app_path>.json. After this, `finch run` resumes ticketless.
// Tickets are a credential, so they live here / on disk — never in finch.yml.
// resolveTicket applies argv-free intake for an enrollment ticket: "-" reads it
// from stdin and FINCH_TICKET from the env — so a one-shot ticket (which mints
// the long-lived refresh token) need not land on the remote process table /
// shell history. A literal value passes through unchanged.
func resolveTicket(ticket string) string {
	if ticket == "-" {
		b, err := io.ReadAll(io.LimitReader(os.Stdin, 4096))
		if err != nil {
			fmt.Fprintf(os.Stderr, "finch: could not read ticket from stdin: %v\n", err)
			os.Exit(1)
		}
		ticket = strings.TrimSpace(string(b))
		if ticket == "" {
			fmt.Fprintln(os.Stderr, "finch: --ticket - given but stdin was empty")
			os.Exit(1)
		}
	}
	if ticket == "" {
		ticket = strings.TrimSpace(os.Getenv("FINCH_TICKET"))
	}
	return ticket
}

func cmdEnroll(args []string) {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	ticket := fs.String("ticket", "", "one-shot enrollment ticket from the dashboard (required; '-' reads it from stdin, or set FINCH_TICKET)")
	hub := fs.String("hub", "https://finchmcp.com", "finch hub base URL")
	// Default --machine to finch.yml's `machine:` when a manifest is present, so the
	// box registers under the name the manifest declares; else the hostname.
	host, _ := os.Hostname()
	machine := fs.String("machine", configMachine("finch.yml", host), "this box's name")
	credDir := fs.String("credentials-dir", defaultCredentialsDir(), "directory the saved credential is written to")

	appPath := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		appPath = args[0]
		args = args[1:]
	}
	_ = fs.Parse(args)
	if appPath == "" && fs.NArg() > 0 {
		appPath = fs.Arg(0)
	}
	ticketVal := resolveTicket(*ticket)
	if appPath == "" || ticketVal == "" {
		fmt.Fprintln(os.Stderr, "usage: finch enroll <app_path> --ticket <t>")
		fmt.Fprintln(os.Stderr, "  mint the ticket in the dashboard (Add device); <app_path> is the appliance/URL segment")
		fmt.Fprintln(os.Stderr, "  keep it off argv/history: 'echo <t> | finch enroll <app_path> --ticket -' or set FINCH_TICKET")
		os.Exit(2)
	}
	if strings.ContainsAny(appPath, "/ ") {
		fmt.Fprintf(os.Stderr, "finch: <app_path> %q must be a single URL segment (no slashes or spaces)\n", appPath)
		os.Exit(2)
	}

	// Join FIRST so we can name the credential by the hub's slugified appliance id
	// (the relay resolves the appliance by THAT id, so `finch enroll Printer` must
	// land as "printer", not the raw arg, or its URL/credential never matches).
	jr, err := join(*hub, ticketVal, *machine)
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: enroll failed: %v\n", err)
		os.Exit(1)
	}
	id := jr.Appliance
	statePath := filepath.Join(expandHome(*credDir), id+".json")
	if _, err := persistJoin(*hub, jr, statePath); err != nil {
		fmt.Fprintf(os.Stderr, "finch: enroll failed: %v\n", err)
		os.Exit(1)
	}
	if id != appPath {
		fmt.Printf("finch: note: %q was registered as %q (host-safe slug)\n", appPath, id)
	}
	fmt.Printf("finch: enrolled %q — credential saved to %s\n", id, statePath)
	fmt.Printf("       add it to finch.yml and run `finch run`:\n")
	fmt.Printf("         ingress:\n           - app_path: %s\n             service: http://127.0.0.1:8000\n", id)
}

// defaultCredentialsDir mirrors loadConfig's default: ~/.finch (cwd-relative
// .finch if there's no home dir), so `finch add`/`finch enroll` write the
// credential where `finch run` will look for it.
func defaultCredentialsDir() string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".finch")
	}
	return ".finch"
}

// configMachine returns the finch.yml `machine:` at configPath, or host when the
// manifest is absent / sets no machine — so `finch enroll`/`finch add` register
// the box under the name the manifest declares (matching the run-time log line).
func configMachine(configPath, host string) string {
	if c, err := loadConfig(configPath, host); err == nil && c.Machine != "" {
		return c.Machine
	}
	return host
}

// addPaths resolves the machine name + credentials dir `finch add` should use,
// honoring an existing finch.yml at configPath (best-effort): the credential must
// land in the manifest's credentials-dir so `finch run` finds it, and the box
// should register under the manifest's machine name. Falls back to the hostname +
// the default ~/.finch when the manifest is absent. loadConfig already expands ~
// and applies the credentials-dir default, so its values are used as-is.
func addPaths(configPath, host string) (machine, credDir string) {
	machine, credDir = host, defaultCredentialsDir()
	if c, err := loadConfig(configPath, host); err == nil {
		if c.Machine != "" {
			machine = c.Machine
		}
		if c.CredentialsDir != "" {
			credDir = c.CredentialsDir
		}
	}
	return machine, credDir
}

// appendIngress adds (or updates) one ingress rule in finch.yml WITHOUT clobbering
// user comments or keys finch doesn't model: it edits an existing file through a
// yaml.Node (yaml.v3 preserves comments + unknown content across a Node round-trip)
// rather than unmarshaling into the fixed `config` struct and re-marshaling. An
// existing rule with the same app_path is updated in place; hub/machine are filled
// only when absent. A missing file is created from the managed header + a minimal
// struct marshal. No ticket is written — the credential is saved separately by enroll.
func appendIngress(configPath, hub, appPath, service, machine string) error {
	b, err := os.ReadFile(configPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		// New file: a minimal struct marshal under the managed header is fine.
		if machine == "" {
			machine, _ = os.Hostname()
		}
		c := config{Hub: hub, Machine: machine, Ingress: []ingress{{AppPath: appPath, Service: service}}}
		out, merr := yaml.Marshal(&c)
		if merr != nil {
			return merr
		}
		return os.WriteFile(configPath, append([]byte("# finch.yml — managed by `finch add`\n"), out...), 0o600)
	}

	// Existing file: edit through a yaml.Node so comments + unmodeled keys survive.
	var doc yaml.Node
	if uerr := yaml.Unmarshal(b, &doc); uerr != nil {
		return fmt.Errorf("parsing %s: %w", configPath, uerr)
	}
	var root *yaml.Node
	if doc.Kind == yaml.DocumentNode && len(doc.Content) > 0 {
		root = doc.Content[0]
	} else { // empty/whitespace file — start a fresh mapping document
		root = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{root}}
	}
	if root.Kind != yaml.MappingNode {
		return fmt.Errorf("%s: top-level YAML is not a mapping", configPath)
	}

	// Fill hub/machine only when absent (don't overwrite a user's values).
	if yamlMapValue(root, "hub") == nil && hub != "" {
		yamlMapSet(root, "hub", yamlScalar(hub))
	}
	if yamlMapValue(root, "machine") == nil {
		if machine == "" {
			machine, _ = os.Hostname()
		}
		if machine != "" {
			yamlMapSet(root, "machine", yamlScalar(machine))
		}
	}

	// Locate (or create) the ingress sequence.
	seq := yamlMapValue(root, "ingress")
	if seq == nil || seq.Kind != yaml.SequenceNode {
		seq = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
		yamlMapSet(root, "ingress", seq)
	}
	// Update an existing rule with the same app_path in place; else append one.
	for _, item := range seq.Content {
		if item.Kind != yaml.MappingNode {
			continue
		}
		if ap := yamlMapValue(item, "app_path"); ap != nil && ap.Value == appPath {
			yamlMapSet(item, "service", yamlScalar(service))
			return yamlWriteFile(configPath, &doc)
		}
	}
	seq.Content = append(seq.Content, &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: []*yaml.Node{
		yamlScalar("app_path"), yamlScalar(appPath),
		yamlScalar("service"), yamlScalar(service),
	}})
	return yamlWriteFile(configPath, &doc)
}

// --- minimal yaml.Node helpers (comment-preserving finch.yml edits) ---

// yamlScalar builds a plain string scalar node.
func yamlScalar(v string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v}
}

// yamlMapValue returns the value node for key in a mapping node, or nil.
func yamlMapValue(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// yamlMapSet sets key to val in a mapping node, replacing the value if the key
// already exists (preserving the key node + its comments) or appending otherwise.
func yamlMapSet(m *yaml.Node, key string, val *yaml.Node) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content[i+1] = val
			return
		}
	}
	m.Content = append(m.Content, yamlScalar(key), val)
}

// yamlWriteFile marshals a yaml document node (0600). yaml.v3 preserves comments
// and unmodeled keys through the Node, so a hand-edited finch.yml survives edits.
func yamlWriteFile(configPath string, doc *yaml.Node) error {
	out, err := yaml.Marshal(doc)
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, out, 0o600)
}
