package core

// manage.go — in-process service management for embedders (the desktop tray).
// These mirror the `finch fleet` / `finch add` / `finch rm` CLI commands but return
// errors instead of calling os.Exit, so a GUI can list, add, and remove services
// without shelling out to the finch binary. They reuse the exact same CLI-token
// requests, enroll-to-credential, and comment-preserving finch.yml edits.

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// LoginInfo reports whether this box holds a saved CLI credential and, if so, the
// hub it's for and the signed-in user's email (empty for pre-email logins). Lets a
// GUI show the account and "Log in" vs "Log out".
func LoginInfo() (hub, email string, loggedIn bool) {
	if c := loadCliCredQuiet(); c != nil {
		return c.Hub, c.Email, true
	}
	return "", "", false
}

// Logout removes the saved CLI credential (the in-process equivalent of deleting
// ~/.finch/cli.json). Already-enrolled services keep working from their own
// refresh credentials; this only drops the admin CLI token.
func Logout() error {
	if err := os.Remove(cliCredPath()); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Login runs the browser device-authorization flow against hub (the in-process,
// non-fatal equivalent of `finch login`): it starts a code, invokes onCode with
// the verification URL + short code for the caller to display/open, polls until
// approved, and saves the CLI credential. Blocks until approved, expired, or timed
// out — call it from a goroutine.
func Login(hub string, onCode func(verificationURI, userCode string)) error {
	if hub == "" {
		hub = "https://finchmcp.com"
	}
	start, err := cliRequest("POST", hub, "/api/cli/device/start", "", struct{}{})
	if err != nil {
		return fmt.Errorf("could not start login: %w", err)
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
	if onCode != nil {
		onCode(uri, userCode)
	}
	deadline := time.Now().Add(time.Duration(expires) * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(time.Duration(interval) * time.Second)
		poll, perr := cliRequest("POST", hub, "/api/cli/device/poll", "", map[string]string{"device_code": deviceCode})
		if perr != nil {
			continue
		}
		switch poll["status"] {
		case "approved":
			tok, _ := poll["token"].(string)
			if tok == "" {
				return fmt.Errorf("approval returned no token")
			}
			email, _ := poll["email"].(string)
			return saveCliCred(&cliCred{Hub: hub, Token: tok, Email: email})
		case "expired", "not_found":
			return fmt.Errorf("login code expired — try again")
		}
	}
	return fmt.Errorf("timed out waiting for approval")
}

// AppInfo is one service as the hub reports it: its id (the app_path / URL
// segment) and current state ("chirping"/"pending"/"invited"/…).
type AppInfo struct {
	ID    string
	State string
}

// Fleet lists this account's services (GET /api/cli/state). Requires `finch
// login`. The in-process equivalent of `finch fleet`.
func Fleet() ([]AppInfo, error) {
	cred, err := loadCliCred()
	if err != nil {
		return nil, err
	}
	st, err := cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
	if err != nil {
		return nil, err
	}
	apps, _ := st["services"].([]any)
	out := make([]AppInfo, 0, len(apps))
	for _, a := range apps {
		m, _ := a.(map[string]any)
		id, _ := m["id"].(string)
		state, _ := m["state"].(string)
		if id != "" {
			out = append(out, AppInfo{ID: id, State: state})
		}
	}
	return out, nil
}

// Node is one service-on-a-box as the hub reports it (the tenant's fleet is
// a flat list of these). Lets a GUI group by Box — "this box" vs "other
// boxes", Tailscale-style.
type Node struct {
	Box       string // the box's name
	Service   string // the service id it serves
	State     string // "chirping"/"in_use"/"offline"/…
	OS        string
	Connected bool
}

// FleetNodes returns every service-on-a-box across the tenant (the flattened
// `boxes` list from GET /api/cli/state). Requires `finch login`.
func FleetNodes() ([]Node, error) {
	cred, err := loadCliCred()
	if err != nil {
		return nil, err
	}
	st, err := cliRequest("GET", cred.Hub, "/api/cli/state", cred.Token, nil)
	if err != nil {
		return nil, err
	}
	ms, _ := st["boxes"].([]any)
	out := make([]Node, 0, len(ms))
	for _, mi := range ms {
		m, _ := mi.(map[string]any)
		if m == nil {
			continue
		}
		name, _ := m["name"].(string)
		conn, _ := m["connected"].(bool)
		n := Node{Box: name, Connected: conn}
		n.Service, _ = m["service"].(string)
		n.State, _ = m["state"].(string)
		n.OS, _ = m["os"].(string)
		if name != "" {
			out = append(out, n)
		}
	}
	return out, nil
}

// Add enrolls a service and appends a ticketless ingress rule to configPath —
// the in-process equivalent of `finch add <appPath> --service <service>`. It
// returns the registered id (the hub slugifies the name, so it may differ from
// appPath) and the public URL. Requires `finch login`.
func Add(configPath, appPath, service string) (id, publicURL string, err error) {
	appPath = strings.TrimSpace(appPath)
	service = strings.TrimSpace(service)
	if appPath == "" || service == "" {
		return "", "", fmt.Errorf("app_path and service are required")
	}
	if strings.ContainsAny(appPath, "/ ") {
		return "", "", fmt.Errorf("app_path %q must be a single URL segment (no slashes or spaces)", appPath)
	}
	if u, e := url.Parse(strings.TrimRight(service, "/")); e != nil || u.Scheme == "" || u.Host == "" {
		return "", "", fmt.Errorf("service %q is not a valid absolute URL (e.g. http://127.0.0.1:8000)", service)
	}

	cred, err := loadCliCred()
	if err != nil {
		return "", "", err
	}
	// Enroll via the CLI token; the hub returns the host-safe slug id + a one-shot
	// ticket we immediately trade for a saved credential (so it never hits disk in
	// the manifest).
	out, err := cliRequest("POST", cred.Hub, "/api/cli/enroll", cred.Token, map[string]string{"name": appPath})
	if err != nil {
		return "", "", fmt.Errorf("enroll failed: %w", err)
	}
	id, _ = out["id"].(string)
	ticket, _ := out["ticket"].(string)
	publicURL, _ = out["url"].(string)
	if id == "" || ticket == "" {
		return "", "", fmt.Errorf("unexpected enroll response from hub")
	}

	host, _ := os.Hostname()
	box, credDir := addPaths(configPath, host)
	statePath := filepath.Join(credDir, id+".json")
	if _, _, eerr := enrollToState(cred.Hub, box, ticket, statePath); eerr != nil {
		return "", "", fmt.Errorf("saving credential failed: %w", eerr)
	}
	if werr := appendIngress(configPath, cred.Hub, id, service, box); werr != nil {
		return "", "", fmt.Errorf("could not write %s: %w", configPath, werr)
	}
	return id, publicURL, nil
}

// Remove releases a service from the tenant (the in-process equivalent of
// `finch rm <appPath>`) and drops its ingress rule from configPath. The local
// finch.yml edit is best-effort — a hub-side removal that succeeds is reported as
// success even if the manifest couldn't be rewritten.
func Remove(configPath, appPath string) error {
	cred, err := loadCliCred()
	if err != nil {
		return err
	}
	if _, err := cliRequest("POST", cred.Hub, "/api/cli/services/release", cred.Token, map[string]string{"id": appPath}); err != nil {
		return err
	}
	_ = removeIngress(configPath, appPath)
	return nil
}

// removeIngress drops the ingress rule with the given app_path from finch.yml,
// preserving comments + unmodeled keys via a yaml.Node round-trip (the mirror of
// appendIngress). A missing file or absent rule is a no-op.
func removeIngress(configPath, appPath string) error {
	b, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var doc yaml.Node
	if uerr := yaml.Unmarshal(b, &doc); uerr != nil {
		return fmt.Errorf("parsing %s: %w", configPath, uerr)
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) == 0 {
		return nil
	}
	root := doc.Content[0]
	seq := yamlMapValue(root, "ingress")
	if seq == nil || seq.Kind != yaml.SequenceNode {
		return nil
	}
	kept := seq.Content[:0]
	for _, item := range seq.Content {
		if ap := yamlMapValue(item, "app_path"); ap != nil && ap.Value == appPath {
			continue // drop this rule
		}
		kept = append(kept, item)
	}
	seq.Content = kept
	return yamlWriteFile(configPath, &doc)
}
