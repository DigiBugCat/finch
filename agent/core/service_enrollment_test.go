package core

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func testServiceManifest() ServiceEnrollmentManifest {
	return ServiceEnrollmentManifest{
		Service: "Media search", AppPath: "media", Machine: "aviary-test",
		Routes: []string{"/mcp", "/api/v1", "/mcp"},
	}
}

func TestServiceEnrollment_ProofExactGrantAndPersistence(t *testing.T) {
	var start serviceEnrollmentStartRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case serviceEnrollmentStartPath:
			if err := json.NewDecoder(r.Body).Decode(&start); err != nil {
				t.Fatal(err)
			}
			json.NewEncoder(w).Encode(serviceEnrollmentStartResponse{
				DeviceCode: "secret-device-code", UserCode: "WXYZ-2K7Q",
				VerificationURI:         serverURL(r) + "/aviary/authorize",
				VerificationURIComplete: serverURL(r) + "/aviary/authorize?code=WXYZ-2K7Q",
				ExpiresIn:               600, Interval: 3, ManifestSHA256: start.ManifestSHA256,
			})
		case serviceEnrollmentPollPath:
			var poll serviceEnrollmentPollRequest
			if err := json.NewDecoder(r.Body).Decode(&poll); err != nil {
				t.Fatal(err)
			}
			pub, err := base64.RawURLEncoding.DecodeString(start.DevicePublicKey)
			if err != nil {
				t.Fatal(err)
			}
			sig, err := base64.RawURLEncoding.DecodeString(poll.Proof.Signature)
			if err != nil {
				t.Fatal(err)
			}
			statement := serviceEnrollmentProofStatement(poll.DeviceCode, poll.ManifestSHA256)
			if poll.AckDelivery != "" {
				statement = serviceEnrollmentAckStatement(poll.DeviceCode, poll.ManifestSHA256, poll.AckDelivery)
			}
			if poll.Proof.Algorithm != "Ed25519" || !ed25519.Verify(pub, []byte(statement), sig) {
				t.Fatal("invalid proof of possession")
			}
			if poll.AckDelivery != "" {
				json.NewEncoder(w).Encode(ServiceEnrollmentPoll{Status: "consumed"})
				return
			}
			json.NewEncoder(w).Encode(ServiceEnrollmentPoll{Status: "approved", DeliveryID: "delivery-1", Grant: &ServiceEnrollmentGrant{
				Tenant: "tenant-1", Service: "media", Box: "aviary-test", RefreshToken: "finch_refresh_scoped",
				PublicURL: serverURL(r) + "/media/mcp", ManifestSHA256: start.ManifestSHA256,
				EdgeAuth: start.Manifest.EdgeAuth, MachineFingerprint: start.Manifest.MachineFingerprint,
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	pending, err := StartServiceEnrollment(context.Background(), server.URL, testServiceManifest(), server.Client())
	if err != nil {
		t.Fatal(err)
	}
	prompt := pending.Prompt()
	if prompt.Manifest.EdgeAuth != "key" {
		t.Fatalf("edge auth = %q, want key", prompt.Manifest.EdgeAuth)
	}
	if prompt.Manifest.MachineFingerprint == "" {
		t.Fatal("missing device fingerprint")
	}
	if prompt.ManifestSHA256 != start.ManifestSHA256 {
		t.Fatal("manifest digest mismatch")
	}

	polled, err := PollServiceEnrollment(context.Background(), pending)
	if err != nil {
		t.Fatal(err)
	}
	if polled.Status != "approved" || polled.Grant == nil {
		t.Fatalf("unexpected poll: %+v", polled)
	}
	if err := AckServiceEnrollment(context.Background(), pending, polled.DeliveryID); err != nil {
		t.Fatal(err)
	}

	statePath := filepath.Join(t.TempDir(), "media.json")
	if err := PersistServiceEnrollmentGrant(server.URL, statePath, polled.Grant, prompt.Manifest); err != nil {
		t.Fatal(err)
	}
	state, err := loadState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if state.RefreshToken != "finch_refresh_scoped" || state.Service != "media" {
		t.Fatalf("bad saved state: %+v", state)
	}
	if !slices.Equal(state.ApprovedRoutes, []string{"/api/v1", "/mcp"}) || state.ApprovedEdgeAuth != "key" || state.ApprovedTenant != "tenant-1" || state.ApprovedManifestSHA256 != prompt.ManifestSHA256 {
		t.Fatalf("approved manifest was not bound into state: %+v", state)
	}
	info, err := os.Stat(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("state mode = %04o", got)
	}

	serialized, _ := json.Marshal(prompt)
	if string(serialized) == "" || containsAny(string(serialized), "secret-device-code", "finch_refresh_scoped") {
		t.Fatalf("safe prompt leaked a secret: %s", serialized)
	}
}

func TestServiceEnrollment_RejectsChangedManifestAndMissingPublicApproval(t *testing.T) {
	manifest := testServiceManifest()
	manifest.EdgeAuth = "public"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var start serviceEnrollmentStartRequest
		_ = json.NewDecoder(r.Body).Decode(&start)
		json.NewEncoder(w).Encode(serviceEnrollmentStartResponse{
			DeviceCode: "d", UserCode: "ABCD-EFGH", VerificationURI: serverURL(r) + "/approve",
			VerificationURIComplete: serverURL(r) + "/approve?code=ABCD-EFGH", ExpiresIn: 600,
			ManifestSHA256: start.ManifestSHA256, PublicApprovalRequired: false,
		})
	}))
	defer server.Close()
	if _, err := StartServiceEnrollment(context.Background(), server.URL, manifest, server.Client()); err == nil {
		t.Fatal("public enrollment without separate approval requirement was accepted")
	}

	pending := &PendingServiceEnrollment{prompt: ServiceEnrollmentPrompt{Manifest: ServiceEnrollmentManifest{
		AppPath: "media", EdgeAuth: "public", MachineFingerprint: "SHA256:x",
	}}}
	grant := &ServiceEnrollmentGrant{
		Tenant: "t", Service: "media", Box: "b", RefreshToken: "r", ManifestSHA256: "digest",
		EdgeAuth: "public", MachineFingerprint: "SHA256:x", PublicApproved: false,
	}
	if err := validateServiceEnrollmentGrant(pending.prompt.Manifest, "digest", grant); err == nil {
		t.Fatal("public grant without explicit approval was accepted")
	}
}

