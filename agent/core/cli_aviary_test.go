package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCliAviaryDecisionUsesTenantAdminTokenAndExplicitPublicBit(t *testing.T) {
	tests := []struct {
		name           string
		action         string
		publicApproved bool
		wantPath       string
	}{
		{name: "private approval by default", action: "approve", wantPath: "/api/cli/aviary/approve"},
		{name: "explicit public approval", action: "approve", publicApproved: true, wantPath: "/api/cli/aviary/approve"},
		{name: "describe", action: "describe", wantPath: "/api/cli/aviary/describe"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != tt.wantPath {
					t.Fatalf("request = %s %s, want POST %s", r.Method, r.URL.Path, tt.wantPath)
				}
				if got := r.Header.Get("Authorization"); got != "Bearer tenant-admin-token" {
					t.Fatalf("Authorization = %q", got)
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if got := body["user_code"]; got != "BIRD-DUCK" {
					t.Fatalf("user_code = %v", got)
				}
				if tt.action == "approve" {
					if got := body["public_approved"]; got != tt.publicApproved {
						t.Fatalf("public_approved = %v, want %v", got, tt.publicApproved)
					}
				} else if _, ok := body["public_approved"]; ok {
					t.Fatal("describe unexpectedly sent public_approved")
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ok":true,"status":"approved"}`))
			}))
			defer server.Close()

			out, err := cliAviaryDecision(
				&cliCred{Hub: server.URL, Token: "tenant-admin-token"},
				tt.action,
				" BIRD-DUCK ",
				tt.publicApproved,
			)
			if err != nil {
				t.Fatal(err)
			}
			if out["status"] != "approved" {
				t.Fatalf("response = %#v", out)
			}
		})
	}
}
