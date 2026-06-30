package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeYAML(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "finch.yml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadConfig_OK(t *testing.T) {
	p := writeYAML(t, `
hub: https://hub.example.com
machine: box1
credentials-dir: /var/finch
ingress:
  - app_path: printer
    service: http://127.0.0.1:8001
  - app_path: transcribe
    service: http://127.0.0.1:8002
`)
	c, err := loadConfig(p, "fallback-host")
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if c.Hub != "https://hub.example.com" || c.Machine != "box1" {
		t.Fatalf("top-level mismatch: %+v", c)
	}
	if len(c.Ingress) != 2 {
		t.Fatalf("want 2 ingress, got %d", len(c.Ingress))
	}
	if c.Ingress[0].AppPath != "printer" || c.Ingress[0].Service != "http://127.0.0.1:8001" {
		t.Fatalf("ingress[0] mismatch: %+v", c.Ingress[0])
	}
	if got := c.statePathFor("printer"); got != filepath.Join("/var/finch", "printer.json") {
		t.Fatalf("statePathFor: %q", got)
	}
}

func TestLoadConfig_Defaults(t *testing.T) {
	p := writeYAML(t, `
ingress:
  - app_path: a
    service: http://127.0.0.1:8000
`)
	c, err := loadConfig(p, "fallback-host")
	if err != nil {
		t.Fatal(err)
	}
	if c.Hub != "https://finchmcp.com" {
		t.Fatalf("hub default: %q", c.Hub)
	}
	if c.Machine != "fallback-host" {
		t.Fatalf("machine default: %q", c.Machine)
	}
}

// addPaths/configMachine must honor the finch.yml `machine:` + `credentials-dir:`
// so `finch add`/`finch enroll` register under the manifest name and write the
// credential where `finch run` looks (findings #3 + #13).
func TestAddPaths(t *testing.T) {
	p := writeYAML(t, `
machine: box1
credentials-dir: /var/finch
ingress:
  - app_path: printer
    service: http://127.0.0.1:8001
`)
	machine, credDir := addPaths(p, "fallback-host")
	if machine != "box1" {
		t.Errorf("machine = %q, want box1 (from finch.yml)", machine)
	}
	if credDir != "/var/finch" {
		t.Errorf("credDir = %q, want /var/finch (from finch.yml)", credDir)
	}
	// Missing manifest -> hostname + default credentials dir.
	machine, credDir = addPaths(filepath.Join(t.TempDir(), "nope.yml"), "fallback-host")
	if machine != "fallback-host" {
		t.Errorf("machine = %q, want fallback-host when no finch.yml", machine)
	}
	if credDir != defaultCredentialsDir() {
		t.Errorf("credDir = %q, want default %q", credDir, defaultCredentialsDir())
	}
}

func TestConfigMachine(t *testing.T) {
	p := writeYAML(t, "machine: lab-mini\n")
	if got := configMachine(p, "host"); got != "lab-mini" {
		t.Errorf("configMachine = %q, want lab-mini", got)
	}
	if got := configMachine(filepath.Join(t.TempDir(), "nope.yml"), "host"); got != "host" {
		t.Errorf("configMachine(missing) = %q, want host", got)
	}
}

// appendIngress edits through a yaml.Node, so hand-written comments and keys finch
// doesn't model SURVIVE a `finch add` (finding #9).
func TestAppendIngress_PreservesComments(t *testing.T) {
	p := filepath.Join(t.TempDir(), "finch.yml")
	original := `# my hand-written finch.yml
hub: https://hub.example.com
machine: box1   # the lab mac mini
# keep my printer rule
ingress:
  - app_path: printer
    service: http://127.0.0.1:8001
custom_key: keep-me   # finch doesn't model this
`
	if err := os.WriteFile(p, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := appendIngress(p, "https://hub.example.com", "scraper", "http://127.0.0.1:9000", "box1"); err != nil {
		t.Fatalf("appendIngress: %v", err)
	}
	out, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{
		"# my hand-written finch.yml",
		"# keep my printer rule",
		"the lab mac mini",
		"custom_key: keep-me",
		"# finch doesn't model this",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("appendIngress dropped %q from finch.yml:\n%s", want, s)
		}
	}
	// Both the old and the new rule must be present + parseable.
	c, err := loadConfig(p, "h")
	if err != nil {
		t.Fatalf("loadConfig after append: %v", err)
	}
	if len(c.Ingress) != 2 {
		t.Fatalf("want 2 ingress rules, got %d: %+v", len(c.Ingress), c.Ingress)
	}
}

// An existing rule with the same app_path is updated in place, not duplicated.
func TestAppendIngress_UpdatesInPlace(t *testing.T) {
	p := filepath.Join(t.TempDir(), "finch.yml")
	original := `hub: https://hub.example.com
machine: box1
ingress:
  - app_path: printer
    service: http://127.0.0.1:8001
`
	if err := os.WriteFile(p, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := appendIngress(p, "https://hub.example.com", "printer", "http://127.0.0.1:9999", "box1"); err != nil {
		t.Fatalf("appendIngress: %v", err)
	}
	c, err := loadConfig(p, "h")
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if len(c.Ingress) != 1 {
		t.Fatalf("same app_path must update in place, got %d rules: %+v", len(c.Ingress), c.Ingress)
	}
	if c.Ingress[0].Service != "http://127.0.0.1:9999" {
		t.Errorf("service not updated: %q", c.Ingress[0].Service)
	}
}

func TestLoadConfig_Rejects(t *testing.T) {
	cases := map[string]string{
		"missing service":   "ingress:\n  - app_path: a\n",
		"missing app_path":  "ingress:\n  - service: http://x\n",
		"slash in app_path": "ingress:\n  - app_path: a/b\n    service: http://x\n",
		"duplicate app_path": "ingress:\n  - app_path: a\n    service: http://x\n" +
			"  - app_path: a\n    service: http://y\n",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := loadConfig(writeYAML(t, body), "h"); err == nil {
				t.Fatalf("expected rejection for %s", name)
			}
		})
	}
}
