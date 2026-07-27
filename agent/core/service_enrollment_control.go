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
	"os"
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
	pollMu      sync.Mutex
	nextPoll    time.Time
	request     LocalServiceEnrollmentRequest
	pending     *PendingServiceEnrollment
	ackDelivery string
	status      LocalServiceEnrollmentStatus
}

// ServiceEnrollmentCoordinator owns in-memory proof keys and secret-free local
// status. Restarting finchd intentionally drops pending approvals; the user can
// start a fresh short-lived flow.
type ServiceEnrollmentCoordinator struct {
	options ServiceEnrollmentCoordinatorOptions

	mu     sync.Mutex
	byID   map[string]*localPendingEnrollment
	// byPath is keyed by the CASE-FOLDED app_path (foldAppPath). Two pending
	// enrollments differing only in case would otherwise both reserve, both be
	// approved, and both write the same credential file on a case-insensitive
	// filesystem — the one window the credential-directory check in Start
	// cannot see, because at reservation time neither file exists yet.
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
	if id := c.byPath[foldAppPath(request.AppPath)]; id != "" {
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
	// Refuse an app_path whose CREDENTIAL FILE already exists under a different
	// case. This is the durable half of the case-folding rule that
	// DynamicRegistry.appPathOwnerLocked enforces in memory.
	//
	// The registry check alone does not close the hole. byPath only ever holds
	// other PENDING enrollments and is cleared on every terminal transition, so
	// the damaging sequence slips straight past it: enroll "media", reach ready,
	// byPath cleared — then enroll "Media", find no incumbent, and write
	// Media.json, which IS media.json on a case-insensitive filesystem. That
	// clobbers media's refresh credential, and its runner reloads into
	// needs_enrollment with an approved-manifest mismatch. The relay-side check
	// fires only afterwards, once the file is already gone.
	//
	// So the check is against the thing that actually collides — the credential
	// directory — and it runs before the hub round-trip, so no one-shot ticket is
	// burned on an enrollment that would corrupt a working service. It also
	// covers the case where finch.yml owns "media": static services keep their
	// credentials in this same directory.
	if existing, clash := credentialCaseVariant(c.options.CredentialDirectory, request.AppPath); clash {
		c.mu.Unlock()
		return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{
			Status: 409, Code: "manifest_conflict",
			Detail: fmt.Sprintf("app_path %q collides case-insensitively with the existing credential %q; app paths must be unique ignoring case", request.AppPath, existing),
		}
	}
	if len(c.byID) >= 256 {
		c.mu.Unlock()
		return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{Status: 429, Code: "too_many_enrollments", Detail: "too many local Finch enrollment records"}
	}
	var id string
	for attempt := 0; attempt < maxIDGenerationTries; attempt++ {
		id, err = c.newID()
		if err != nil {
			c.mu.Unlock()
			return LocalServiceEnrollmentStatus{}, err
		}
		if id != "" {
			if _, exists := c.byID[id]; !exists {
				break
			}
		}
		id = ""
	}
	if id == "" {
		c.mu.Unlock()
		return LocalServiceEnrollmentStatus{}, fmt.Errorf("generating local enrollment id: repeated empty or duplicate values")
	}
	// Reserve the path before the remote round-trip so concurrent local calls
	// cannot create orphaned hub device codes for the same service.
	c.byPath[foldAppPath(request.AppPath)] = id
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
		delete(c.byPath, foldAppPath(request.AppPath))
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
	if entry == nil || c.byPath[foldAppPath(request.AppPath)] != id {
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
	if status.State == "ack_pending" {
		c.mu.Unlock()
		return c.finishPendingAck(ctx, enrollmentID, entry)
	}
	if status.Authorization != nil && !c.now().Before(status.Authorization.ExpiresAt) {
		status.State, status.Authorization = "expired", nil
		entry.status = status
		delete(c.byPath, foldAppPath(entry.request.AppPath))
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
		c.mu.Lock()
		entry = c.byID[enrollmentID]
		if entry == nil {
			c.mu.Unlock()
			return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{Status: 404, Code: "enrollment_not_found", Detail: "enrollment disappeared"}
		}
		status = entry.status
		status.State, status.Authorization = "ack_pending", nil
		status.PublicURL = polled.Grant.PublicURL
		status.ApprovedTenant = polled.Grant.Tenant
		entry.ackDelivery, entry.status = polled.DeliveryID, status
		c.mu.Unlock()
		return c.finishPendingAck(ctx, enrollmentID, entry)
	}
	switch polled.Status {
	case "pending":
		status.State = "pending"
	case "denied", "expired":
		status.State, status.Detail, status.Authorization = polled.Status, polled.Detail, nil
		delete(c.byPath, foldAppPath(entry.request.AppPath))
	}
	entry.status = status
	c.mu.Unlock()
	return status, nil
}

// finishPendingAck retries the same proof-bound delivery acknowledgement after
// an ambiguous network failure. It must never poll again after persistence: the
// Worker may already have consumed the grant even when the ACK response was
// lost, and ACK is the idempotent operation for resolving that ambiguity.
func (c *ServiceEnrollmentCoordinator) finishPendingAck(ctx context.Context, enrollmentID string, entry *localPendingEnrollment) (LocalServiceEnrollmentStatus, error) {
	c.mu.Lock()
	pending, deliveryID, appPath := entry.pending, entry.ackDelivery, entry.request.AppPath
	status := entry.status
	c.mu.Unlock()
	if pending == nil || deliveryID == "" {
		return LocalServiceEnrollmentStatus{}, fmt.Errorf("Finch enrollment acknowledgement state is incomplete")
	}
	if err := AckServiceEnrollment(ctx, pending, deliveryID); err != nil {
		return status, err
	}
	if c.options.OnCredential != nil {
		c.options.OnCredential(appPath)
	}
	c.mu.Lock()
	current := c.byID[enrollmentID]
	if current != entry {
		c.mu.Unlock()
		return LocalServiceEnrollmentStatus{}, &ServiceEnrollmentHTTPError{Status: 404, Code: "enrollment_not_found", Detail: "enrollment disappeared"}
	}
	status = entry.status
	status.State = "ready"
	entry.pending, entry.ackDelivery, entry.status = nil, "", status
	delete(c.byPath, foldAppPath(appPath))
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

// credentialCaseVariant reports an existing credential file in `dir` whose name
// differs from `appPath`.json only by case. Returns the app_path that owns it.
//
// An EXACT match is not a clash: re-enrolling the same service is the ordinary
// renewal path and must keep working. Only a different spelling of the same
// filename is a problem, and only because the filesystem folds it — which is why
// this asks the directory rather than assuming a platform. An unreadable
// directory yields no clash: it is also the state before the first enrollment,
// and failing an enrollment because the directory does not exist yet would break
// first run.
func credentialCaseVariant(dir, appPath string) (string, bool) {
	if dir == "" || appPath == "" {
		return "", false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false
	}
	want := appPath + ".json"
	for _, entry := range entries {
		if name := entry.Name(); name != want && strings.EqualFold(name, want) {
			return strings.TrimSuffix(name, ".json"), true
		}
	}
	return "", false
}

// foldAppPath is the box-local app_path identity: case-insensitive, because a
// service's refresh credential is a file named after its app_path and macOS and
// Windows fold filenames. The same rule is enforced by loadConfig for finch.yml
// and by DynamicRegistry.appPathOwnerLocked for live leases; this is the third
// place it has to hold — the pending-enrollment reservation — so that `media`
// and `Media` cannot both be in flight before either has written a credential.
func foldAppPath(appPath string) string { return strings.ToLower(appPath) }
