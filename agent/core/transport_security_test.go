package core

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestValidateHubTransportURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
		ok   bool
	}{
		{name: "production TLS", raw: "https://finchmcp.com/", want: "https://finchmcp.com", ok: true},
		{name: "localhost dev", raw: "http://localhost:8787", want: "http://localhost:8787", ok: true},
		{name: "localhost absolute", raw: "http://localhost.:8787", want: "http://localhost.:8787", ok: true},
		{name: "IPv4 loopback dev", raw: "http://127.0.0.2:8787", want: "http://127.0.0.2:8787", ok: true},
		{name: "IPv6 loopback dev", raw: "http://[::1]:8787", want: "http://[::1]:8787", ok: true},
		{name: "remote plaintext", raw: "http://finch.example", ok: false},
		{name: "private network plaintext", raw: "http://192.168.1.20:8787", ok: false},
		{name: "lookalike localhost", raw: "http://localhost.example:8787", ok: false},
		{name: "unsupported scheme", raw: "ws://localhost:8787", ok: false},
		{name: "credentials", raw: "https://user@finch.example", ok: false},
		{name: "base path", raw: "https://finch.example/api", ok: false},
		{name: "query", raw: "https://finch.example?tenant=a", ok: false},
		{name: "empty hostname", raw: "https://:443", ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := validateHubTransportURL(tt.raw)
			if tt.ok && (err != nil || got != tt.want) {
				t.Fatalf("validateHubTransportURL(%q) = %q, %v; want %q", tt.raw, got, err, tt.want)
			}
			if !tt.ok && err == nil {
				t.Fatalf("validateHubTransportURL(%q) accepted insecure URL %q", tt.raw, got)
			}
		})
	}
}

func TestValidateRelayTransportURL(t *testing.T) {
	for _, raw := range []string{
		"wss://tenant.finchmcp.com/app/box/_connect",
		"ws://localhost:8787/app/box/_connect",
		"ws://127.0.0.1:8787/app/box/_connect",
		"ws://[::1]:8787/app/box/_connect",
	} {
		if err := validateRelayTransportURL(raw); err != nil {
			t.Errorf("secure/development relay %q rejected: %v", raw, err)
		}
	}
	for _, raw := range []string{
		"ws://tenant.finchmcp.com/app/box/_connect",
		"ws://10.0.0.2:8787/app/box/_connect",
		"http://localhost:8787/app/box/_connect",
		"not-a-url",
	} {
		if err := validateRelayTransportURL(raw); err == nil {
			t.Errorf("insecure/invalid relay %q accepted", raw)
		}
	}
}

func TestServeRejectsRemotePlaintextRelayBeforeDial(t *testing.T) {
	err := serve(context.Background(), "ws://relay.example.invalid/connect?ct=secret", mustParse(t, "http://127.0.0.1:7342"), false, "")
	if err == nil || !strings.Contains(err.Error(), "WSS is required") {
		t.Fatalf("remote plaintext relay error = %v", err)
	}
}

func TestSecureRedirectPolicyRejectsTLSDowngrade(t *testing.T) {
	from, _ := http.NewRequest(http.MethodGet, "https://finch.example/releases/finch", nil)
	downgrade, _ := http.NewRequest(http.MethodGet, "http://localhost:8787/releases/finch", nil)
	if err := secureRedirectPolicy(downgrade, []*http.Request{from}); err == nil {
		t.Fatal("HTTPS redirect downgrade to plaintext loopback was accepted")
	}
	secure, _ := http.NewRequest(http.MethodGet, "https://cdn.example/releases/finch", nil)
	if err := secureRedirectPolicy(secure, []*http.Request{from}); err != nil {
		t.Fatalf("HTTPS redirect rejected: %v", err)
	}
	remotePlaintext, _ := http.NewRequest(http.MethodGet, "http://cdn.example/releases/finch", nil)
	if err := secureRedirectPolicy(remotePlaintext, nil); err == nil {
		t.Fatal("remote plaintext redirect was accepted")
	}
	local, _ := http.NewRequest(http.MethodGet, "http://localhost:8787/start", nil)
	if err := secureRedirectPolicy(downgrade, []*http.Request{local, from}); err == nil {
		t.Fatal("HTTP -> HTTPS -> HTTP chain hid a downgrade from the immediate prior hop")
	}
	via := make([]*http.Request, 10)
	for i := range via {
		via[i] = secure
	}
	if err := secureRedirectPolicy(secure, via); err == nil {
		t.Fatal("redirect chain exceeded the fixed 10-hop bound")
	}
}

func TestControlPlaneRejectsRemotePlaintextBeforeRequest(t *testing.T) {
	if _, err := refresh("http://hub.example.invalid", "secret"); err == nil || !strings.Contains(err.Error(), "HTTPS is required") {
		t.Fatalf("refresh remote plaintext error = %v", err)
	}
	if _, err := cliRequest(http.MethodGet, "http://hub.example.invalid", "/api/cli/state", "secret", nil); err == nil || !strings.Contains(err.Error(), "HTTPS is required") {
		t.Fatalf("CLI remote plaintext error = %v", err)
	}
}

func TestParseUpstreamTransportURL(t *testing.T) {
	for _, tc := range []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{name: "remote https", raw: "https://mcp.internal.example/mcp"},
		{name: "loopback http", raw: "http://127.0.0.1:8000/mcp"},
		{name: "localhost http", raw: "http://localhost:8000/mcp"},
		{name: "docker host gateway", raw: "http://host.docker.internal:8000/mcp"},
		{name: "compose service", raw: "http://hello-mcp:8000/mcp"},
		{name: "remote http rejected", raw: "http://mcp.internal.example/mcp", wantErr: true},
		{name: "LAN http rejected", raw: "http://192.168.1.10:8000/mcp", wantErr: true},
		{name: "dotted DNS http rejected", raw: "http://hello-mcp.example:8000/mcp", wantErr: true},
		{name: "malformed local label rejected", raw: "http://-hello:8000/mcp", wantErr: true},
		{name: "credentials rejected", raw: "https://user:pass@mcp.example/mcp", wantErr: true},
		{name: "query rejected", raw: "https://mcp.example/mcp?token=hidden", wantErr: true},
		{name: "fragment rejected", raw: "https://mcp.example/mcp#hidden", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			u, err := parseUpstreamTransportURL(tc.raw)
			if (err != nil) != tc.wantErr {
				t.Fatalf("parseUpstreamTransportURL(%q) error = %v, wantErr %v", tc.raw, err, tc.wantErr)
			}
			if err == nil && u == nil {
				t.Fatal("expected parsed upstream URL")
			}
		})
	}
}

func TestRelayConnectURLPinsTokenToCleanBase(t *testing.T) {
	got, err := relayConnectURL("wss://relay.example/service/box/_connect", "a+b&c")
	if err != nil {
		t.Fatal(err)
	}
	if got != "wss://relay.example/service/box/_connect?ct=a%2Bb%26c" {
		t.Fatalf("relayConnectURL = %q", got)
	}
	for _, poisoned := range []string{
		"wss://relay.example/connect?other=1",
		"wss://relay.example/connect#ct=ignored",
	} {
		if _, err := relayConnectURL(poisoned, "secret"); err == nil {
			t.Errorf("poisoned relay base %q accepted", poisoned)
		}
	}
}
