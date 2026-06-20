package main

// finch CLI setup commands — `finch login` and `finch add`. Together they let a
// box enroll appliances and build its finch.toml without ever touching the
// dashboard (cloudflared's `tunnel login` + `tunnel create`):
//
//	finch login <token>                         # paste the CLI token from the dashboard
//	finch add printer --service http://:8000     # enroll + append an [[ingress]] rule
//	finch run                                    # serve everything in finch.toml
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
)

// printUsage is the top-level `finch help` — an overview of the subcommands.
// (Go's flag package only prints per-flag usage; this ties it together.)
func printUsage() {
	fmt.Print(`finch — publish local MCP servers through the finch hub. Your box dials OUT,
so nothing listens and no ports are opened.

Usage:
  finch login [--hub URL]              Log in (opens the browser to approve a code)
  finch add <path> --service <url>     Enroll an appliance and append it to finch.toml
                    [--name "App"]        <path> becomes the URL: <slug>.finchmcp.com/<path>/mcp
  finch run [--config finch.toml]      Serve every [[ingress]] rule (auto-approves when logged in)
  finch approve <path>                 Approve an appliance (clear the pending gate)
  finch token [--json|--login]         Mint a fresh CLI token (provision a new box, no browser)
  finch status [--json]                Show login + what finch.toml serves
  finch fleet [--json]   (alias: ls)   List this account's appliances + state
  finch test <appliance>               List an appliance's MCP tools (does-it-work check)
  finch call <appliance> <tool> [--args '{...}']   Invoke one tool through the hub
  finch keys [list|mint <label> --appliance <id>|revoke <id>]   Manage client finch_ keys
  finch rm <appliance>                 Remove an appliance
  finch revoke-tokens                  De-authorize every CLI login (incl. this box)
  finch join --ticket <t> --upstream <url>   Run one appliance straight from flags
  finch help                           Show this help

Typical first-time setup:
  finch login --hub https://finchmcp.com   # browser approval, once
  finch add printer --service http://127.0.0.1:8000 --name "Label Printer"
  finch run

Automation / driving finch from an agent (after the one-time 'finch login'):
  Everything below is non-interactive and supports --json. No browser, no
  dashboard. The CLI token is a tenant-admin credential, so an agent can do the
  whole loop: introspect, serve, test, and grant/revoke access.

  Introspect:
    finch status --json            # am I logged in? what does finch.toml serve?
    finch fleet --json             # every appliance + its state

  Serve a local MCP server:
    finch add scraper --service http://127.0.0.1:8001 --json
    finch run                      # serves all finch.toml rules, auto-approves

  Test an endpoint:
    finch test scraper             # list its MCP tools
    finch call scraper search --args '{"q":"finch"}'   # invoke one tool

  Grant + REVOKE client access (the finch_ keys callers present):
    finch keys mint web-client --appliance scraper     # prints a finch_ key once
    finch keys list
    finch keys revoke <id>         # access stops immediately
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
	if token == "" {
		token = deviceLogin(*hub)
	}

	// Validate against the hub and learn which tenant the token acts as.
	who, err := cliRequest("GET", *hub, "/api/cli/whoami", token, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "finch: login failed: %v\n", err)
		os.Exit(1)
	}
	if err := saveCliCred(&cliCred{Hub: *hub, Token: token}); err != nil {
		fmt.Fprintf(os.Stderr, "finch: could not save credential: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("finch: logged in to tenant %v at %s (saved to %s)\n", who["tenant"], *hub, cliCredPath())
}

// deviceLogin runs the browser device-authorization flow (`finch login` with no
// token): start a code, point the user at the dashboard to approve it, poll
// until approved, and return the issued token. Exits on error/expiry/timeout.
func deviceLogin(hub string) string {
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
				return tok
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
	return ""
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
//   ssh newbox "finch login --token $(finch token)"
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

// cmdStatus: finch status [--json] — introspect login + finch.toml (for agents).
func cmdStatus(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "machine-readable JSON")
	configPath := fs.String("config", "finch.toml", "finch.toml to summarize")
	_ = fs.Parse(args)

	type ingressStatus struct {
		Name    string `json:"name,omitempty"`
		Path    string `json:"path"`
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
			st.Ingress = append(st.Ingress, ingressStatus{Name: ing.Name, Path: ing.Path, Service: ing.Service})
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
			n := ing.Name
			if n == "" {
				n = ing.Path
			}
			fmt.Printf("  • %-16s %s → %s\n", ing.Path, n, ing.Service)
		}
	} else {
		fmt.Println("no finch.toml here — `finch add <path> --service <url>` to create one")
	}
}

// cmdAdd: finch add <path> --service <url> [--name "..."] [--config finch.toml]
func cmdAdd(args []string) {
	fs := flag.NewFlagSet("add", flag.ExitOnError)
	service := fs.String("service", "", "local MCP server URL to expose (required), e.g. http://127.0.0.1:8000")
	name := fs.String("name", "", "friendly application name (defaults to <path>)")
	configPath := fs.String("config", "finch.toml", "finch.toml to append the ingress rule to")
	asJSON := fs.Bool("json", false, "print the result as JSON (for scripts/agents)")

	// Go's flag parser stops at the first positional, so pull a leading <path>
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
		fmt.Fprintln(os.Stderr, "usage: finch add <path> --service <url> [--name \"App Name\"]")
		fmt.Fprintln(os.Stderr, "  <path> becomes the public URL segment: https://<your-slug>.finchmcp.com/<path>/mcp")
		os.Exit(2)
	}
	if strings.ContainsAny(wantPath, "/ ") {
		fmt.Fprintf(os.Stderr, "finch: <path> %q must be a single URL segment (no slashes or spaces)\n", wantPath)
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
	// real appliance id; use THAT as the path so the URL matches.
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

	appName := *name
	if appName == "" {
		appName = wantPath
	}
	if err := appendIngress(*configPath, cred.Hub, appName, id, *service, ticket); err != nil {
		fmt.Fprintf(os.Stderr, "finch: could not write %s: %v\n", *configPath, err)
		os.Exit(1)
	}
	if *asJSON {
		b, _ := json.Marshal(map[string]string{"path": id, "name": appName, "service": *service, "url": pubURL, "config": *configPath})
		fmt.Println(string(b))
		return
	}
	fmt.Printf("finch: added %q → %s\n", appName, *service)
	if pubURL != "" {
		fmt.Printf("       public endpoint: %s\n", pubURL)
	}
	fmt.Printf("       wrote rule to %s — run `finch run` to serve it\n", *configPath)
}

// appendIngress appends an [[ingress]] block to a finch.toml, creating the file
// with a hub/machine header first if it doesn't exist yet.
func appendIngress(configPath, hub, name, path, service, ticket string) error {
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		host, _ := os.Hostname()
		header := fmt.Sprintf("# finch.toml — generated by `finch add`\nhub     = %q\nmachine = %q\n", hub, host)
		if err := os.WriteFile(configPath, []byte(header), 0o600); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(configPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	block := fmt.Sprintf("\n[[ingress]]\nname    = %q\npath    = %q\nservice = %q\nticket  = %q\n", name, path, service, ticket)
	_, err = f.WriteString(block)
	return err
}
