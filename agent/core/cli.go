package core

// finch CLI setup commands — `finch login` and `finch add`. Together they let a
// box enroll services and build its finch.yml without ever touching the
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
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
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
Mint a ticket in the dashboard (Add box), then on the box:
  finch enroll printer --ticket <ticket>     # writes the credential, one time
  finch run                                  # resumes ticketless thereafter
Tickets are one-shot credentials — they live on disk via enroll, NEVER in finch.yml.
Keep the ticket off the remote argv/shell history: pipe it to stdin with
'--ticket -' (or set FINCH_TICKET), e.g.
  echo <ticket> | ssh newbox "finch enroll printer --ticket -"

## Test an endpoint
  finch test printer                          # list the service's MCP tools
  finch call printer echo --args '{"text":"hi"}'   # invoke one tool

## Grant + REVOKE client access
A caller (another agent/app) reaches your server with a finch_ bearer key:
  finch keys mint web-client --service printer   # prints a finch_ key ONCE
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
  finch fleet --json      # every service + its state (online/offline/pending)
  finch domain ls         # custom hostnames mapped to this account

## finch.yml (what 'finch add' writes — holds NO secrets)
  hub: https://finchmcp.com
  box: this-box
  ingress:
    - app_path: printer                # becomes <slug>.finchmcp.com/printer/
      service: http://127.0.0.1:8000

## Good to know
- --json works on add / token / status / fleet / keys / test / call for parsing.
- The CLI token is a tenant-admin credential (~30 days). Revoke everything with:
    finch revoke-tokens   (or the dashboard -> Settings -> CLI access)
- 'finch rm <service>' removes a service; 'finch approve <app_path>' is only
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
  finch login --headless               Log in on a screenless box over SSH: prints a link
                                          + code (approve on your phone), no local browser
  finch add <app_path> --service <url> Enroll a service and append it to finch.yml
                                          <app_path> becomes the URL: <slug>.finchmcp.com/<app_path>/
  finch enroll <app_path> --ticket <t> Save a box-side credential from a dashboard ticket (one time)
  finch run [--config finch.yml]       Serve every ingress rule (auto-approves when logged in)
  finch approve <app_path>             Approve a service (clear the pending gate)
  finch token [--json|--login]         Mint a fresh CLI token (provision a new box, no browser)
  finch status [--json]                Show login + what finch.yml serves
  finch fleet [--json]   (alias: ls)   List this account's services + state
  finch test <service>               List a service's MCP tools (does-it-work check)
  finch call <service> <tool> [--args '{...}']   Invoke one tool through the hub
  finch keys [list|mint <label> --service <id>|revoke <id>]   Manage client finch_ keys
  finch domain [ls|add <hostname>|rm <hostname>]   Manage custom hostnames
  finch rm <service>                 Remove a service
  finch update [--force]               Self-update this binary + restart the serve cleanly
  finch revoke-tokens                  De-authorize every CLI login (incl. this box)
  finch join --ticket <t> --upstream <url>   Run one service straight from flags
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
    finch fleet --json             # every service + its state

  Serve a local service:
    finch add scraper --service http://127.0.0.1:8001 --json
    finch run                      # serves all finch.yml rules, auto-approves

  Test an endpoint:
    finch test scraper             # list its MCP tools
    finch call scraper search --args '{"q":"finch"}'   # invoke one tool

  Grant + REVOKE client access (the finch_ keys callers present):
    finch keys mint web-client --service scraper     # prints a finch_ key once
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

// cliApprove clears the pending gate for service `id` via the CLI token.
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

// cliSetAuth flips a service's public-relay access mode ("key" | "public").
func cliSetAuth(cred *cliCred, appPath, mode string) error {
	_, err := cliRequest("POST", cred.Hub, "/api/cli/auth", cred.Token, map[string]string{"service": appPath, "mode": mode})
	return err
}

