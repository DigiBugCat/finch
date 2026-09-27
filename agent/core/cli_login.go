package core

// `finch login`: the browser device-authorization flow, in two shapes.
//
//	finch login            blocking — print the link + code, poll until approved
//	finch login --start    agent step 1 — save the pending code, print, exit 0
//	finch login --poll     agent step 2 — one poll: exit 0 approved, 10 pending, 11 expired
//
// The two-step form exists because an agent's tool call cannot usefully block
// for minutes while a human finds their phone: it shows the human the link,
// then polls on its own schedule. The pending device code is a bearer secret
// for minting a CLI token once approved, so it is stored like one (0600, via
// the hardened credential writer) and deleted as soon as it resolves.

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// pendingLogin is ~/.finch/login-pending.json.
type pendingLogin struct {
	Hub                     string `json:"hub"`
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	Interval                int    `json:"interval"`
	ExpiresAt               int64  `json:"expires_at"` // unix seconds
}

// loginNow and loginSleep are swapped by tests.
var (
	loginNow   = time.Now
	loginSleep = time.Sleep
	openURL    = openBrowser
)

func (p *pendingLogin) expired() bool { return loginNow().Unix() >= p.ExpiresAt }

func pendingLoginPath() string { return filepath.Join(finchHome(), "login-pending.json") }

func readPendingLogin() (*pendingLogin, error) {
	b, err := readCredentialFile(pendingLoginPath(), credentialStateLimit)
	if err != nil || b == nil {
		return nil, err
	}
	var p pendingLogin
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	if p.DeviceCode == "" || p.Hub == "" {
		return nil, fmt.Errorf("%s is incomplete", pendingLoginPath())
	}
	return &p, nil
}

func savePendingLogin(p *pendingLogin) error {
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return writeCredentialFile(pendingLoginPath(), b)
}

func clearPendingLogin() { _ = os.Remove(pendingLoginPath()) }

// startDeviceLogin asks the hub for a device code. expiresIn is in seconds.
func startDeviceLogin(hub string) (*pendingLogin, int, error) {
	start, err := cliRequest("POST", hub, "/api/cli/device/start", "", struct{}{})
	if err != nil {
		return nil, 0, hubFailure(err, "start login", "")
	}
	deviceCode, _ := start["device_code"].(string)
	userCode, _ := start["user_code"].(string)
	uri, _ := start["verification_uri_complete"].(string)
	if uri == "" {
		uri, _ = start["verification_uri"].(string)
	}
	if deviceCode == "" || userCode == "" || uri == "" {
		return nil, 0, newCLIError(codeUpstream, "", "start login: the hub returned an incomplete device code")
	}
	interval := 3
	if v, ok := start["interval"].(float64); ok && v >= 1 {
		interval = int(v)
	}
	expiresIn := 600
	if v, ok := start["expires_in"].(float64); ok && v >= 1 {
		expiresIn = int(v)
	}
	return &pendingLogin{
		Hub:                     hub,
		DeviceCode:              deviceCode,
		UserCode:                userCode,
		VerificationURIComplete: uri,
		Interval:                interval,
		ExpiresAt:               loginNow().Add(time.Duration(expiresIn) * time.Second).Unix(),
	}, expiresIn, nil
}

// pollDeviceLogin polls once. status is "approved", "pending" or "expired".
func pollDeviceLogin(p *pendingLogin) (status, token, email string, err error) {
	poll, err := cliRequest("POST", p.Hub, "/api/cli/device/poll", "", map[string]string{"device_code": p.DeviceCode})
	if err != nil {
		return "", "", "", hubFailure(err, "poll login", "finch login --poll")
	}
	switch s, _ := poll["status"].(string); s {
	case "approved":
		token, _ = poll["token"].(string)
		email, _ = poll["email"].(string)
		if token == "" {
			return "", "", "", newCLIError(codeUpstream, "finch login --start", "the hub approved the login but returned no token")
		}
		return "approved", token, email, nil
	case "pending":
		return "pending", "", "", nil
	case "expired", "not_found":
		return "expired", "", "", nil
	default:
		return "", "", "", newCLIError(codeUpstream, "", "poll login: unexpected status %q from the hub", s)
	}
}

