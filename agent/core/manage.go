package core

// manage.go — in-process appliance management for embedders (the desktop tray).
// These mirror the `finch fleet` / `finch add` / `finch rm` CLI commands but return
// errors instead of calling os.Exit, so a GUI can list, add, and remove appliances
// without shelling out to the finch binary. They reuse the exact same CLI-token
// requests, enroll-to-credential, and comment-preserving finch.yml edits.

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// AppInfo is one appliance as the hub reports it: its id (the app_path / URL
// segment) and current state ("chirping"/"pending"/"invited"/…).
type AppInfo struct {
	ID    string
	State string
}

// Fleet lists this account's appliances (GET /api/cli/state). Requires `finch
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
	apps, _ := st["appliances"].([]any)
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

// Add enrolls an appliance and appends a ticketless ingress rule to configPath —
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
	machine, credDir := addPaths(configPath, host)
	statePath := filepath.Join(credDir, id+".json")
	if _, _, eerr := enrollToState(cred.Hub, machine, ticket, statePath); eerr != nil {
		return "", "", fmt.Errorf("saving credential failed: %w", eerr)
	}
	if werr := appendIngress(configPath, cred.Hub, id, service, machine); werr != nil {
		return "", "", fmt.Errorf("could not write %s: %w", configPath, werr)
	}
	return id, publicURL, nil
}

// Remove releases an appliance from the tenant (the in-process equivalent of
// `finch rm <appPath>`) and drops its ingress rule from configPath. The local
// finch.yml edit is best-effort — a hub-side removal that succeeds is reported as
// success even if the manifest couldn't be rewritten.
func Remove(configPath, appPath string) error {
	cred, err := loadCliCred()
	if err != nil {
		return err
	}
	if _, err := cliRequest("POST", cred.Hub, "/api/cli/appliances/release", cred.Token, map[string]string{"id": appPath}); err != nil {
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
