package core

// service_enrollment_control.go is the secret-free Unix-socket side of the
// Aviary device flow. It is an additive handler: the main control mux must mount
// it when the relay reconciler is ready to consume OnCredential wakeups.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"
)

type LocalServiceEnrollmentRequest struct {
	Service        string   `json:"service"`
	AppPath        string   `json:"app_path"`
	Routes         []string `json:"routes"`
	EdgeAuth       string   `json:"edge_auth"`
	ExpectedTenant string   `json:"expected_tenant,omitempty"`
}

type LocalEnrollmentAuthorization struct {
	VerificationURI         string    `json:"verification_uri"`
	VerificationURIComplete string    `json:"verification_uri_complete"`
	UserCode                string    `json:"user_code"`
	ExpiresAt               time.Time `json:"expires_at"`
	IntervalSeconds         int       `json:"interval"`
}

// LocalServiceEnrollmentStatus is safe for the AviaryMCP process. Never add
// device_code, proof keys, join tickets, or service credentials to this type.
type LocalServiceEnrollmentStatus struct {
	EnrollmentID       string                        `json:"enrollment_id"`
	State              string                        `json:"state"`
	Manifest           LocalServiceEnrollmentRequest `json:"manifest"`
	MachineFingerprint string                        `json:"machine_fingerprint"`
	Authorization      *LocalEnrollmentAuthorization `json:"authorization,omitempty"`
	PublicURL          string                        `json:"public_url,omitempty"`
	ApprovedTenant     string                        `json:"approved_tenant,omitempty"`
	Detail             string                        `json:"detail,omitempty"`
}

type ServiceEnrollmentCoordinatorOptions struct {
	Hub                        string
	Machine                    string
	CredentialDirectory        string
	HTTPClient                 *http.Client
	AllowedVerificationOrigins []string
	// OnCredential must synchronously signal the desired-state reconciler. It
	// receives no credential; the reconciler reloads the secured state file.
	OnCredential func(appPath string)
}

type localPendingEnrollment struct {
	pollMu   sync.Mutex
	nextPoll time.Time
	request  LocalServiceEnrollmentRequest
	pending  *PendingServiceEnrollment
	status   LocalServiceEnrollmentStatus
}

// ServiceEnrollmentCoordinator owns in-memory proof keys and secret-free local
// status. Restarting finchd intentionally drops pending approvals; the user can
// start a fresh short-lived flow.
type ServiceEnrollmentCoordinator struct {
	options ServiceEnrollmentCoordinatorOptions

	mu     sync.Mutex
	byID   map[string]*localPendingEnrollment
	byPath map[string]string
	now    func() time.Time
	newID  func() (string, error)
}

func NewServiceEnrollmentCoordinator(options ServiceEnrollmentCoordinatorOptions) (*ServiceEnrollmentCoordinator, error) {
	if strings.TrimSpace(options.Machine) == "" {
		return nil, fmt.Errorf("Finch service enrollment requires a machine label")
	}
	if options.CredentialDirectory == "" {
		return nil, fmt.Errorf("Finch service enrollment requires a credential directory")
	}
	return &ServiceEnrollmentCoordinator{
		options: options, byID: map[string]*localPendingEnrollment{}, byPath: map[string]string{},
		now: time.Now, newID: randomLocalEnrollmentID,
	}, nil
}

