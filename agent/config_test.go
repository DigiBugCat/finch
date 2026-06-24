package main

import (
	"os"
	"path/filepath"
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
