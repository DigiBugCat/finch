package core

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRunRelay_DialFailureRetriesUntilCancelled(t *testing.T) {
	payload, _ := json.Marshal(map[string]int64{"exp": time.Now().Add(time.Hour).Unix()})
	token := base64.RawURLEncoding.EncodeToString(payload) + ".sig"
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/refresh" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(joinResp{
			OK: true, Service: "media", Box: "box", URL: "https://example.test/media/mcp",
			ConnectURL: "ws://127.0.0.1:1/media/box/_connect", ConnectToken: token,
		})
	}))
	defer hub.Close()

	credentialPath := filepath.Join(t.TempDir(), "media.json")
	if err := saveState(credentialPath, &agentState{Hub: hub.URL, RefreshToken: "refresh"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	// A dead relay endpoint is transient: runRelay keeps reconnecting and only
	// returns (cleanly) once the caller cancels.
	if err := runRelay(ctx, relayOptions{
		Hub: hub.URL, AppPath: "media", Upstream: "http://127.0.0.1:7342", CredentialPath: credentialPath,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestServe_DialErrorDoesNotLeakConnectToken(t *testing.T) {
	const secret = "unique-connect-token-secret"
	err := serve(context.Background(), "ws://127.0.0.1:1/connect?ct="+secret, mustParse(t, "http://127.0.0.1:7342"), false, "")
	if err == nil {
		t.Fatal("expected dial failure")
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "ct=") {
		t.Fatalf("connect token leaked through dial error: %v", err)
	}
}

func TestRunRelay_InitialHubOutageIsRetryable(t *testing.T) {
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "temporary", http.StatusServiceUnavailable)
	}))
	defer hub.Close()
	credentialPath := filepath.Join(t.TempDir(), "media.json")
	if err := saveState(credentialPath, &agentState{Hub: hub.URL, RefreshToken: "refresh"}); err != nil {
		t.Fatal(err)
	}
	err := runRelay(context.Background(), relayOptions{
		Hub: hub.URL, AppPath: "media", Upstream: "http://127.0.0.1:7342", CredentialPath: credentialPath,
	})
	if err == nil || isHubAuthRejection(err) || errors.Is(err, errNotEnrolled) || !strings.Contains(err.Error(), "HTTP 503") {
		t.Fatalf("initial 503 classification=%v", err)
	}
}

func TestRunRelay_MissingCredentialIsNotEnrolled(t *testing.T) {
	err := runRelay(context.Background(), relayOptions{
		Hub: "https://finch.example", AppPath: "media", Upstream: "http://127.0.0.1:7342",
		CredentialPath: filepath.Join(t.TempDir(), "media.json"),
	})
	if !errors.Is(err, errNotEnrolled) {
		t.Fatalf("missing credential=%v, want errNotEnrolled", err)
	}
}

func TestRunRelay_LaterAuthRejectionReturnsToEnrollment(t *testing.T) {
	payload, _ := json.Marshal(map[string]int64{"exp": time.Now().Unix() + 6})
	token := base64.RawURLEncoding.EncodeToString(payload) + ".sig"
	var refreshes atomic.Int32
	var hub *httptest.Server
	hub = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/refresh":
			if refreshes.Add(1) > 1 {
				http.Error(w, "revoked-secret", http.StatusForbidden)
				return
			}
			_ = json.NewEncoder(w).Encode(joinResp{
				OK: true, Service: "media", Box: "box", URL: hub.URL + "/media/mcp",
				ConnectURL: "ws" + strings.TrimPrefix(hub.URL, "http") + "/connect", ConnectToken: token,
			})
		case "/connect":
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			time.Sleep(1100 * time.Millisecond)
			_ = conn.Close(websocket.StatusNormalClosure, "test reconnect")
		default:
			http.NotFound(w, r)
		}
	}))
	defer hub.Close()
	credentialPath := filepath.Join(t.TempDir(), "media.json")
	if err := saveState(credentialPath, &agentState{Hub: hub.URL, RefreshToken: "refresh"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := runRelay(ctx, relayOptions{
		Hub: hub.URL, AppPath: "media", Upstream: "http://127.0.0.1:7342", CredentialPath: credentialPath,
	})
	if !isHubAuthRejection(err) {
		t.Fatalf("later 403 did not return auth rejection: %v (refreshes=%d)", err, refreshes.Load())
	}
}

// A revoked credential is stable operator work: the supervisor must not keep
// hitting the hub every few seconds, only wait for `finch add` to replace it.
func TestSuperviseRelay_RevokedCredentialDoesNotRetryHub(t *testing.T) {
	var refreshes atomic.Int32
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refreshes.Add(1)
		http.Error(w, "revoked", http.StatusForbidden)
	}))
	defer hub.Close()
	credentialPath := filepath.Join(t.TempDir(), "credentials", "media.json")
	if err := saveState(credentialPath, &agentState{Hub: hub.URL, RefreshToken: "revoked"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		superviseRelay(ctx, relayOptions{
			Hub: hub.URL, AppPath: "media", Upstream: "http://127.0.0.1:7342", CredentialPath: credentialPath,
		})
	}()
	time.Sleep(300 * time.Millisecond)
	if got := refreshes.Load(); got != 1 {
		t.Fatalf("revoked credential refresh attempts=%d, want exactly one", got)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("superviseRelay did not return after cancel")
	}
}

