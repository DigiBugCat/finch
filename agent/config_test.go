package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeTOML(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "finch.toml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadConfig_OK(t *testing.T) {
	p := writeTOML(t, `
hub     = "https://hub.example.com"
machine = "box1"
state   = "/var/finch"

[[ingress]]
path    = "printer"
service = "http://127.0.0.1:8001"
ticket  = "tkt-p"

[[ingress]]
path    = "transcribe"
service = "http://127.0.0.1:8002"
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
	if c.Ingress[0].Path != "printer" || c.Ingress[0].Service != "http://127.0.0.1:8001" || c.Ingress[0].Ticket != "tkt-p" {
		t.Fatalf("ingress[0] mismatch: %+v", c.Ingress[0])
	}
	if got := c.statePathFor("printer"); got != filepath.Join("/var/finch", "printer.json") {
		t.Fatalf("statePathFor: %q", got)
	}
}

func TestLoadConfig_Defaults(t *testing.T) {
	p := writeTOML(t, `
[[ingress]]
path    = "a"
service = "http://127.0.0.1:8000"
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
		"missing service": "[[ingress]]\npath = \"a\"\n",
		"missing path":    "[[ingress]]\nservice = \"http://x\"\n",
		"slash in path":   "[[ingress]]\npath = \"a/b\"\nservice = \"http://x\"\n",
		"duplicate path":  "[[ingress]]\npath=\"a\"\nservice=\"http://x\"\n[[ingress]]\npath=\"a\"\nservice=\"http://y\"\n",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := loadConfig(writeTOML(t, body), "h"); err == nil {
				t.Fatalf("expected rejection for %s", name)
			}
		})
	}
}
