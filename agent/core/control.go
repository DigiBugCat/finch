package core

// control.go contains the local dynamic-registration contract used by an
// AviaryMCP process to announce itself to a long-running Finch agent. The
// registry is also the relay supervisor's desired-state store: every mutation
// wakes the reconciler and lease deadlines are exposed precisely so a relay is
// cancelled as soon as its owner stops renewing.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultLeaseSeconds = 30
	minLeaseSeconds     = 10
	maxLeaseSeconds     = 300
	maxAppPathLength    = 63
	maxUpstreamLength   = 2048
	maxRouteLength      = 256
	maxRoutesPerService = 16
	maxDynamicServices  = 128
)

// RegistrationRequest is the JSON body accepted by POST /v1/registrations.
// Routes are segment-aware path prefixes exposed by Finch. Health is metadata
// for the future relay supervisor and need not be externally reachable unless
// it is also present in Routes.
type RegistrationRequest struct {
	AppPath        string   `json:"app_path"`
	Upstream       string   `json:"upstream"`
	Routes         []string `json:"routes,omitempty"`
	Health         string   `json:"health,omitempty"`
	EdgeAuth       string   `json:"edge_auth,omitempty"`
	ExpectedTenant string   `json:"expected_tenant,omitempty"`
	LeaseSeconds   int      `json:"lease_seconds,omitempty"`
}

// ServiceStatus is the shared status shape for static and leased services.
type ServiceStatus struct {
	AppPath        string   `json:"app_path"`
	Upstream       string   `json:"upstream"`
	Routes         []string `json:"routes,omitempty"`
	Health         string   `json:"health,omitempty"`
	EdgeAuth       string   `json:"edge_auth,omitempty"`
	ExpectedTenant string   `json:"expected_tenant,omitempty"`
	Tenant         string   `json:"tenant,omitempty"`
	Source         string   `json:"source"` // finch.yml | aviarymcp
	State          string   `json:"state"`
	Detail         string   `json:"detail,omitempty"`

	LeaseID   string    `json:"lease_id,omitempty"`
	ExpiresAt time.Time `json:"expires_at,omitzero"`

	// ForwardAll is only populated for legacy finch.yml services. Dynamic
	// registrations always use Routes, never the whole-host escape hatch.
	ForwardAll bool `json:"-"`
}

// StaticService is the small, public input shape used to seed the registry
// from finch.yml without exposing the core package's YAML parser types.
type StaticService struct {
	AppPath    string
	Upstream   string
	Routes     []string
	ForwardAll bool
}

type dynamicRegistration struct {
	ServiceStatus
	leaseDuration time.Duration
}

// DynamicRegistry combines an immutable snapshot of finch.yml services with
// memory-only AviaryMCP leases. The static snapshot is supplied by the owner;
// the pilot deliberately does not watch or rewrite finch.yml.
type DynamicRegistry struct {
	mu                sync.Mutex
	static            map[string]ServiceStatus
	dynamic           map[string]dynamicRegistration // keyed by app_path
	byLease           map[string]string              // lease_id -> app_path
	now               func() time.Time
	newLease          func() (string, error)
	changed           chan struct{}
	maxDynamic        int
	credentialMu      sync.Mutex
	credentialChanged chan struct{}
}

// NewDynamicRegistry creates a registry from the current finch.yml service
// snapshot. The caller remains responsible for loading and validating YAML.
func NewDynamicRegistry(staticServices []StaticService) *DynamicRegistry {
	static := make(map[string]ServiceStatus, len(staticServices))
	for _, service := range staticServices {
		static[service.AppPath] = ServiceStatus{
			AppPath: service.AppPath, Upstream: service.Upstream, Routes: service.Routes,
			Source: "finch.yml", State: "configured", ForwardAll: service.ForwardAll,
		}
	}
	return &DynamicRegistry{
		static: static, dynamic: map[string]dynamicRegistration{}, byLease: map[string]string{},
		now: time.Now, newLease: randomLeaseID, changed: make(chan struct{}, 1), maxDynamic: maxDynamicServices,
		credentialChanged: make(chan struct{}),
	}
}

// staticServicesFromConfig is the future run/status integration seam. Keeping
// this conversion here also preserves forward_all in the combined status view.
func staticServicesFromConfig(cfg *config) []StaticService {
	services := make([]StaticService, 0, len(cfg.Ingress))
	for _, in := range cfg.Ingress {
		// Static services keep the legacy resolver exactly: a URL base path is
		// its confinement prefix, otherwise /mcp is the default unless
		// forward_all is true. Routes is exclusively the dynamic SDK allowlist.
		services = append(services, StaticService{AppPath: in.AppPath, Upstream: in.Service, ForwardAll: in.ForwardAll})
	}
	return services
}