func (c *ServiceEnrollmentCoordinator) Start(ctx context.Context, request LocalServiceEnrollmentRequest) (LocalServiceEnrollmentStatus, error) {
	request.Service = strings.TrimSpace(request.Service)
	request.AppPath = strings.TrimSpace(request.AppPath)
	if request.Service == "" {
		request.Service = request.AppPath
	}
	// Normalize through the same exact-manifest validator used by the hub client.
	canonical, err := normalizeServiceEnrollmentManifest(ServiceEnrollmentManifest{
		Service: request.Service, AppPath: request.AppPath, Routes: request.Routes,
		EdgeAuth: request.EdgeAuth, Machine: c.options.Machine,
		MachineFingerprint: "SHA256:pending",
		ExpectedTenant:     request.ExpectedTenant,
	})
	if err != nil {
		return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{Status: 400, Code: "invalid_manifest", Detail: err.Error()}
	}
	request = localManifest(canonical)

	c.mu.Lock()
	// Terminal records are retained long enough for the initiating poll to read
	// them, then opportunistically discarded before allocating another flow.
	for terminalID, terminal := range c.byID {
		if terminal.status.State == "ready" || terminal.status.State == "denied" || terminal.status.State == "expired" {
			delete(c.byID, terminalID)
		}
	}
	if id := c.byPath[request.AppPath]; id != "" {
		incumbent := c.byID[id]
		if incumbent != nil && reflect.DeepEqual(incumbent.request, request) {
			if incumbent.pending == nil && incumbent.status.Authorization == nil {
				c.mu.Unlock()
				return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{Status: 409, Code: "enrollment_starting", Detail: "an identical Finch enrollment is starting; retry shortly"}
			}
			status := incumbent.status
			c.mu.Unlock()
			return status, nil
		}
		c.mu.Unlock()
		return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{
			Status: 409, Code: "manifest_conflict",
			Detail: fmt.Sprintf("app_path %q already has a different pending manifest", request.AppPath),
		}
	}
	if len(c.byID) >= 256 {
		c.mu.Unlock()
		return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{Status: 429, Code: "too_many_enrollments", Detail: "too many local Finch enrollment records"}
	}
	id, err := c.newID()
	if err != nil {
		c.mu.Unlock()
		return LocalServiceEnrollmentStatus{}, err
	}
	// Reserve the path before the remote round-trip so concurrent local calls
	// cannot create orphaned hub device codes for the same service.
	c.byPath[request.AppPath] = id
	c.byID[id] = &localPendingEnrollment{
		request: request,
		status:  LocalServiceEnrollmentStatus{EnrollmentID: id, State: "needs_enrollment", Manifest: request},
	}
	c.mu.Unlock()

	pending, err := StartServiceEnrollmentWithOptions(ctx, c.options.Hub, ServiceEnrollmentManifest{
		Service: request.Service, AppPath: request.AppPath, Routes: request.Routes,
		EdgeAuth: request.EdgeAuth, Machine: c.options.Machine,
		ExpectedTenant: request.ExpectedTenant,
	}, ServiceEnrollmentOptions{
		HTTPClient:                 c.options.HTTPClient,
		AllowedVerificationOrigins: c.options.AllowedVerificationOrigins,
	})
	if err != nil {
		c.mu.Lock()
		delete(c.byPath, request.AppPath)
		delete(c.byID, id)
		c.mu.Unlock()
		return LocalServiceEnrollmentStatus{}, err
	}
	prompt := pending.Prompt()
	status := LocalServiceEnrollmentStatus{
		EnrollmentID: id, State: "needs_enrollment", Manifest: request,
		MachineFingerprint: prompt.Manifest.MachineFingerprint,
		Authorization: &LocalEnrollmentAuthorization{
			VerificationURI: prompt.VerificationURI, VerificationURIComplete: prompt.VerificationURIComplete,
			UserCode: prompt.UserCode, ExpiresAt: prompt.ExpiresAt, IntervalSeconds: prompt.IntervalSeconds,
		},
	}
	c.mu.Lock()
	entry := c.byID[id]
	if entry == nil || c.byPath[request.AppPath] != id {
		c.mu.Unlock()
		return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{Status: 409, Code: "enrollment_replaced", Detail: "local Finch enrollment reservation disappeared"}
	}
	entry.pending, entry.status = pending, status
	entry.nextPoll = c.now().Add(time.Duration(prompt.IntervalSeconds) * time.Second)
	c.mu.Unlock()
	return status, nil
}