func TestServiceEnrollment_NormalizesAndRejectsUnsafeRoutes(t *testing.T) {
	manifest := testServiceManifest()
	manifest.MachineFingerprint = "SHA256:test"
	got, err := normalizeServiceEnrollmentManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Routes) != 2 || got.Routes[0] != "/api/v1" || got.Routes[1] != "/mcp" {
		t.Fatalf("routes = %#v", got.Routes)
	}
	for _, route := range []string{"/", "/api/../admin", "mcp", "/api/*", "//evil", "/%2e%2e/admin", "/api/user uploads", "/médiá"} {
		bad := manifest
		bad.Routes = []string{route}
		if _, err := normalizeServiceEnrollmentManifest(bad); err == nil {
			t.Errorf("unsafe route %q accepted", route)
		}
	}
	badPath := manifest
	badPath.AppPath = "media\nother"
	if _, err := normalizeServiceEnrollmentManifest(badPath); err == nil {
		t.Fatal("control character in app_path was accepted")
	}
	boundary := manifest
	boundary.AppPath = strings.Repeat("a", 63)
	if _, err := normalizeServiceEnrollmentManifest(boundary); err != nil {
		t.Fatalf("63-char app_path rejected: %v", err)
	}
	boundary.AppPath = strings.Repeat("a", 64)
	if _, err := normalizeServiceEnrollmentManifest(boundary); err == nil {
		t.Fatal("64-char app_path accepted")
	}
	badLabel := manifest
	badLabel.Service = "Media & Search"
	if _, err := normalizeServiceEnrollmentManifest(badLabel); err == nil {
		t.Fatal("digest-unsafe service label accepted")
	}
	pinned := manifest
	pinned.ExpectedTenant = "tenant-expected"
	pinned.MachineFingerprint = "SHA256:test"
	digest, err := serviceManifestDigest(pinned)
	if err != nil {
		t.Fatal(err)
	}
	wrongTenant := &ServiceEnrollmentGrant{
		Tenant: "tenant-other", Service: "media", Box: "aviary-test", RefreshToken: "refresh",
		ManifestSHA256: digest, EdgeAuth: "key", MachineFingerprint: "SHA256:test",
	}
	if err := validateServiceEnrollmentGrant(pinned, digest, wrongTenant); err == nil {
		t.Fatal("grant from wrong expected tenant was accepted")
	}
}