func randomLeaseID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

type registryError struct {
	code   string
	status int
	msg    string
}

func (e *registryError) Error() string { return e.msg }

func invalid(msg string) error {
	return &registryError{code: "invalid_registration", status: http.StatusBadRequest, msg: msg}
}

func (r *DynamicRegistry) expireLocked(now time.Time) {
	for appPath, reg := range r.dynamic {
		if !now.Before(reg.ExpiresAt) {
			delete(r.dynamic, appPath)
			delete(r.byLease, reg.LeaseID)
		}
	}
}

// signal wakes the single desired-state reconciler without ever blocking a
// control request. Coalescing is intentional: the reconciler always reads a
// complete snapshot, not a mutation log.
func (r *DynamicRegistry) signal() {
	select {
	case r.changed <- struct{}{}:
	default:
	}
}

// Changed is notified after every registration, renewal, or removal.
func (r *DynamicRegistry) Changed() <-chan struct{} { return r.changed }

// NotifyCredentialChanged broadcasts that an enrollment grant was atomically
// installed. Every needs_enrollment runner wakes and rechecks only its own
// state path, avoiding secret material or per-service channels in this store.
func (r *DynamicRegistry) NotifyCredentialChanged() {
	r.credentialMu.Lock()
	close(r.credentialChanged)
	r.credentialChanged = make(chan struct{})
	r.credentialMu.Unlock()
	r.signal()
}

func (r *DynamicRegistry) CredentialChanged() <-chan struct{} {
	r.credentialMu.Lock()
	defer r.credentialMu.Unlock()
	return r.credentialChanged
}

// Register validates and creates a new lease. Existing static or live dynamic
// owners always win; callers must renew with the opaque lease id.
func (r *DynamicRegistry) Register(req RegistrationRequest) (ServiceStatus, error) {
	clean, leaseDuration, err := validateRegistration(req)
	if err != nil {
		return ServiceStatus{}, err
	}

	r.mu.Lock()
	now := r.now()
	r.expireLocked(now)
	if incumbent, ok := r.static[clean.AppPath]; ok {
		r.mu.Unlock()
		return ServiceStatus{}, &registryError{
			code: "app_path_conflict", status: http.StatusConflict,
			msg: fmt.Sprintf("app_path %q is owned by %s", clean.AppPath, incumbent.Source),
		}
	}
	if incumbent, ok := r.dynamic[clean.AppPath]; ok {
		r.mu.Unlock()
		return ServiceStatus{}, &registryError{
			code: "app_path_conflict", status: http.StatusConflict,
			msg: fmt.Sprintf("app_path %q already has an active %s lease", clean.AppPath, incumbent.Source),
		}
	}
	if len(r.dynamic) >= r.maxDynamic {
		r.mu.Unlock()
		return ServiceStatus{}, &registryError{
			code: "service_capacity_exceeded", status: http.StatusTooManyRequests,
			msg: fmt.Sprintf("dynamic service limit of %d reached", r.maxDynamic),
		}
	}
	leaseID, err := r.newLease()
	if err != nil {
		r.mu.Unlock()
		return ServiceStatus{}, fmt.Errorf("generating lease id: %w", err)
	}
	status := ServiceStatus{
		AppPath: clean.AppPath, Upstream: clean.Upstream, Routes: clean.Routes,
		Health: clean.Health, EdgeAuth: clean.EdgeAuth, ExpectedTenant: clean.ExpectedTenant, Source: "aviarymcp", State: "registered",
		LeaseID: leaseID, ExpiresAt: now.Add(leaseDuration),
	}
	r.dynamic[status.AppPath] = dynamicRegistration{ServiceStatus: status, leaseDuration: leaseDuration}
	r.byLease[leaseID] = status.AppPath
	r.mu.Unlock()
	r.signal()
	return status, nil
}

// Renew extends an existing lease using its originally requested duration.
func (r *DynamicRegistry) Renew(leaseID string) (ServiceStatus, error) {
	r.mu.Lock()
	now := r.now()
	r.expireLocked(now)
	appPath, ok := r.byLease[leaseID]
	if !ok {
		r.mu.Unlock()
		return ServiceStatus{}, &registryError{code: "lease_not_found", status: http.StatusNotFound, msg: "lease not found or expired"}
	}
	reg := r.dynamic[appPath]
	reg.ExpiresAt = now.Add(reg.leaseDuration)
	r.dynamic[appPath] = reg
	r.mu.Unlock()
	r.signal()
	return reg.ServiceStatus, nil
}