func TestSuperviseRelay_MissingCredentialMakesNoHubRequest(t *testing.T) {
	var requests atomic.Int32
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer hub.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		superviseRelay(ctx, relayOptions{
			Hub: hub.URL, AppPath: "media", Upstream: "http://127.0.0.1:7342",
			CredentialPath: filepath.Join(t.TempDir(), "credentials", "media.json"),
		})
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	<-done
	if got := requests.Load(); got != 0 {
		t.Fatalf("missing credential made %d hub requests", got)
	}
}

func TestWaitForNewCredential_WakesOnReplacementOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "media.json")
	hub := "https://finch.example"
	if err := saveState(path, &agentState{Hub: hub, RefreshToken: "old"}); err != nil {
		t.Fatal(err)
	}
	saved, _ := loadState(path)
	previous := credentialFingerprint(saved)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	woke := make(chan error, 1)
	go func() { woke <- waitForNewCredential(ctx, path, hub, previous, nil) }()
	select {
	case err := <-woke:
		t.Fatalf("woke without a replacement credential: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := saveState(path, &agentState{Hub: hub, RefreshToken: "new"}); err != nil {
		t.Fatal(err)
	}
	if err := <-woke; err != nil {
		t.Fatalf("replacement credential not picked up: %v", err)
	}
}

func TestServeConfig_RejectsEmptyManifest(t *testing.T) {
	err := serveConfig(context.Background(), &config{Hub: "https://finch.example", CredentialsDir: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "no ingress rules") {
		t.Fatalf("empty manifest=%v", err)
	}
}

// Every ingress rule gets its own relay: each rule's credential reaches the hub,
// and one rule's revoked credential does not stop its sibling from dialing.
func TestServeConfig_StartsOneRelayPerRule(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // no CLI login, so no auto-approve traffic
	var mu sync.Mutex
	seen := map[string]int{}
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ RefreshToken string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		seen[r.URL.Path+" "+body.RefreshToken]++
		mu.Unlock()
		http.Error(w, "revoked", http.StatusForbidden)
	}))
	defer hub.Close()

	cfg := &config{
		Hub: hub.URL, Box: "box1", CredentialsDir: t.TempDir(),
		Ingress: []ingress{
			{AppPath: "alpha", Service: "http://127.0.0.1:7342"},
			{AppPath: "beta", Service: "http://127.0.0.1:7343"},
		},
	}
	for _, ing := range cfg.Ingress {
		if err := saveState(cfg.statePathFor(ing.AppPath), &agentState{Hub: hub.URL, RefreshToken: "rt-" + ing.AppPath}); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serveConfig(ctx, cfg) }()
	time.Sleep(300 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveConfig: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("serveConfig did not return after cancel")
	}
	mu.Lock()
	defer mu.Unlock()
	for _, want := range []string{"/refresh rt-alpha", "/refresh rt-beta"} {
		if seen[want] != 1 {
			t.Errorf("%s requests=%d, want exactly one (seen %v)", want, seen[want], seen)
		}
	}
}

// A second `finch run` against the same credentials dir would supersede the
// first one's relays, so it must refuse before dialing anything.
func TestServeConfig_RefusesWhileAnotherRunHoldsTheLock(t *testing.T) {
	dir := t.TempDir()
	release, ok := lockState(filepath.Join(dir, "finch-run"))
	if !ok {
		t.Fatal("could not take the finch-run lock")
	}
	defer release()
	err := serveConfig(context.Background(), &config{
		Hub: "https://finch.example", CredentialsDir: dir,
		Ingress: []ingress{{AppPath: "alpha", Service: "http://127.0.0.1:7342"}},
	})
	if err == nil || !strings.Contains(err.Error(), "already serves") {
		t.Fatalf("second run=%v, want lock refusal", err)
	}
}