func TestServiceEnrollment_RejectsUntrustedVerificationOrigin(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var start serviceEnrollmentStartRequest
		_ = json.NewDecoder(r.Body).Decode(&start)
		json.NewEncoder(w).Encode(serviceEnrollmentStartResponse{
			DeviceCode: "d", UserCode: "ABCD-EFGH",
			VerificationURI:         "https://phish.example/approve",
			VerificationURIComplete: "https://phish.example/approve?code=ABCD-EFGH",
			ExpiresIn:               600, ManifestSHA256: start.ManifestSHA256,
		})
	}))
	defer server.Close()
	if _, err := StartServiceEnrollment(context.Background(), server.URL, testServiceManifest(), server.Client()); err == nil {
		t.Fatal("untrusted verification origin was accepted")
	}
}

func TestServiceEnrollment_DoesNotReplayProofAcrossRedirect(t *testing.T) {
	hostileCalls := 0
	hostile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hostileCalls++
		w.WriteHeader(http.StatusOK)
	}))
	defer hostile.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, hostile.URL, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	_, err := StartServiceEnrollment(context.Background(), redirector.URL, testServiceManifest(), redirector.Client())
	if err == nil {
		t.Fatal("redirected enrollment unexpectedly succeeded")
	}
	if hostileCalls != 0 {
		t.Fatalf("enrollment body replayed to redirect target %d time(s)", hostileCalls)
	}
}

func TestServiceEnrollment_DoesNotForwardWorkerErrorText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{
			"code": "unknown", "message": "refresh_token=super-secret\nforged log line",
		}})
	}))
	defer server.Close()
	_, err := StartServiceEnrollment(context.Background(), server.URL, testServiceManifest(), server.Client())
	if err == nil || containsAny(err.Error(), "super-secret", "forged log line") {
		t.Fatalf("worker error text leaked: %v", err)
	}
}

func TestPersistServiceEnrollmentGrant_PreservesDirectoryAndRejectsSymlink(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "finch-state")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "do-not-touch")
	if err := os.WriteFile(target, []byte("sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(dir, "media.json")
	if err := os.Symlink(target, statePath); err != nil {
		t.Fatal(err)
	}
	grant := &ServiceEnrollmentGrant{
		Tenant: "tenant", Service: "media", Box: "box", RefreshToken: "scoped", EdgeAuth: "key",
	}
	manifest := ServiceEnrollmentManifest{
		Service: "Media", AppPath: "media", Machine: "box", MachineFingerprint: "SHA256:test",
		Routes: []string{"/mcp"}, EdgeAuth: "key",
	}
	canonical, err := normalizeServiceEnrollmentManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	grant.ManifestSHA256, _ = serviceManifestDigest(canonical)
	if err := PersistServiceEnrollmentGrant("https://finch.example", statePath, grant, canonical); err == nil {
		t.Fatal("unsafe credential symlink was accepted")
	}
	if got, _ := os.ReadFile(target); string(got) != "sentinel" {
		t.Fatal("credential writer followed destination symlink")
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o755 {
		t.Fatalf("credential writer silently changed parent directory mode to %04o", got)
	}
}

func serverURL(r *http.Request) string { return "http://" + r.Host }

func containsAny(s string, values ...string) bool {
	for _, value := range values {
		if value != "" && len(s) >= len(value) {
			for i := 0; i+len(value) <= len(s); i++ {
				if s[i:i+len(value)] == value {
					return true
				}
			}
		}
	}
	return false
}
