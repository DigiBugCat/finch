package core

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestServiceEnrollmentControl_EndToEndAndWake(t *testing.T) {
	var started serviceEnrollmentStartRequest
	polls := 0
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case serviceEnrollmentStartPath:
			_ = json.NewDecoder(r.Body).Decode(&started)
			json.NewEncoder(w).Encode(serviceEnrollmentStartResponse{
				DeviceCode: "worker-secret", UserCode: "BIRD-DUCK",
				VerificationURI:         serverURL(r) + "/approve",
				VerificationURIComplete: serverURL(r) + "/approve?code=BIRD-DUCK",
				ExpiresIn:               600, Interval: 3, ManifestSHA256: started.ManifestSHA256,
			})
		case serviceEnrollmentPollPath:
			polls++
			var poll serviceEnrollmentPollRequest
			_ = json.NewDecoder(r.Body).Decode(&poll)
			publicKey, _ := base64.RawURLEncoding.DecodeString(poll.Proof.PublicKey)
			signature, _ := base64.RawURLEncoding.DecodeString(poll.Proof.Signature)
			statement := serviceEnrollmentProofStatement(poll.DeviceCode, poll.ManifestSHA256)
			if poll.AckDelivery != "" {
				statement = serviceEnrollmentAckStatement(poll.DeviceCode, poll.ManifestSHA256, poll.AckDelivery)
			}
			if !ed25519.Verify(publicKey, []byte(statement), signature) {
				t.Fatal("invalid device proof")
			}
			if poll.AckDelivery != "" {
				json.NewEncoder(w).Encode(ServiceEnrollmentPoll{Status: "consumed"})
				return
			}
			json.NewEncoder(w).Encode(ServiceEnrollmentPoll{Status: "approved", DeliveryID: "delivery-1", Grant: &ServiceEnrollmentGrant{
				Tenant: "tenant", Service: "media", Box: "aviary-test", RefreshToken: "scoped-refresh",
				PublicURL: serverURL(r) + "/media/mcp", ManifestSHA256: started.ManifestSHA256,
				EdgeAuth: started.Manifest.EdgeAuth, MachineFingerprint: started.Manifest.MachineFingerprint,
			}})
		}
	}))
	defer worker.Close()

	woke := ""
	stateDir := filepath.Join(t.TempDir(), "credentials")
	coordinator, err := NewServiceEnrollmentCoordinator(ServiceEnrollmentCoordinatorOptions{
		Hub: worker.URL, Machine: "aviary-test", CredentialDirectory: stateDir,
		HTTPClient: worker.Client(), OnCredential: func(appPath string) { woke = appPath },
	})
	if err != nil {
		t.Fatal(err)
	}
	coordinator.newID = func() (string, error) { return "local-safe-id", nil }
	now := time.Now()
	coordinator.now = func() time.Time { return now }
	handler := NewServiceEnrollmentControlHandler(coordinator)

	body := []byte(`{"service":"Media","app_path":"media","routes":["/mcp","/api/v1"],"edge_auth":"key","expected_tenant":"tenant"}`)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/enrollments", bytes.NewReader(body)))
	if w.Code != http.StatusAccepted {
		t.Fatalf("start status=%d body=%s", w.Code, w.Body.String())
	}
	var pending LocalServiceEnrollmentStatus
	if err := json.Unmarshal(w.Body.Bytes(), &pending); err != nil {
		t.Fatal(err)
	}
	serialized := w.Body.String()
	if containsAny(serialized, "worker-secret", "scoped-refresh", "device_code", "refresh_token") {
		t.Fatalf("local start leaked a secret: %s", serialized)
	}
	if pending.EnrollmentID != "local-safe-id" || pending.Authorization.UserCode != "BIRD-DUCK" {
		t.Fatalf("unexpected pending response: %+v", pending)
	}
	if pending.Manifest.ExpectedTenant != "tenant" || started.Manifest.ExpectedTenant != "tenant" {
		t.Fatalf("expected_tenant was not bound into local/remote manifests: pending=%+v remote=%+v", pending.Manifest, started.Manifest)
	}

	// Rapid local status reads return the cached prompt and cannot amplify into
	// hub polls before the Worker-requested interval.
	for range 8 {
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/enrollments/local-safe-id", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("cached poll status=%d", w.Code)
		}
	}
	if polls != 0 || woke != "" {
		t.Fatalf("rapid local reads reached hub: polls=%d", polls)
	}
	now = now.Add(4 * time.Second)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/enrollments/local-safe-id", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("poll status=%d body=%s", w.Code, w.Body.String())
	}
	var ready LocalServiceEnrollmentStatus
	if err := json.Unmarshal(w.Body.Bytes(), &ready); err != nil {
		t.Fatal(err)
	}
	if ready.State != "ready" || ready.PublicURL == "" || ready.ApprovedTenant != "tenant" || woke != "media" {
		t.Fatalf("completion did not wake reconciler: status=%+v woke=%q", ready, woke)
	}
	state, err := loadState(filepath.Join(stateDir, "media.json"))
	if err != nil || state.RefreshToken != "scoped-refresh" {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	if containsAny(w.Body.String(), "scoped-refresh", "refresh_token") {
		t.Fatalf("ready response leaked a credential: %s", w.Body.String())
	}
}

func TestServiceEnrollmentControl_DeduplicatesExactAndRejectsChangedManifest(t *testing.T) {
	starts := 0
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		starts++
		var start serviceEnrollmentStartRequest
		_ = json.NewDecoder(r.Body).Decode(&start)
		json.NewEncoder(w).Encode(serviceEnrollmentStartResponse{
			DeviceCode: "d", UserCode: "BIRD-DUCK", VerificationURI: serverURL(r) + "/approve",
			VerificationURIComplete: serverURL(r) + "/approve?code=BIRD-DUCK", ExpiresIn: 600,
			ManifestSHA256: start.ManifestSHA256,
		})
	}))
	defer worker.Close()
	coordinator, _ := NewServiceEnrollmentCoordinator(ServiceEnrollmentCoordinatorOptions{
		Hub: worker.URL, Machine: "box", CredentialDirectory: filepath.Join(t.TempDir(), "creds"), HTTPClient: worker.Client(),
	})
	req := LocalServiceEnrollmentRequest{Service: "Media", AppPath: "media", Routes: []string{"/mcp"}, EdgeAuth: "key"}
	first, err := coordinator.Start(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	second, err := coordinator.Start(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if first.EnrollmentID != second.EnrollmentID || starts != 1 {
		t.Fatalf("exact start was not deduplicated")
	}
	req.Routes = []string{"/mcp", "/api/v1"}
	if _, err := coordinator.Start(context.Background(), req); err == nil {
		t.Fatal("changed pending manifest was accepted")
	}
}

func TestServiceEnrollmentControl_RejectsTrailingJSON(t *testing.T) {
	coordinator, _ := NewServiceEnrollmentCoordinator(ServiceEnrollmentCoordinatorOptions{
		Hub: "https://finch.example", Machine: "box",
		CredentialDirectory: filepath.Join(t.TempDir(), "creds"),
	})
	w := httptest.NewRecorder()
	NewServiceEnrollmentControlHandler(coordinator).ServeHTTP(
		w,
		httptest.NewRequest(http.MethodPost, "/v1/enrollments", bytes.NewBufferString(
			`{"service":"media","app_path":"media","routes":["/mcp"],"edge_auth":"key"} {}`,
		)),
	)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}
