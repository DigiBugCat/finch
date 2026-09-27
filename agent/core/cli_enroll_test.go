package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// `finch enroll` names the saved credential after the hub's slugified service
// id, not the raw argument, so `finch run` finds it under the id the relay uses.
func TestEnrollWithTicketSavesCredentialUnderAssignedService(t *testing.T) {
	var gotTicket string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/join" {
			http.NotFound(w, r)
			return
		}
		var body struct{ Ticket, Box string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotTicket = body.Ticket
		_ = json.NewEncoder(w).Encode(joinResp{
			OK: true, Tenant: "t1", Service: "printer", Box: body.Box, ConnectToken: "ct", RefreshToken: "rt",
		})
	}))
	defer srv.Close()

	dir := t.TempDir()
	id, statePath, err := enrollWithTicket(srv.URL, "box1", "tkt", dir)
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	if gotTicket != "tkt" {
		t.Errorf("hub saw ticket %q, want %q", gotTicket, "tkt")
	}
	if id != "printer" || statePath != filepath.Join(dir, "printer.json") {
		t.Fatalf("id=%q statePath=%q", id, statePath)
	}
	st, err := loadState(statePath)
	if err != nil {
		t.Fatalf("load saved credential: %v", err)
	}
	if st.Service != "printer" || st.RefreshToken != "rt" || st.Box != "box1" || st.Hub != srv.URL {
		t.Errorf("saved credential %+v", st)
	}
}

// A join that returns no refresh token cannot be resumed later, so enroll
// must fail loudly and write nothing.
func TestEnrollWithTicketRequiresRefreshToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Box string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(joinResp{OK: true, Service: "printer", Box: body.Box, ConnectToken: "ct"})
	}))
	defer srv.Close()

	dir := t.TempDir()
	if _, _, err := enrollWithTicket(srv.URL, "box1", "tkt", dir); err == nil {
		t.Fatal("join without a refresh token was accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "printer.json")); !os.IsNotExist(err) {
		t.Errorf("credential written despite failed enroll: %v", err)
	}
}

// A join that succeeded but whose credential cannot be saved locally is an
// INTERNAL failure, not UPSTREAM: the hub has the box and the one-shot ticket
// is spent, so an agent must not read it as a retryable hub error.
func TestEnrollPersistFailureIsInternal(t *testing.T) {
	isolate(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Box string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(joinResp{OK: true, Tenant: "t1", Service: "printer", Box: body.Box, ConnectToken: "ct", RefreshToken: "rt"})
	}))
	defer srv.Close()
	dir := t.TempDir()
	// A directory where the credential file goes: the save cannot succeed.
	if err := os.MkdirAll(filepath.Join(dir, "printer.json", "occupied"), 0o700); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := finch(t, "enroll", "printer", "--ticket", "tkt", "--hub", srv.URL, "--credentials-dir", dir, "--json")
	env := decodeJSONError(t, stderr)
	if code != 1 || stdout != "" || env.Error.Code != "INTERNAL" ||
		!strings.Contains(env.Error.Message, `finch registered "printer"`) || strings.Contains(env.Error.Message, "dashboard") ||
		!strings.Contains(env.Error.Message, "ticket is used up") ||
		!strings.Contains(env.Error.Message, "finch rm printer") {
		t.Fatalf("exit=%d stdout=%q env=%+v", code, stdout, env)
	}

	// A hub that refuses the join is still UPSTREAM.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"ticket expired"}`, http.StatusUnauthorized)
	}))
	defer bad.Close()
	_, stderr, code = finch(t, "enroll", "printer", "--ticket", "tkt", "--hub", bad.URL, "--credentials-dir", t.TempDir(), "--json")
	if env := decodeJSONError(t, stderr); code != 1 || env.Error.Code != "UPSTREAM" {
		t.Fatalf("join failure: exit=%d env=%+v", code, env)
	}
}

// The same for `finch add`: after /api/cli/enroll and /join succeed, a failed
// local save is INTERNAL, leaves finch.yml untouched, and says how to recover
// (re-running add alone would register "<name>-2" beside the orphan).
func TestAddPersistFailureIsInternal(t *testing.T) {
	home := isolate(t)
	h := newFakeHub(t)
	loginTo(t, h)
	cfg := filepath.Join(home, "finch.yml")
	if err := os.MkdirAll(filepath.Join(home, ".finch", "notes.json", "occupied"), 0o700); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, code := finch(t, "add", "notes", "--service", "http://127.0.0.1:8000", "--config", cfg, "--json")
	env := decodeJSONError(t, stderr)
	if code != 1 || stdout != "" || env.Error.Code != "INTERNAL" || env.Error.Next != "finch rm notes" ||
		!strings.Contains(env.Error.Message, `finch registered "notes"`) ||
		!strings.Contains(env.Error.Message, "'finch add notes --service http://127.0.0.1:8000' again") {
		t.Fatalf("exit=%d stdout=%q env=%+v", code, stdout, env)
	}
	if b, err := os.ReadFile(cfg); err == nil && strings.Contains(string(b), "app_path: notes") {
		t.Fatal("finch.yml gained a rule for a service with no saved credential")
	}
}