// Remove releases an existing lease. It never modifies static configuration.
func (r *DynamicRegistry) Remove(leaseID string) error {
	r.mu.Lock()
	r.expireLocked(r.now())
	appPath, ok := r.byLease[leaseID]
	if !ok {
		r.mu.Unlock()
		return &registryError{code: "lease_not_found", status: http.StatusNotFound, msg: "lease not found or expired"}
	}
	delete(r.byLease, leaseID)
	delete(r.dynamic, appPath)
	r.mu.Unlock()
	r.signal()
	return nil
}

// UpdateState records a relay lifecycle transition. expectedLease prevents a
// late callback from an expired relay overwriting the status of a new owner of
// the same app_path. Static services use an empty expectedLease.
func (r *DynamicRegistry) UpdateState(appPath, expectedLease, state, detail string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if expectedLease == "" {
		status, ok := r.static[appPath]
		if !ok {
			return false
		}
		status.State, status.Detail = state, detail
		r.static[appPath] = status
		return true
	}
	reg, ok := r.dynamic[appPath]
	if !ok || reg.LeaseID != expectedLease {
		return false
	}
	reg.State, reg.Detail = state, detail
	r.dynamic[appPath] = reg
	return true
}

// UpdateTenant publishes the non-secret tenant discovered from a verified
// scoped credential. It is guarded by lease ID so an expired runner cannot
// annotate a new owner of the same app_path.
func (r *DynamicRegistry) UpdateTenant(appPath, expectedLease, tenant string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	reg, ok := r.dynamic[appPath]
	if !ok || reg.LeaseID != expectedLease {
		return false
	}
	reg.Tenant = tenant
	r.dynamic[appPath] = reg
	return true
}

// Services returns a deterministic combined snapshot for status surfaces.
func (r *DynamicRegistry) Services() []ServiceStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.expireLocked(r.now())
	out := make([]ServiceStatus, 0, len(r.static)+len(r.dynamic))
	for _, st := range r.static {
		out = append(out, st)
	}
	for _, reg := range r.dynamic {
		out = append(out, reg.ServiceStatus)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AppPath < out[j].AppPath })
	return out
}

// NextExpiry returns the earliest live dynamic lease deadline. The reconciler
// arms one timer for this exact instant; it does not poll and add withdrawal
// latency.
func (r *DynamicRegistry) NextExpiry() (time.Time, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.expireLocked(now)
	var next time.Time
	for _, reg := range r.dynamic {
		if next.IsZero() || reg.ExpiresAt.Before(next) {
			next = reg.ExpiresAt
		}
	}
	return next, !next.IsZero()
}