// cmdAuth: finch auth <app_path> public|key — set whether the service's public
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
	headless := fs.Bool("headless", false, "no local browser: print the link + code (open it on any device, e.g. your phone) and poll — for a screenless box reached over SSH")
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
		token, email = deviceLogin(*hub, *headless)
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
//
// headless=true is for a screenless box reached over SSH: it skips the (useless)
// local browser spawn and force-flushes stdout so the link+code reach the far end
// of the pipe immediately instead of sitting buffered while the poll loop blocks.
// The flow is otherwise identical — you approve the code on any device (your phone
// is fine), and it polls the same ~10-minute window before giving up.
func deviceLogin(hub string, headless bool) (string, string) {
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

	fmt.Printf("\n  To finish login, open this page on any device (your phone or laptop\n  is fine — you do NOT need a browser on this machine):\n\n      %s\n\n  and confirm this code:  %s\n\n", uri, userCode)
	if !headless {
		openBrowser(uri)
	}
	fmt.Print("  Waiting for approval")
	// Over SSH / a pipe, os.Stdout is fully buffered: flush now so the link and
	// code land immediately instead of being trapped behind the blocking poll
	// loop below (the exact symptom on a headless box).
	_ = os.Stdout.Sync()

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

// cmdTest: finch test <service> — list the service's MCP tools (a quick
// "does my endpoint work" check, relayed through the hub via the CLI token).
func cmdTest(args []string) {
	fs := flag.NewFlagSet("test", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "JSON output")
	app := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		app, args = args[0], args[1:]
	}
	_ = fs.Parse(args)
	if app == "" {
		fmt.Fprintln(os.Stderr, "usage: finch test <service>")
		os.Exit(2)
	}
	cred := mustCliCred()
	out, err := cliRequest("POST", cred.Hub, "/api/cli/call", cred.Token, map[string]any{"service": app, "method": "tools/list"})
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

// cmdCall: finch call <service> <tool> [--args '{...}'] — invoke one tool.
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
		fmt.Fprintln(os.Stderr, "usage: finch call <service> <tool> [--args '{\"k\":\"v\"}']")
		os.Exit(2)
	}
	var toolArgs any
	if err := json.Unmarshal([]byte(*argsJSON), &toolArgs); err != nil {
		fmt.Fprintf(os.Stderr, "finch: --args is not valid JSON: %v\n", err)
		os.Exit(2)
	}
	cred := mustCliCred()
	out, err := cliRequest("POST", cred.Hub, "/api/cli/call", cred.Token, map[string]any{
		"service": pos[0],
		"method":  "tools/call",
		"params":  map[string]any{"name": pos[1], "arguments": toolArgs},
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
		asJSON := fs.Bool("json", false, "JSON output")
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
// callers present to reach your services. The control plane an agent uses to
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
		asJSON := fs.Bool("json", false, "JSON output")
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
			fmt.Println("no keys — `finch keys mint <label> --service <id>`")
			return
		}
		for _, k := range keys {
			m, _ := k.(map[string]any)
			fmt.Printf("  %-12v %v\n", m["id"], m["label"])
		}
	case "mint":
		fs := flag.NewFlagSet("keys mint", flag.ExitOnError)
		all := fs.Bool("all", false, "key reaches EVERY service (default: none — scope it)")
		service := fs.String("service", "", "scope the key to one service id")
		asJSON := fs.Bool("json", false, "JSON output")
		label := ""
		if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
			label, args = args[0], args[1:]
		}
		_ = fs.Parse(args)
		if label == "" {
			fmt.Fprintln(os.Stderr, "usage: finch keys mint <label> (--service <id> | --all)")
			os.Exit(2)
		}
		var scope any
		switch {
		case *all:
			scope = map[string]bool{"all": true}
		case *service != "":
			scope = map[string][]string{"services": {*service}}
		default:
			fmt.Fprintln(os.Stderr, "finch: scope the key with --service <id> (or --all)")
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
		fmt.Fprintln(os.Stderr, "usage: finch keys [list | mint <label> --service <id> | revoke <id>]")
		os.Exit(2)
	}
}

// cmdFleet: finch fleet [--json] — list this tenant's services + state.
func cmdFleet(args []string) {
	fs := flag.NewFlagSet("fleet", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "JSON output")
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
	apps, _ := st["services"].([]any)
	if *asJSON {
		b, _ := json.Marshal(apps)
		fmt.Println(string(b))
		return
	}
	if len(apps) == 0 {
		fmt.Println("no services — `finch add <path> --service <url>`")
		return
	}
	for _, a := range apps {
		m, _ := a.(map[string]any)
		fmt.Printf("  %-16v %v\n", m["id"], m["state"])
	}
}