// completeLogin saves an approved token, then learns the tenant for display.
// The token is saved FIRST: the hub hands it over exactly once, so a transient
// whoami failure must not throw it away.
func completeLogin(hub, token, email string) (account string, err error) {
	cred := &cliCred{Hub: hub, Token: token, Email: email}
	if err := saveCliCred(cred); err != nil {
		return "", newCLIError(codeInternal, "", "could not save the login to %s: %v", cliCredPath(), err)
	}
	if who, werr := cliRequest("GET", hub, "/api/cli/whoami", token, nil); werr == nil {
		if t, _ := who["tenant"].(string); t != "" {
			cred.Tenant = t
			_ = saveCliCred(cred)
		}
	}
	if cred.Email != "" {
		return cred.Email, nil
	}
	return cred.Tenant, nil
}

// runLogin: finch login [--hub URL] [--start | --poll | --token -] [--headless] [--json]
func runLogin(c *cli, args []string) error {
	fs := newFlagSet("login")
	hubFlag := fs.String("hub", agentDefaultHub(), "finch hub base URL")
	tokenFlag := fs.String("token", "", "CLI token; '-' reads it from stdin, or set FINCH_CLI_TOKEN (a literal value on argv is accepted but leaks into the process table and shell history)")
	headless := fs.Bool("headless", false, "blocking login without opening a local browser (the link works on any device)")
	start := fs.Bool("start", false, "start a login, save it to ~/.finch/login-pending.json, print the link + code, and exit")
	poll := fs.Bool("poll", false, "poll the login saved by --start once: exit 0 approved, 10 pending, 11 expired")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	hubSet := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "hub" {
			hubSet = true
		}
	})
	if *start && *poll {
		return usageError("login: --start and --poll are separate steps; pass one")
	}
	if (*start || *poll) && (*tokenFlag != "" || len(pos) > 0) {
		return usageError("login: --token cannot be combined with --start or --poll")
	}
	if len(pos) > 1 {
		return usageError("usage: finch login [--start | --poll | --token -]")
	}

	if *poll {
		return loginPoll(c, *hubFlag, hubSet)
	}
	hub, err := validateHubTransportURL(*hubFlag)
	if err != nil {
		return usageError("%v", err)
	}
	if *start {
		return loginStart(c, hub)
	}

	token := *tokenFlag
	if token == "" && len(pos) == 1 {
		token = pos[0]
	}
	token, fromArgv, err := resolveCliToken(token, c.stdin)
	if err != nil {
		return usageError("%v", err)
	}
	if token != "" {
		if fromArgv {
			fmt.Fprintln(c.stderr, "finch: warning: the CLI token was passed on the command line, so it lands in the process table (/proc/<pid>/cmdline) and shell/SSH history")
			fmt.Fprintln(c.stderr, "finch:          prefer:  finch token | ssh newbox 'finch login --token -'   (or set FINCH_CLI_TOKEN)")
		}
		// Validate against the hub before saving: a pasted token may be stale.
		who, err := cliRequest("GET", hub, "/api/cli/whoami", token, nil)
		if err != nil {
			return hubFailure(err, "login", "")
		}
		tenant, _ := who["tenant"].(string)
		if err := saveCliCred(&cliCred{Hub: hub, Token: token, Tenant: tenant}); err != nil {
			return newCLIError(codeInternal, "", "could not save the login to %s: %v", cliCredPath(), err)
		}
		return reportLoggedIn(c, hub, tenant)
	}
	return loginBlocking(c, hub, *headless)
}

func reportLoggedIn(c *cli, hub, account string) error {
	if c.json {
		return c.emit(map[string]any{"status": "approved", "account": account})
	}
	c.printf("finch: logged in as %s at %s (saved to %s)\n", account, hub, cliCredPath())
	return nil
}