func validateRegistration(req RegistrationRequest) (RegistrationRequest, time.Duration, error) {
	req.AppPath = strings.TrimSpace(req.AppPath)
	req.Upstream = strings.TrimRight(strings.TrimSpace(req.Upstream), "/")
	if req.AppPath == "" || req.Upstream == "" {
		return req, 0, invalid("app_path and upstream are required")
	}
	if len(req.AppPath) > maxAppPathLength || !validAppPath(req.AppPath) {
		return req, 0, invalid(fmt.Sprintf("app_path must be a safe URL segment of at most %d characters", maxAppPathLength))
	}
	if len(req.Upstream) > maxUpstreamLength {
		return req, 0, invalid(fmt.Sprintf("upstream must be at most %d characters", maxUpstreamLength))
	}
	u, err := url.Parse(req.Upstream)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return req, 0, invalid("upstream must be an absolute http(s) URL without credentials, query, or fragment")
	}
	if len(req.Routes) > maxRoutesPerService {
		return req, 0, invalid(fmt.Sprintf("routes may contain at most %d entries", maxRoutesPerService))
	}
	if len(req.Routes) == 0 {
		req.Routes = []string{"/mcp"}
	}
	seen := map[string]bool{}
	cleanRoutes := make([]string, 0, len(req.Routes))
	for _, route := range req.Routes {
		if len(route) > maxRouteLength {
			return req, 0, invalid(fmt.Sprintf("route must be at most %d characters", maxRouteLength))
		}
		route = strings.TrimSuffix(strings.TrimSpace(route), "/")
		if route == "" {
			route = "/"
		}
		if !validRoutePrefix(route) || path.Clean(route) != route {
			return req, 0, invalid(fmt.Sprintf("route %q must be a safe non-root path prefix", route))
		}
		if !seen[route] {
			seen[route] = true
			cleanRoutes = append(cleanRoutes, route)
		}
	}
	sort.Strings(cleanRoutes)
	req.Routes = cleanRoutes
	if req.EdgeAuth == "" {
		req.EdgeAuth = "key"
	}
	if req.EdgeAuth != "key" && req.EdgeAuth != "public" {
		return req, 0, invalid("edge_auth must be key or public")
	}
	req.ExpectedTenant = strings.TrimSpace(req.ExpectedTenant)
	if req.ExpectedTenant != "" && !validExpectedTenant(req.ExpectedTenant) {
		return req, 0, invalid("expected_tenant must be 1-128 characters using letters, digits, dot, underscore, colon, or hyphen")
	}
	if req.Health != "" {
		if len(req.Health) > maxRouteLength {
			return req, 0, invalid(fmt.Sprintf("health must be at most %d characters", maxRouteLength))
		}
		req.Health = strings.TrimSuffix(strings.TrimSpace(req.Health), "/")
		if !validRoutePrefix(req.Health) || path.Clean(req.Health) != req.Health {
			return req, 0, invalid("health must be a safe absolute path")
		}
	}
	seconds := req.LeaseSeconds
	if seconds == 0 {
		seconds = defaultLeaseSeconds
	}
	if seconds < minLeaseSeconds || seconds > maxLeaseSeconds {
		return req, 0, invalid(fmt.Sprintf("lease_seconds must be between %d and %d", minLeaseSeconds, maxLeaseSeconds))
	}
	req.LeaseSeconds = seconds
	return req, time.Duration(seconds) * time.Second, nil
}

func validAppPath(value string) bool {
	for i, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			continue
		}
		if i > 0 && i < len(value)-1 && (r == '-' || r == '_' || r == '.') {
			continue
		}
		return false
	}
	return value != ""
}

func validRoutePrefix(value string) bool {
	if value == "/" || !strings.HasPrefix(value, "/") {
		return false
	}
	for _, segment := range strings.Split(strings.TrimPrefix(value, "/"), "/") {
		if segment == "" {
			return false
		}
		for _, r := range segment {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
				r == '.' || r == '_' || r == '~' || r == '-' {
				continue
			}
			return false
		}
	}
	return true
}

func validExpectedTenant(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '.' || r == '_' || r == ':' || r == '-' {
			continue
		}
		return false
	}
	return true
}

// NewControlHandler returns the versioned local API handler. The caller is
// responsible for serving it only over a permission-restricted Unix socket.
func NewControlHandler(registry *DynamicRegistry) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/registrations", func(w http.ResponseWriter, req *http.Request) {
		defer req.Body.Close()
		dec := json.NewDecoder(http.MaxBytesReader(w, req.Body, 64<<10))
		dec.DisallowUnknownFields()
		var body RegistrationRequest
		if err := dec.Decode(&body); err != nil {
			writeControlError(w, invalid("invalid JSON body: "+err.Error()))
			return
		}
		if err := dec.Decode(&struct{}{}); err != io.EOF {
			writeControlError(w, invalid("invalid JSON body: trailing data"))
			return
		}
		status, err := registry.Register(body)
		if err != nil {
			writeControlError(w, err)
			return
		}
		writeControlJSON(w, http.StatusCreated, status)
	})
	mux.HandleFunc("PUT /v1/registrations/{lease}/renew", func(w http.ResponseWriter, req *http.Request) {
		status, err := registry.Renew(req.PathValue("lease"))
		if err != nil {
			writeControlError(w, err)
			return
		}
		writeControlJSON(w, http.StatusOK, status)
	})
	mux.HandleFunc("DELETE /v1/registrations/{lease}", func(w http.ResponseWriter, req *http.Request) {
		if err := registry.Remove(req.PathValue("lease")); err != nil {
			writeControlError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /v1/services", func(w http.ResponseWriter, _ *http.Request) {
		writeControlJSON(w, http.StatusOK, struct {
			Services []ServiceStatus `json:"services"`
		}{Services: registry.Services()})
	})
	return mux
}

func writeControlJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeControlError(w http.ResponseWriter, err error) {
	status, code := http.StatusInternalServerError, "internal_error"
	if re, ok := err.(*registryError); ok {
		status, code = re.status, re.code
	}
	writeControlJSON(w, status, struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{Error: struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: err.Error()}})
}