func (c *ServiceEnrollmentCoordinator) Status(ctx context.Context, enrollmentID string) (LocalServiceEnrollmentStatus, error) {
	c.mu.Lock()
	entry := c.byID[enrollmentID]
	if entry == nil {
		c.mu.Unlock()
		return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{Status: 404, Code: "enrollment_not_found", Detail: "enrollment not found or expired"}
	}
	c.mu.Unlock()
	// Serialize remote polls and grant persistence for this enrollment without
	// holding the coordinator-wide lock across network I/O.
	if !entry.pollMu.TryLock() {
		c.mu.Lock()
		status := entry.status
		c.mu.Unlock()
		return status, nil
	}
	defer entry.pollMu.Unlock()
	c.mu.Lock()
	status := entry.status
	if status.State == "ready" || status.State == "denied" || status.State == "expired" {
		c.mu.Unlock()
		return status, nil
	}
	if status.Authorization != nil && !c.now().Before(status.Authorization.ExpiresAt) {
		status.State, status.Authorization = "expired", nil
		entry.status = status
		delete(c.byPath, entry.request.AppPath)
		c.mu.Unlock()
		return status, nil
	}
	if c.now().Before(entry.nextPoll) {
		c.mu.Unlock()
		return status, nil
	}
	interval := 3
	if status.Authorization != nil && status.Authorization.IntervalSeconds > 0 {
		interval = status.Authorization.IntervalSeconds
	}
	entry.nextPoll = c.now().Add(time.Duration(interval) * time.Second)
	pending := entry.pending
	c.mu.Unlock()

	polled, err := PollServiceEnrollment(ctx, pending)
	if err != nil {
		return LocalServiceEnrollmentStatus{}, err
	}
	c.mu.Lock()
	// The in-memory entry cannot be replaced under the same opaque id.
	entry = c.byID[enrollmentID]
	if entry == nil {
		c.mu.Unlock()
		return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{Status: 404, Code: "enrollment_not_found", Detail: "enrollment disappeared"}
	}
	status = entry.status
	if polled.Status == "approved" {
		pending, appPath := entry.pending, entry.request.AppPath
		credentialPath := filepath.Join(c.options.CredentialDirectory, appPath+".json")
		c.mu.Unlock()
		if err := PersistServiceEnrollmentGrant(pending.hub, credentialPath, polled.Grant, pending.prompt.Manifest); err != nil {
			return LocalServiceEnrollmentStatus{}, err
		}
		if err := AckServiceEnrollment(ctx, pending, polled.DeliveryID); err != nil {
			return LocalServiceEnrollmentStatus{}, err
		}
		if c.options.OnCredential != nil {
			c.options.OnCredential(appPath)
		}
		c.mu.Lock()
		entry = c.byID[enrollmentID]
		if entry == nil {
			c.mu.Unlock()
			return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{Status: 404, Code: "enrollment_not_found", Detail: "enrollment disappeared"}
		}
		status = entry.status
		status.State, status.Authorization = "ready", nil
		status.PublicURL = polled.Grant.PublicURL
		status.ApprovedTenant = polled.Grant.Tenant
		entry.pending, entry.status = nil, status
		delete(c.byPath, appPath)
		c.mu.Unlock()
		return status, nil
	}
	switch polled.Status {
	case "pending":
		status.State = "pending"
	case "denied", "expired":
		status.State, status.Detail, status.Authorization = polled.Status, polled.Detail, nil
		delete(c.byPath, entry.request.AppPath)
	}
	entry.status = status
	c.mu.Unlock()
	return status, nil
}

func randomLocalEnrollmentID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func localManifest(manifest ServiceEnrollmentManifest) LocalServiceEnrollmentRequest {
	return LocalServiceEnrollmentRequest{
		Service: manifest.Service, AppPath: manifest.AppPath,
		Routes: append([]string(nil), manifest.Routes...), EdgeAuth: manifest.EdgeAuth,
		ExpectedTenant: manifest.ExpectedTenant,
	}
}

// NewServiceEnrollmentControlHandler exposes only the enrollment endpoints.
// The production control mux should mount this beside NewControlHandler on the
// same permissioned Unix listener; it must never be bound to TCP.
func NewServiceEnrollmentControlHandler(coordinator *ServiceEnrollmentCoordinator) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/enrollments", func(w http.ResponseWriter, req *http.Request) {
		defer req.Body.Close()
		dec := json.NewDecoder(http.MaxBytesReader(w, req.Body, 64<<10))
		dec.DisallowUnknownFields()
		var body LocalServiceEnrollmentRequest
		if err := dec.Decode(&body); err != nil {
			writeServiceEnrollmentControlError(w, &ServiceEnrollmentHTTPError{Status: 400, Code: "invalid_json", Detail: "invalid JSON body"})
			return
		}
		if err := dec.Decode(&struct{}{}); err != io.EOF {
			writeServiceEnrollmentControlError(w, &ServiceEnrollmentHTTPError{Status: 400, Code: "invalid_json", Detail: "invalid JSON body: trailing data"})
			return
		}
		status, err := coordinator.Start(req.Context(), body)
		if err != nil {
			writeServiceEnrollmentControlError(w, err)
			return
		}
		code := http.StatusAccepted
		if status.State == "ready" {
			code = http.StatusOK
		}
		writeControlJSON(w, code, status)
	})
	mux.HandleFunc("GET /v1/enrollments/{id}", func(w http.ResponseWriter, req *http.Request) {
		status, err := coordinator.Status(req.Context(), req.PathValue("id"))
		if err != nil {
			writeServiceEnrollmentControlError(w, err)
			return
		}
		writeControlJSON(w, http.StatusOK, status)
	})
	return mux
}

func writeServiceEnrollmentControlError(w http.ResponseWriter, err error) {
	status, code, detail := http.StatusInternalServerError, "enrollment_error", "Finch enrollment failed"
	if enrollmentErr, ok := err.(*ServiceEnrollmentHTTPError); ok {
		status, code, detail = enrollmentErr.Status, enrollmentErr.Code, enrollmentErr.Detail
	}
	writeControlJSON(w, status, struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{Error: struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: detail}})
}
