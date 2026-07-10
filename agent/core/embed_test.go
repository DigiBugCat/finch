package core

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestEmbed_DialFailureNeverReportsLive(t *testing.T) {
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
	var mu sync.Mutex
	states := []string{}
	err := Embed(ctx, EmbedOptions{
		Hub: hub.URL, AppPath: "media", Upstream: "http://127.0.0.1:7342", CredentialPath: credentialPath,
	}, func(state, _ string) {
		mu.Lock()
		states = append(states, state)
		mu.Unlock()
	})
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, state := range states {
		if state == "live" || state == "connected" {
			t.Fatalf("dial failure reported %q; states=%v", state, states)
		}
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

func TestEmbed_InitialHubOutageIsRetryable(t *testing.T) {
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "temporary", http.StatusServiceUnavailable)
	}))
	defer hub.Close()
	credentialPath := filepath.Join(t.TempDir(), "media.json")
	if err := saveState(credentialPath, &agentState{Hub: hub.URL, RefreshToken: "refresh"}); err != nil {
		t.Fatal(err)
	}
	err := Embed(context.Background(), EmbedOptions{
		Hub: hub.URL, AppPath: "media", Upstream: "http://127.0.0.1:7342", CredentialPath: credentialPath,
	}, nil)
	if err == nil || isHubAuthRejection(err) || !strings.Contains(err.Error(), "HTTP 503") {
		t.Fatalf("initial 503 classification=%v", err)
	}
}

func TestEmbed_LaterAuthRejectionReturnsToEnrollment(t *testing.T) {
	payload, _ := json.Marshal(map[string]int64{"exp": time.Now().Unix() + 6})
	token := base64.RawURLEncoding.EncodeToString(payload) + ".sig"
	refreshes := 0
	var hub *httptest.Server
	hub = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/refresh":
			refreshes++
			if refreshes > 1 {
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
	err := Embed(ctx, EmbedOptions{
		Hub: hub.URL, AppPath: "media", Upstream: "http://127.0.0.1:7342", CredentialPath: credentialPath,
	}, nil)
	if !isHubAuthRejection(err) {
		t.Fatalf("later 403 did not return auth rejection: %v (refreshes=%d)", err, refreshes)
	}
}
