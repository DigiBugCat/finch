//go:build unix

package core

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestControlRuntime_ReconcilesHTTPLeaseEndToEnd(t *testing.T) {
	root := shortTempDir(t)
	socketPath := filepath.Join(root, "control", "control.sock")
	cfg := &config{Hub: "https://finch.invalid", Box: "test-box", CredentialsDir: filepath.Join(root, "credentials")}
	events := make(chan relayEvent, 8)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runControlRuntime(ctx, cfg, controlRuntimeOptions{
			SocketPath: socketPath, SocketMode: 0o600, RunRelay: recordingRelay(events, 0),
		})
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Lstat(socketPath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("control socket did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}

	client := unixHTTPClient(socketPath)
	body := []byte(`{"app_path":"media","upstream":"http://127.0.0.1:7342","routes":["/mcp","/api/v1","/birdz"],"lease_seconds":10}`)
	resp, err := client.Post("http://finch/v1/registrations", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var lease ServiceStatus
	if err := json.NewDecoder(resp.Body).Decode(&lease); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated || lease.LeaseID == "" {
		t.Fatalf("registration status=%d lease=%+v", resp.StatusCode, lease)
	}
	waitRelayEvent(t, events, "media", "start")

	resp, err = client.Get("http://finch/v1/services")
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		Services []ServiceStatus `json:"services"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(status.Services) != 1 || status.Services[0].Source != "aviarymcp" {
		t.Fatalf("combined runtime status=%+v", status.Services)
	}

	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("http://finch/v1/registrations/%s", lease.LeaseID), nil)
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status=%d", resp.StatusCode)
	}
	waitRelayEvent(t, events, "media", "stop")

	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(socketPath); !os.IsNotExist(err) {
		t.Fatalf("control socket remains after shutdown: %v", err)
	}
}

func TestStaticForwardAllDesiredStateRetainsLegacyBehavior(t *testing.T) {
	cfg := &config{Ingress: []ingress{{AppPath: "website", Service: "http://127.0.0.1:8080", ForwardAll: true}}}
	services := NewDynamicRegistry(staticServicesFromConfig(cfg)).Services()
	if len(services) != 1 || !services[0].ForwardAll || len(services[0].Routes) != 0 {
		t.Fatalf("forward_all static service narrowed unexpectedly: %+v", services)
	}
	base := mustParse(t, services[0].Upstream)
	if _, err := resolveUpstreamWithRoutes(base, "/index.html", services[0].ForwardAll, services[0].Routes); err != nil {
		t.Fatalf("legacy website path rejected: %v", err)
	}
}

func TestStaticBasePathDesiredStateRetainsLegacyConfinement(t *testing.T) {
	cfg := &config{Ingress: []ingress{{AppPath: "legacy-api", Service: "http://127.0.0.1:8080/api"}}}
	services := NewDynamicRegistry(staticServicesFromConfig(cfg)).Services()
	if len(services) != 1 || len(services[0].Routes) != 0 {
		t.Fatalf("static base path gained a dynamic allowlist: %+v", services)
	}
	base := mustParse(t, services[0].Upstream)
	if _, err := resolveUpstreamWithRoutes(base, "/api/mcp", false, services[0].Routes); err != nil {
		t.Fatalf("legacy base path rejected: %v", err)
	}
	if _, err := resolveUpstreamWithRoutes(base, "/mcp", false, services[0].Routes); err == nil {
		t.Fatal("legacy base path confinement was bypassed")
	}
}

func TestControlRuntimeOptions_GroupSocketRequiresExplicitGroup(t *testing.T) {
	t.Setenv("FINCH_CONTROL_SOCKET", filepath.Join(t.TempDir(), "control.sock"))
	t.Setenv("FINCH_CONTROL_SOCKET_MODE", "0660")
	t.Setenv("FINCH_CONTROL_GROUP", "")
	if _, err := controlRuntimeOptionsFromEnv(); err == nil {
		t.Fatal("group-accessible mode without group was accepted")
	}
	t.Setenv("FINCH_CONTROL_GROUP", fmt.Sprint(os.Getegid()))
	options, err := controlRuntimeOptionsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if options.GroupID == nil || *options.GroupID != os.Getegid() || options.SocketMode != 0o660 {
		t.Fatalf("group options=%+v", options)
	}
}

func TestAviaryServeIgnoresCWDAndHomeManifests(t *testing.T) {
	root := shortTempDir(t)
	cwd := filepath.Join(root, "cwd")
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(filepath.Join(home, ".finch"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	manifest := []byte("hub: https://wrong.example\nbox: wrong\ningress:\n  - app_path: must-not-start\n    service: http://127.0.0.1:9999\n")
	if err := os.WriteFile(filepath.Join(cwd, "finch.yml"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".finch", "finch.yml"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	// A FIFO makes any accidental CLI/admin-state read block forever, turning
	// this from a structural assertion into a runtime regression test.
	if err := syscall.Mkfifo(filepath.Join(home, ".finch", "cli.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	oldCWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(cwd); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(oldCWD) })
	t.Setenv("HOME", home)
	t.Setenv("FINCH_HUB", "https://expected.example")
	t.Setenv("FINCH_BOX", "expected-box")
	t.Setenv("FINCH_CREDENTIALS_DIR", filepath.Join(root, "credentials"))
	t.Setenv("FINCH_CONTROL_SOCKET", filepath.Join(root, "run", "control.sock"))

	if found := findManifest(); found == "" {
		t.Fatal("test setup did not expose a discoverable finch.yml")
	}
	cfg, options, err := aviaryServeRuntimeFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Ingress) != 0 || cfg.Hub != "https://expected.example" || cfg.Box != "expected-box" || cfg.CredentialsDir != filepath.Join(root, "credentials") {
		t.Fatalf("Aviary serve inherited manifest state: %+v", cfg)
	}
	if !options.SkipAdminState || options.SocketPath != filepath.Join(root, "run", "control.sock") {
		t.Fatalf("Aviary serve runtime options=%+v", options)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runControlRuntime(ctx, cfg, options) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Aviary serve blocked reading manifest or CLI/admin state")
	}
}

func TestAviaryServeDisablesHubPushedBinaryUpdates(t *testing.T) {
	remoteUpdatesDisabled.Store(false)
	t.Cleanup(func() { remoteUpdatesDisabled.Store(false) })
	disableRemoteUpdatesForAviaryServe()
	if !remoteUpdatesDisabled.Load() {
		t.Fatal("aviary serve must disable remote binary updates")
	}
}

func TestControlRuntimeOptions_ParsesAviaryVerificationOrigins(t *testing.T) {
	t.Setenv("FINCH_AVIARY_VERIFICATION_ORIGINS", "https://one.example, https://two.example")
	options, err := controlRuntimeOptionsFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if got := options.AllowedVerificationOrigins; len(got) != 2 || got[0] != "https://one.example" || got[1] != "https://two.example" {
		t.Fatalf("verification origins=%q", got)
	}

	t.Setenv("FINCH_AVIARY_VERIFICATION_ORIGINS", "https://one.example,")
	if _, err := controlRuntimeOptionsFromEnv(); err == nil {
		t.Fatal("empty verification origin was accepted")
	}
}

func TestControlRuntime_RejectsUnsafeAviaryVerificationOrigin(t *testing.T) {
	cfg := &config{Hub: "https://finch.example", Box: "test-box", CredentialsDir: t.TempDir()}
	err := runControlRuntime(context.Background(), cfg, controlRuntimeOptions{
		SocketPath:                 filepath.Join(t.TempDir(), "control.sock"),
		SocketMode:                 0o600,
		AllowedVerificationOrigins: []string{"http://dashboard.example"},
	})
	if err == nil {
		t.Fatal("HTTPS hub accepted a downgraded verification origin")
	}
}
