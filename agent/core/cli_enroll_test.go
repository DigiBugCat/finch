package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
