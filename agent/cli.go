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
  finch join --ticket <t> --upstream <url>   Run one appliance straight from flags
  finch help                           Show this help

Typical first-time setup:
  finch login --hub https://finchmcp.com <token>
  finch add printer --service http://127.0.0.1:8000 --name "Label Printer"
  finch run

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

// cmdAdd: finch add <path> --service <url> [--name "..."] [--config finch.toml]
func cmdAdd(args []string) {
	fs := flag.NewFlagSet("add", flag.ExitOnError)
	service := fs.String("service", "", "local MCP server URL to expose (required), e.g. http://127.0.0.1:8000")
	name := fs.String("name", "", "friendly application name (defaults to <path>)")
	configPath := fs.String("config", "finch.toml", "finch.toml to append the ingress rule to")

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
