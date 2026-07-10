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