// cmdRm: finch rm <service> — remove a service from the tenant.
func cmdRm(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "usage: finch rm <service>")
		os.Exit(2)
	}
	cred, err := loadCliCred()
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: %v\n", err)
		os.Exit(1)
	}
	if _, err := cliRequest("POST", cred.Hub, "/api/cli/services/release", cred.Token, map[string]string{"id": args[0]}); err != nil {
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
	asJSON := fs.Bool("json", false, "JSON output")
	configPath := fs.String("config", defaultManifestPath(), "finch.yml to summarize")
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
// One-shot convenience for a logged-in box: it enrolls the service via the CLI
// token, saves the box-side refresh credential (so `finch run` resumes without a
// ticket), and appends a ticketless ingress rule to finch.yml.
func cmdAdd(args []string) {
	fs := flag.NewFlagSet("add", flag.ExitOnError)
	service := fs.String("service", "", "local server URL to expose (required), e.g. http://127.0.0.1:8000")
	configPath := fs.String("config", defaultManifestPath(), "finch.yml to append the ingress rule to")
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

	// Enroll the service via the CLI token. The hub slugifies the name into the
	// real service id; use THAT as the app_path so the URL matches.
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
	// the manifest's `box:` (falling back to the hostname), and the credential
	// MUST land in the manifest's credentials-dir so `finch run` finds it.
	host, _ := os.Hostname()
	box, credDir := addPaths(*configPath, host)

	// Trade the ticket for a saved box-side credential now (so the ticket never
	// lands in the manifest), then append a ticketless ingress rule.
	statePath := filepath.Join(credDir, id+".json")
	if _, _, eerr := enrollToState(cred.Hub, box, ticket, statePath); eerr != nil {
		fmt.Fprintf(os.Stderr, "finch: enroll failed: %v\n", eerr)
		os.Exit(1)
	}
	if err := appendIngress(*configPath, cred.Hub, id, *service, box); err != nil {
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

// cmdEnroll: finch enroll <app_path> --ticket <t> [--hub …] [--box …] [--credentials-dir …]
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
	// Default --box to finch.yml's `box:` when a manifest is present, so the
	// box registers under the name the manifest declares; else the hostname.
	host, _ := os.Hostname()
	box := fs.String("box", configBox("finch.yml", host), "this box's name")
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
		fmt.Fprintln(os.Stderr, "  mint the ticket in the dashboard (Add box); <app_path> is the service/URL segment")
		fmt.Fprintln(os.Stderr, "  keep it off argv/history: 'echo <t> | finch enroll <app_path> --ticket -' or set FINCH_TICKET")
		os.Exit(2)
	}
	if strings.ContainsAny(appPath, "/ ") {
		fmt.Fprintf(os.Stderr, "finch: <app_path> %q must be a single URL segment (no slashes or spaces)\n", appPath)
		os.Exit(2)
	}

	// Join FIRST so we can name the credential by the hub's slugified service id
	// (the relay resolves the service by THAT id, so `finch enroll Printer` must
	// land as "printer", not the raw arg, or its URL/credential never matches).
	jr, err := join(*hub, ticketVal, *box)
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: enroll failed: %v\n", err)
		os.Exit(1)
	}
	id := jr.Service
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

// configBox returns the finch.yml `box:` at configPath, or host when the
// manifest is absent / sets no box — so `finch enroll`/`finch add` register
// the box under the name the manifest declares (matching the run-time log line).
func configBox(configPath, host string) string {
	if c, err := loadConfig(configPath, host); err == nil && c.Box != "" {
		return c.Box
	}
	return host
}

// addPaths resolves the box name + credentials dir `finch add` should use,
// honoring an existing finch.yml at configPath (best-effort): the credential must
// land in the manifest's credentials-dir so `finch run` finds it, and the box
// should register under the manifest's box name. Falls back to the hostname +
// the default ~/.finch when the manifest is absent. loadConfig already expands ~
// and applies the credentials-dir default, so its values are used as-is.
func addPaths(configPath, host string) (box, credDir string) {
	box, credDir = host, defaultCredentialsDir()
	if c, err := loadConfig(configPath, host); err == nil {
		if c.Box != "" {
			box = c.Box
		}
		if c.CredentialsDir != "" {
			credDir = c.CredentialsDir
		}
	}
	return box, credDir
}

// appendIngress adds (or updates) one ingress rule in finch.yml WITHOUT clobbering
// user comments or keys finch doesn't model: it edits an existing file through a
// yaml.Node (yaml.v3 preserves comments + unknown content across a Node round-trip)
// rather than unmarshaling into the fixed `config` struct and re-marshaling. An
// existing rule with the same app_path is updated in place; hub/box are filled
// only when absent. A missing file is created from the managed header + a minimal
// struct marshal. No ticket is written — the credential is saved separately by enroll.
func appendIngress(configPath, hub, appPath, service, box string) error {
	b, err := os.ReadFile(configPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		// New file: a minimal struct marshal under the managed header is fine.
		if box == "" {
			box, _ = os.Hostname()
		}
		c := config{Hub: hub, Box: box, Ingress: []ingress{{AppPath: appPath, Service: service}}}
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

	// Fill hub/box only when absent (don't overwrite a user's values).
	if yamlMapValue(root, "hub") == nil && hub != "" {
		yamlMapSet(root, "hub", yamlScalar(hub))
	}
	if yamlMapValue(root, "box") == nil {
		if box == "" {
			box, _ = os.Hostname()
		}
		if box != "" {
			yamlMapSet(root, "box", yamlScalar(box))
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
	// A fresh manifest may target ~/.finch/finch.yml before anything else has
	// created the dotfile dir (defaultManifestPath).
	if dir := filepath.Dir(configPath); dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	return os.WriteFile(configPath, out, 0o600)
}

// cmdUpdate: finch update [--hub URL] [--force] [--restart=auto|service|self|none]
//
// Self-update the box: fetch the latest release binary from $HUB/releases/
// finch-<os>-<arch>, atomically swap it over this executable, then bring the
// RUNNING serve onto the new version without leaving two `finch run` processes
// fighting over the relay socket (the "superseded" flap). Restart strategy:
//
//   service — if a `finch-tunnel` systemd --user service manages the serve,
//             `systemctl --user restart` it: the old process is stopped BEFORE
//             the new one starts, so the hub never sees two live sockets.
//   self    — exec the freshly-installed binary over THIS process (portable, no
//             service manager). A running `finch run` becomes the new version in
//             place (~1s relay blip); a bare `finch update` just re-execs and
//             exits after reporting the version.
//   auto    — service when a finch-tunnel service is detected, else self.
//   none    — swap the binary only; leave the running process alone (you restart
//             it). Useful in scripts.
func cmdUpdate(args []string) {
	fs := flag.NewFlagSet("update", flag.ExitOnError)
	hubFlag := fs.String("hub", "", "finch hub base URL (defaults to the logged-in hub)")
	force := fs.Bool("force", false, "reinstall even if already on the latest version")
	restart := fs.String("restart", "auto", "how to restart the running serve: auto|service|self|none")
	_ = fs.Parse(args)

	// Hub: explicit flag, else the logged-in cli.json hub, else the prod default.
	hub := *hubFlag
	if hub == "" {
		if c := loadCliCredQuiet(); c != nil && c.Hub != "" {
			hub = c.Hub
		} else {
			hub = "https://finchmcp.com"
		}
	}
	hub = strings.TrimRight(hub, "/")

	self, updated, err := performUpdate(hub, *force)
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: update failed: %v\n", err)
		os.Exit(1)
	}
	if !updated {
		fmt.Printf("finch: already on the latest version (%s)\n", agentVersion)
		return
	}
	fmt.Printf("finch: installed new binary at %s\n", self)

	// Bring the running serve onto the new binary.
	mode := *restart
	if mode == "auto" {
		if finchTunnelActive() {
			mode = "service"
		} else {
			mode = "self"
		}
	}
	switch mode {
	case "none":
		fmt.Println("finch: binary swapped — restart your serve to apply.")
	case "service":
		fmt.Println("finch: restarting finch-tunnel.service (clean handoff, no supersede)…")
		out, rerr := exec.Command("systemctl", "--user", "restart", "finch-tunnel.service").CombinedOutput()
		if rerr != nil {
			fmt.Fprintf(os.Stderr, "finch: service restart failed: %v\n%s\n", rerr, out)
			fmt.Fprintln(os.Stderr, "finch: binary IS updated — restart the serve manually.")
			os.Exit(1)
		}
		fmt.Println("finch: finch-tunnel restarted on the new version.")
	case "self":
		// Re-exec this process over the new binary. syscall.Exec REPLACES the
		// process image, so a running `finch run` continues as the new version
		// (its relay reconnects) and a bare `finch update` simply re-runs on the
		// new binary. Args after "update" are dropped so we don't re-update.
		reexec := []string{self}
		if runningAsServe() {
			reexec = append(reexec, "run")
		}
		fmt.Println("finch: re-exec onto the new binary…")
		if eerr := syscallExec(self, reexec); eerr != nil {
			fmt.Fprintf(os.Stderr, "finch: re-exec failed: %v (binary is updated; restart manually)\n", eerr)
			os.Exit(1)
		}
	default:
		fmt.Fprintf(os.Stderr, "finch: unknown --restart mode %q (use auto|service|self|none)\n", mode)
		os.Exit(1)
	}
}

// performUpdate is the shared self-update core used by BOTH `finch update` (CLI)
// and the hub-pushed remote update (relay "update" frame): version-gate against
// the hub's /api/version (skip when already current, unless force), then fetch
// $HUB/releases/finch-<os>-<arch> and atomically swap it over this executable.
// Returns the resolved binary path and whether a swap actually happened. The
// download source is ALWAYS the box's own hub — never caller-supplied — so a
// forged trigger can at worst cause a re-download of the pinned release.
func performUpdate(hub string, force bool) (self string, updated bool, err error) {
	hub = strings.TrimRight(hub, "/")
	if !force {
		if latest, verr := hubLatestVersion(hub); verr == nil && latest != "" && latest == agentVersion {
			return "", false, nil
		}
	}
	// Resolve THIS executable's real path — the atomic swap target. Follow the
	// symlink so we replace the actual file, not a symlink into it.
	self, err = os.Executable()
	if err != nil {
		return "", false, fmt.Errorf("cannot locate own binary: %w", err)
	}
	if resolved, rerr := filepath.EvalSymlinks(self); rerr == nil {
		self = resolved
	}
	asset := fmt.Sprintf("finch-%s-%s", runtime.GOOS, updateArch())
	if err := downloadAndSwap(hub+"/releases/"+asset, self); err != nil {
		return self, false, err
	}
	return self, true, nil
}

// updateInFlight makes hub-pushed updates singleflight: repeated "update" frames
// (retries, double-clicks) are dropped while one attempt is running.
var updateInFlight atomic.Bool

// selfUpdateFromHub handles a hub-pushed relay "update" frame: swap the binary
// via performUpdate, then re-exec THIS process in place (same PID — safe under
// systemd and bare alike; the relay drops for ~1s and reconnects as the new
// version, so there are never two serves fighting over the socket). On any
// failure it logs and keeps serving on the old binary — a broken update must
// never take the box offline.
func selfUpdateFromHub(hub string) {
	if !updateInFlight.CompareAndSwap(false, true) {
		return
	}
	defer updateInFlight.Store(false)
	self, updated, err := performUpdate(hub, false)
	if err != nil {
		log.Printf("finch: hub-pushed update failed: %v (still serving on %s)", err, agentVersion)
		return
	}
	if !updated {
		log.Printf("finch: hub-pushed update: already on the latest version (%s)", agentVersion)
		return
	}
	log.Printf("finch: hub-pushed update installed — re-exec onto the new binary")
	if err := syscallExec(self, os.Args); err != nil {
		log.Printf("finch: re-exec failed: %v (binary is updated; restart to apply)", err)
	}
}

// updateArch maps Go's GOARCH to the goreleaser asset arch suffix (arm → armv6/
// armv7 by GOARM). Matches the naming in .goreleaser.yaml and installScript().
func updateArch() string {
	switch runtime.GOARCH {
	case "arm":
		if os.Getenv("GOARM") == "7" {
			return "armv7"
		}
		return "armv6"
	default:
		return runtime.GOARCH // amd64, arm64
	}
}

// hubLatestVersion asks the hub for the current LATEST_AGENT so `finch update`
// can no-op when already current. Best-effort: any error → "" (caller updates
// anyway). The hub exposes it at /api/version (public, unauthenticated).
func hubLatestVersion(hub string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, hub+"/api/version", nil)
	if err != nil {
		return "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("hub %d", res.StatusCode)
	}
	var body struct {
		Latest string `json:"latest"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", err
	}
	return body.Latest, nil
}

// downloadAndSwap fetches url to a temp file NEXT TO dst (same dir → atomic
// rename), makes it executable, then renames it over dst. Downloading to a temp
// first means a failed/partial download never bricks the running binary; the
// rename is atomic on POSIX so there's no torn-write window.
func downloadAndSwap(url, dst string) error {
	res, err := http.Get(url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("download %s: hub %d", url, res.StatusCode)
	}
	dir := filepath.Dir(dst)
	tmp, err := os.CreateTemp(dir, ".finch-update-*")
	if err != nil {
		return fmt.Errorf("temp file in %s: %w (need write access to install dir)", dir, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename
	if _, err := io.Copy(tmp, res.Body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return err
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return fmt.Errorf("installing over %s: %w", dst, err)
	}
	return nil
}

// finchTunnelActive reports whether a running finch-tunnel systemd --user
// service is managing the serve (the clean-restart target).
func finchTunnelActive() bool {
	out, _ := exec.Command("systemctl", "--user", "is-active", "finch-tunnel.service").Output()
	return strings.TrimSpace(string(out)) == "active"
}