func loginStart(c *cli, hub string) error {
	p, expiresIn, err := startDeviceLogin(hub)
	if err != nil {
		return err
	}
	if err := savePendingLogin(p); err != nil {
		return newCLIError(codeInternal, "", "could not save the pending login to %s: %v", pendingLoginPath(), err)
	}
	if c.json {
		return c.emit(map[string]any{
			"user_code":                 p.UserCode,
			"verification_uri_complete": p.VerificationURIComplete,
			"expires_in":                expiresIn,
			"interval":                  p.Interval,
		})
	}
	c.printf("To log in, open this link on any device (a phone is fine) and confirm the code:\n\n    %s\n\n", p.VerificationURIComplete)
	c.printf("Code: %s   (expires in %d minutes)\n\n", p.UserCode, (expiresIn+59)/60)
	c.printf("Then run 'finch login --poll' every %ds until it reports approved.\n", p.Interval)
	return nil
}

func loginPoll(c *cli, hubFlag string, hubSet bool) error {
	p, err := readPendingLogin()
	if err != nil {
		return newCLIError(codeInternal, "finch login --start", "reading %s: %v", pendingLoginPath(), err)
	}
	if p == nil {
		return newCLIError(codeNotFound, "finch login --start", "no login in progress")
	}
	if hubSet {
		if hub, err := validateHubTransportURL(hubFlag); err != nil || hub != p.Hub {
			return usageError("login --poll: the pending login is for %s; --hub must match or be omitted", p.Hub)
		}
	}
	status := "expired"
	var token, email string
	if !p.expired() {
		if status, token, email, err = pollDeviceLogin(p); err != nil {
			return err
		}
	}
	switch status {
	case "approved":
		clearPendingLogin() // the hub consumed the code
		account, err := completeLogin(p.Hub, token, email)
		if err != nil {
			return err
		}
		return reportLoggedIn(c, p.Hub, account)
	case "pending":
		if c.json {
			if err := c.emit(map[string]any{"status": "pending"}); err != nil {
				return err
			}
		} else {
			c.printf("finch: waiting for approval — open %s and confirm code %s, then run 'finch login --poll' again\n", p.VerificationURIComplete, p.UserCode)
		}
		return exitStatus(exitPending)
	default: // expired
		clearPendingLogin()
		if c.json {
			if err := c.emit(map[string]any{"status": "expired"}); err != nil {
				return err
			}
		} else {
			fmt.Fprintln(c.stderr, "finch: the login code expired — run 'finch login --start' again")
		}
		return exitStatus(exitExpired)
	}
}

// loginBlocking is plain `finch login`: print the link + code, open a browser
// unless headless, and poll until approved or expired.
func loginBlocking(c *cli, hub string, headless bool) error {
	p, _, err := startDeviceLogin(hub)
	if err != nil {
		return err
	}
	c.printf("\n  To finish login, open this page on any device (your phone or laptop\n  is fine — you do NOT need a browser on this machine):\n\n      %s\n\n  and confirm this code:  %s\n\n", p.VerificationURIComplete, p.UserCode)
	if !headless {
		openURL(p.VerificationURIComplete)
	}
	c.printf("  Waiting for approval")
	for !p.expired() {
		loginSleep(time.Duration(p.Interval) * time.Second)
		status, token, email, err := pollDeviceLogin(p)
		if err != nil {
			var ce *cliError
			if asCLIError(err, &ce) && ce.Code == codeUpstream {
				c.printf(".") // transient: keep waiting
				continue
			}
			return err
		}
		switch status {
		case "approved":
			c.printf("  ✓\n")
			account, err := completeLogin(hub, token, email)
			if err != nil {
				return err
			}
			return reportLoggedIn(c, hub, account)
		case "expired":
			c.printf("\n")
			return newCLIError(codeExpired, "finch login", "the login code expired before it was approved")
		default:
			c.printf(".")
		}
	}
	c.printf("\n")
	return newCLIError(codeExpired, "finch login", "timed out waiting for approval")
}

// openBrowser best-effort opens a URL in the user's browser.
func openBrowser(u string) {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	_ = exec.Command(name, u).Start()
}
