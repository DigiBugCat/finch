package core

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testRegistry() (*DynamicRegistry, *time.Time) {
	now := time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC)
	r := NewDynamicRegistry([]StaticService{{AppPath: "printer", Upstream: "http://127.0.0.1:8000", Routes: []string{"/mcp"}}})
	r.now = func() time.Time { return now }
	n := 0
	r.newLease = func() (string, error) {
		n++
		return "lease-test-" + string(rune('0'+n)), nil
	}
	return r, &now
}

func TestDynamicRegistry_CollisionsAndExpiry(t *testing.T) {
	r, now := testRegistry()
	if _, err := r.Register(RegistrationRequest{AppPath: "printer", Upstream: "http://127.0.0.1:9000"}); err == nil {
		t.Fatal("expected finch.yml collision")
	}
	first, err := r.Register(RegistrationRequest{AppPath: "media", Upstream: "http://127.0.0.1:7342", LeaseSeconds: 10})
	if err != nil {
		t.Fatal(err)
	}
	if first.Source != "aviarymcp" || first.State != "registered" {
		t.Fatalf("unexpected dynamic status: %+v", first)
	}
	if _, err := r.Register(RegistrationRequest{AppPath: "media", Upstream: "http://127.0.0.1:9999"}); err == nil {
		t.Fatal("expected active dynamic collision")
	}
	*now = now.Add(10 * time.Second)
	second, err := r.Register(RegistrationRequest{AppPath: "media", Upstream: "http://127.0.0.1:9999"})
	if err != nil {
		t.Fatalf("expired lease should release app_path: %v", err)
	}
	if second.LeaseID == first.LeaseID {
		t.Fatal("new owner reused expired lease id")
	}
}

func TestDynamicRegistry_RenewAndRemove(t *testing.T) {
	r, now := testRegistry()
	reg, err := r.Register(RegistrationRequest{AppPath: "media", Upstream: "http://localhost:7342", LeaseSeconds: 20})
	if err != nil {
		t.Fatal(err)
	}
	*now = now.Add(15 * time.Second)
	renewed, err := r.Renew(reg.LeaseID)
	if err != nil {
		t.Fatal(err)
	}
	if want := now.Add(20 * time.Second); !renewed.ExpiresAt.Equal(want) {
		t.Fatalf("renewed expiry = %s, want %s", renewed.ExpiresAt, want)
	}
	if err := r.Remove(reg.LeaseID); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Renew(reg.LeaseID); err == nil {
		t.Fatal("removed lease renewed")
	}
}

func TestDynamicRegistry_PublishesCredentialTenantForCurrentLeaseOnly(t *testing.T) {
	r, _ := testRegistry()
	lease, err := r.Register(RegistrationRequest{AppPath: "media", Upstream: "http://localhost:7342"})
	if err != nil {
		t.Fatal(err)
	}
	if !r.UpdateTenant("media", lease.LeaseID, "tenant-a") {
		t.Fatal("current lease tenant update rejected")
	}
	if r.UpdateTenant("media", "stale-lease", "attacker") {
		t.Fatal("stale lease tenant update accepted")
	}
	services := r.Services()
	if services[0].Tenant != "tenant-a" {
		t.Fatalf("published tenant=%q", services[0].Tenant)
	}
}