// `finch add` can replace a credential while the relay is still using the old
// one. The rejection of the OLD token must not make the supervisor treat the
// NEW token (already on disk by then) as the rejected baseline and wait for yet
// another replacement: it retries the new one straight away.
func TestSuperviseRelay_RetriesCredentialReplacedDuringRun(t *testing.T) {
	credentialPath := filepath.Join(t.TempDir(), "credentials", "media.json")
	var mu sync.Mutex
	seen := map[string]int{}
	var hub *httptest.Server
	hub = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ RefreshToken string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		seen[body.RefreshToken]++
		mu.Unlock()
		if body.RefreshToken == "old" {
			// The operator's `finch add` lands while this request is in flight.
			if err := saveState(credentialPath, &agentState{Hub: hub.URL, RefreshToken: "new"}); err != nil {
				t.Error(err)
			}
		}
		http.Error(w, "revoked", http.StatusForbidden)
	}))
	defer hub.Close()
	if err := saveState(credentialPath, &agentState{Hub: hub.URL, RefreshToken: "old"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- superviseRelay(ctx, relayOptions{
			Hub: hub.URL, AppPath: "media", Upstream: "http://127.0.0.1:7342", CredentialPath: credentialPath,
		})
	}()
	time.Sleep(500 * time.Millisecond)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("superviseRelay: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if seen["old"] != 1 || seen["new"] != 1 {
		t.Fatalf("refreshes old=%d new=%d, want exactly one each", seen["old"], seen["new"])
	}
}

// A re-enrolled service joins as pending when the tenant requires approval, so
// a logged-in `finch run` approves it again once its relay picks up the new
// credential — not only once at startup.
func TestServeConfig_AutoApprovesAfterReEnroll(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var approvals atomic.Int32
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/cli/approve" {
			var body struct{ ID string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.ID == "media" && r.Header.Get("Authorization") == "Bearer cli-token" {
				approvals.Add(1)
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		http.Error(w, "revoked", http.StatusForbidden)
	}))
	defer hub.Close()
	if err := saveCliCred(&cliCred{Hub: hub.URL, Token: "cli-token"}); err != nil {
		t.Fatal(err)
	}
	cfg := &config{
		Hub: hub.URL, Box: "box1", CredentialsDir: t.TempDir(),
		Ingress: []ingress{{AppPath: "media", Service: "http://127.0.0.1:7342"}},
	}
	if err := saveState(cfg.statePathFor("media"), &agentState{Hub: hub.URL, RefreshToken: "revoked"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serveConfig(ctx, cfg) }()

	waitFor := func(want int32) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for approvals.Load() < want {
			if time.Now().After(deadline) {
				t.Fatalf("approvals=%d, want %d", approvals.Load(), want)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitFor(1) // startup
	// `finch add media` re-enrolls while the relay waits on the revoked credential.
	if err := saveState(cfg.statePathFor("media"), &agentState{Hub: hub.URL, RefreshToken: "re-enrolled"}); err != nil {
		t.Fatal(err)
	}
	waitFor(2)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("serveConfig: %v", err)
	}
}

// A revoked single-service (`finch join`) relay recovers through `finch add`,
// which writes finch.yml and a credential under the manifest's credentials dir —
// never the relay's --state file. The supervisor hands off once finch.yml
// changes instead of polling --state forever.
func TestSuperviseRelay_SingleServiceHandsOffWhenManifestWritten(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Chdir(t.TempDir())
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "revoked", http.StatusForbidden)
	}))
	defer hub.Close()
	statePath := filepath.Join(home, ".finch", "agent.json")
	if err := saveState(statePath, &agentState{Hub: hub.URL, RefreshToken: "revoked"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- superviseRelay(ctx, relayOptions{
			Hub: hub.URL, Upstream: "http://127.0.0.1:7342", CredentialPath: statePath, WatchManifest: true,
		})
	}()
	select {
	case err := <-done:
		t.Fatalf("returned before finch.yml was written: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	manifest := "hub: " + hub.URL + "\ningress:\n  - app_path: media\n    service: http://127.0.0.1:7342\n"
	if err := os.WriteFile(filepath.Join(home, ".finch", "finch.yml"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, errManifestChanged) {
		t.Fatalf("superviseRelay=%v, want errManifestChanged", err)
	}
}
