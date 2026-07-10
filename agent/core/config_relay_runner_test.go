package core

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestConfigRelayRunner_RevokedCredentialDoesNotRetryCloud(t *testing.T) {
	var refreshes atomic.Int32
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refreshes.Add(1)
		http.Error(w, "revoked", http.StatusForbidden)
	}))
	defer hub.Close()
	dir := filepath.Join(t.TempDir(), "credentials")
	if err := saveState(filepath.Join(dir, "media.json"), &agentState{Hub: hub.URL, RefreshToken: "revoked"}); err != nil {
		t.Fatal(err)
	}
	cfg := &config{Hub: hub.URL, Box: "box", CredentialsDir: dir}
	registry := NewDynamicRegistry(nil)
	runner := configRelayRunner(cfg, registry)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	states := make(chan string, 16)
	go func() {
		done <- runner(ctx, ServiceStatus{AppPath: "media", Upstream: "http://127.0.0.1:7342", Routes: []string{"/mcp"}}, func(state, _ string) {
			states <- state
		})
	}()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case state := <-states:
			if state == "needs_enrollment" {
				goto ready
			}
		case <-deadline:
			t.Fatal("revoked credential did not reach needs_enrollment")
		}
	}

ready:
	time.Sleep(200 * time.Millisecond)
	if got := refreshes.Load(); got != 1 {
		t.Fatalf("revoked credential refresh attempts=%d, want exactly one", got)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestConfigRelayRunner_MissingCredentialMakesNoCloudRequest(t *testing.T) {
	var requests atomic.Int32
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer hub.Close()
	cfg := &config{Hub: hub.URL, Box: "box", CredentialsDir: filepath.Join(t.TempDir(), "credentials")}
	registry := NewDynamicRegistry(nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- configRelayRunner(cfg, registry)(ctx, ServiceStatus{AppPath: "media", Upstream: "http://127.0.0.1:7342"}, func(string, string) {})
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	<-done
	if got := requests.Load(); got != 0 {
		t.Fatalf("missing credential made %d cloud requests", got)
	}
}

func TestConfigRelayRunner_ApprovedManifestPreventsRouteChangesAfterRestart(t *testing.T) {
	var requests atomic.Int32
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "must not dial", http.StatusInternalServerError)
	}))
	defer hub.Close()
	dir := filepath.Join(t.TempDir(), "credentials")
	state := &agentState{
		Hub: hub.URL, Service: "media", Tenant: "tenant-a", RefreshToken: "scoped",
		ApprovedRoutes: []string{"/mcp"}, ApprovedEdgeAuth: "key", ApprovedTenant: "tenant-a", ApprovedManifestSHA256: "approved-digest",
	}
	if err := saveState(filepath.Join(dir, "media.json"), state); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name   string
		routes []string
	}{
		{name: "widen", routes: []string{"/api/v1", "/mcp"}},
		{name: "narrow", routes: []string{"/birdz"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			// A new registry simulates finchd restart; policy comes from the
			// durable scoped credential, not in-memory enrollment state.
			registry := NewDynamicRegistry(nil)
			ctx, cancel := context.WithCancel(context.Background())
			states := make(chan string, 8)
			done := make(chan error, 1)
			go func() {
				done <- configRelayRunner(&config{Hub: hub.URL, Box: "box", CredentialsDir: dir}, registry)(ctx, ServiceStatus{
					AppPath: "media", Upstream: "http://127.0.0.1:7342", Routes: test.routes,
					EdgeAuth: "key", Source: "aviarymcp",
				}, func(state, _ string) { states <- state })
			}()
			select {
			case state := <-states:
				if state != "needs_enrollment" {
					t.Fatalf("state=%q", state)
				}
			case <-time.After(time.Second):
				t.Fatal("manifest mismatch was not reported")
			}
			cancel()
			<-done
		})
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("mismatched manifest made %d hub requests", got)
	}
	if err := validateApprovedManifest(state, ServiceStatus{
		AppPath: "media", Routes: []string{"/mcp"}, EdgeAuth: "key", ExpectedTenant: "tenant-a", Source: "aviarymcp",
	}); err != nil {
		t.Fatalf("exact approved manifest rejected: %v", err)
	}
	if err := validateApprovedManifest(state, ServiceStatus{
		AppPath: "media", Routes: []string{"/mcp"}, EdgeAuth: "key", ExpectedTenant: "tenant-b", Source: "aviarymcp",
	}); err == nil {
		t.Fatal("mismatched expected tenant was accepted")
	}
}