func TestValidateRegistration_Routes(t *testing.T) {
	good, _, err := validateRegistration(RegistrationRequest{
		AppPath: "media", Upstream: "http://app:8000/", Routes: []string{"/birdz/", "/mcp", "/mcp", "/users/~me"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(good.Routes) != 3 || good.Routes[0] != "/birdz" || good.Routes[1] != "/mcp" || good.Routes[2] != "/users/~me" {
		t.Fatalf("routes not normalized: %#v", good.Routes)
	}
	for _, route := range []string{"/", "/api/../admin", "mcp", "/api/*", "//evil", "/space here", "/cafè", "/percent%20value"} {
		if _, _, err := validateRegistration(RegistrationRequest{AppPath: "media", Upstream: "http://app:8000", Routes: []string{route}}); err == nil {
			t.Errorf("unsafe route %q accepted", route)
		}
	}
}

func TestValidateRegistration_ResourceBounds(t *testing.T) {
	base := RegistrationRequest{AppPath: "media", Upstream: "http://127.0.0.1:7342"}
	if _, _, err := validateRegistration(RegistrationRequest{AppPath: strings.Repeat("a", maxAppPathLength), Upstream: base.Upstream}); err != nil {
		t.Fatalf("%d-character app_path rejected: %v", maxAppPathLength, err)
	}
	withTenant := base
	withTenant.ExpectedTenant = strings.Repeat("a", 128)
	if _, _, err := validateRegistration(withTenant); err != nil {
		t.Fatalf("128-character expected_tenant rejected: %v", err)
	}
	tests := []RegistrationRequest{
		{AppPath: strings.Repeat("a", maxAppPathLength+1), Upstream: base.Upstream},
		{AppPath: "bad%2fslug", Upstream: base.Upstream},
		{AppPath: base.AppPath, Upstream: "http://host/" + strings.Repeat("a", maxUpstreamLength)},
		{AppPath: base.AppPath, Upstream: base.Upstream, Routes: make([]string, maxRoutesPerService+1)},
		{AppPath: base.AppPath, Upstream: base.Upstream, Routes: []string{"/" + strings.Repeat("a", maxRouteLength)}},
		{AppPath: base.AppPath, Upstream: base.Upstream, Health: "/" + strings.Repeat("a", maxRouteLength)},
	}
	for i, request := range tests {
		if _, _, err := validateRegistration(request); err == nil {
			t.Errorf("oversized/unsafe request #%d accepted", i)
		}
	}
	for _, tenant := range []string{"tenant with spaces", "tenant/other", strings.Repeat("a", 129)} {
		request := base
		request.ExpectedTenant = tenant
		if _, _, err := validateRegistration(request); err == nil {
			t.Errorf("unsafe expected_tenant %q accepted", tenant)
		}
	}
}

func TestDynamicRegistry_CapacityIsBounded(t *testing.T) {
	r := NewDynamicRegistry(nil)
	r.maxDynamic = 1
	if _, err := r.Register(RegistrationRequest{AppPath: "one", Upstream: "http://127.0.0.1:7001"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Register(RegistrationRequest{AppPath: "two", Upstream: "http://127.0.0.1:7002"}); err == nil {
		t.Fatal("registry exceeded configured dynamic-service capacity")
	}
}

func TestControlHandler_StatusIncludesSources(t *testing.T) {
	r, _ := testRegistry()
	h := NewControlHandler(r)
	body := []byte(`{"app_path":"media","upstream":"http://127.0.0.1:7342","routes":["/mcp","/api/v1"],"edge_auth":"key","expected_tenant":"tenant-a"}`)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/registrations", bytes.NewReader(body)))
	if w.Code != http.StatusCreated {
		t.Fatalf("register status=%d body=%s", w.Code, w.Body.String())
	}
	var created ServiceStatus
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.EdgeAuth != "key" || created.ExpectedTenant != "tenant-a" {
		t.Fatalf("private policy was not decoded: %+v", created)
	}

	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/services", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("services status=%d", w.Code)
	}
	var got struct {
		Services []ServiceStatus `json:"services"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Services) != 2 || got.Services[0].Source != "aviarymcp" || got.Services[1].Source != "finch.yml" {
		t.Fatalf("combined sources missing or unsorted: %+v", got.Services)
	}
}

func TestControlHandler_ConflictShape(t *testing.T) {
	r, _ := testRegistry()
	h := NewControlHandler(r)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/registrations", bytes.NewBufferString(`{"app_path":"printer","upstream":"http://localhost:9000"}`)))
	if w.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var got struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Error.Code != "app_path_conflict" {
		t.Fatalf("error code=%q", got.Error.Code)
	}
}

// Socket possession is the pilot's authentication mechanism. A group-readable
// socket therefore grants one full control-plane capability; it is not an
// application-isolation boundary. Production gives each app its own sidecar
// and GID until peer-credential ownership or per-app sockets are implemented.
func TestControlHandler_SocketPossessionIsFullTrustBoundary(t *testing.T) {
	r := NewDynamicRegistry(nil)
	h := NewControlHandler(r)
	register := func(appPath string) ServiceStatus {
		t.Helper()
		body := `{"app_path":"` + appPath + `","upstream":"http://127.0.0.1:7342"}`
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/registrations", strings.NewReader(body)))
		if w.Code != http.StatusCreated {
			t.Fatalf("register %s: status=%d body=%s", appPath, w.Code, w.Body.String())
		}
		var status ServiceStatus
		if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		return status
	}

	first := register("first")
	second := register("second")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/services", nil))
	var fleet struct {
		Services []ServiceStatus `json:"services"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &fleet); err != nil {
		t.Fatal(err)
	}
	if len(fleet.Services) != 2 || fleet.Services[0].LeaseID == "" || fleet.Services[1].LeaseID == "" {
		t.Fatalf("full-trust status did not expose both lease capabilities: %+v", fleet.Services)
	}

	// The same socket authority can manage either lease; callers are not scoped
	// to the app_path they originally registered.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/v1/registrations/"+second.LeaseID, nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("cross-registration delete status=%d body=%s", w.Code, w.Body.String())
	}
	if _, err := r.Renew(first.LeaseID); err != nil {
		t.Fatalf("unrelated lease was disrupted: %v", err)
	}
}
