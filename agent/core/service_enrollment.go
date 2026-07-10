package core

// service_enrollment.go implements the agent half of AviaryMCP first-run
// enrollment. It deliberately does not reuse `finch login`: that flow returns
// a tenant-admin CLI token. This flow asks a human to approve one exact service
// manifest and returns only a service+box-scoped refresh credential.
//
// The hub endpoints described here are not deployed yet. Keeping the client
// isolated lets the worker/web contract land and be conformance-tested before
// the dynamic-registration reconciler calls it.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	serviceEnrollmentProtocol  = "finch-aviary-service-enrollment-v1"
	serviceEnrollmentStartPath = "/api/aviary/device/start"
	serviceEnrollmentPollPath  = "/api/aviary/device/poll"
	maxEnrollmentResponseBytes = 64 << 10
)

var serviceEnrollmentAppPath = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$`)
var serviceEnrollmentLabel = regexp.MustCompile(`^[A-Za-z0-9 ._-]{1,100}$`)
var serviceEnrollmentMachine = regexp.MustCompile(`^[A-Za-z0-9 ._-]{1,64}$`)
var serviceEnrollmentRouteSegment = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)
var serviceEnrollmentTenant = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// ServiceEnrollmentManifest is the immutable grant the browser must display
// and approve. MachineFingerprint is set by StartServiceEnrollment from the
// ephemeral proof key; caller-supplied values are never trusted.
type ServiceEnrollmentManifest struct {
	Service            string   `json:"service"`
	AppPath            string   `json:"app_path"`
	Routes             []string `json:"routes"`
	EdgeAuth           string   `json:"edge_auth"` // key (default) | public
	Machine            string   `json:"machine"`
	MachineFingerprint string   `json:"machine_fingerprint"`
	ExpectedTenant     string   `json:"expected_tenant,omitempty"`
}

// ServiceEnrollmentPrompt is safe to send across the local control socket or
// print in a TTY/container log. It intentionally excludes device_code, the
// private proof key, and every service credential.
type ServiceEnrollmentPrompt struct {
	VerificationURI         string                    `json:"verification_uri"`
	VerificationURIComplete string                    `json:"verification_uri_complete"`
	UserCode                string                    `json:"user_code"`
	ExpiresAt               time.Time                 `json:"expires_at"`
	IntervalSeconds         int                       `json:"interval"`
	ManifestSHA256          string                    `json:"manifest_sha256"`
	Manifest                ServiceEnrollmentManifest `json:"manifest"`
	PublicApprovalRequired  bool                      `json:"public_approval_required"`
}

// PendingServiceEnrollment keeps all code-theft proof material inside finchd.
// Dynamic registration should retain this value, expose Prompt(), and call
// Poll. It must never serialize the whole struct.
type PendingServiceEnrollment struct {
	hub            string
	deviceCode     string
	publicKey      ed25519.PublicKey
	privateKey     ed25519.PrivateKey
	client         *http.Client
	prompt         ServiceEnrollmentPrompt
	manifestDigest string
}

// ServiceEnrollmentOptions permits an explicitly configured dashboard origin
// when it differs from the hub (for example, a self-hosted worker + web split).
// With no allowlist, verification URLs must stay on the exact hub origin.
type ServiceEnrollmentOptions struct {
	HTTPClient                 *http.Client
	AllowedVerificationOrigins []string
}

func (p *PendingServiceEnrollment) Prompt() ServiceEnrollmentPrompt { return p.prompt }

// ServiceEnrollmentGrant is returned only after proof-of-possession and human
// approval. PersistServiceEnrollmentGrant stores RefreshToken in Finch's normal
// 0600 agent state; the local AviaryMCP client must receive only non-secret
// completion status/public URL.
type ServiceEnrollmentGrant struct {
	Tenant             string `json:"tenant"`
	Service            string `json:"service"`
	Box                string `json:"box"`
	RefreshToken       string `json:"refresh_token"`
	PublicURL          string `json:"public_url"`
	ManifestSHA256     string `json:"manifest_sha256"`
	EdgeAuth           string `json:"edge_auth"`
	MachineFingerprint string `json:"machine_fingerprint"`
	PublicApproved     bool   `json:"public_approved"`
}

type ServiceEnrollmentPoll struct {
	Status     string                  `json:"status"` // pending | approved | denied | expired | consumed
	Grant      *ServiceEnrollmentGrant `json:"grant,omitempty"`
	DeliveryID string                  `json:"delivery_id,omitempty"`
	Detail     string                  `json:"detail,omitempty"`
}

type serviceEnrollmentStartRequest struct {
	Protocol        string                    `json:"protocol"`
	Manifest        ServiceEnrollmentManifest `json:"manifest"`
	ManifestSHA256  string                    `json:"manifest_sha256"`
	DevicePublicKey string                    `json:"device_public_key"`
}

type serviceEnrollmentStartResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
	ManifestSHA256          string `json:"manifest_sha256"`
	PublicApprovalRequired  bool   `json:"public_approval_required"`
}

type serviceEnrollmentPollRequest struct {
	Protocol       string `json:"protocol"`
	DeviceCode     string `json:"device_code"`
	ManifestSHA256 string `json:"manifest_sha256"`
	AckDelivery    string `json:"ack_delivery,omitempty"`
	Proof          struct {
		Algorithm string `json:"alg"`
		PublicKey string `json:"public_key"`
		Signature string `json:"signature"`
	} `json:"proof"`
}

// ServiceEnrollmentHTTPError is a sanitized worker failure. Response bodies
// are not included, preventing an accidentally returned token from reaching a
// log line through Error().
type ServiceEnrollmentHTTPError struct {
	Status int
	Code   string
	Detail string
}

func (e *ServiceEnrollmentHTTPError) Error() string {
	return fmt.Sprintf("Finch enrollment failed (%s, HTTP %d): %s", e.Code, e.Status, e.Detail)
}

// StartServiceEnrollment creates an ephemeral Ed25519 key and starts approval.
// Possession of the short user_code is insufficient to poll the grant: the
// worker must also verify the Ed25519 signature made by PollServiceEnrollment.
func StartServiceEnrollment(ctx context.Context, hub string, manifest ServiceEnrollmentManifest, client *http.Client) (*PendingServiceEnrollment, error) {
	return StartServiceEnrollmentWithOptions(ctx, hub, manifest, ServiceEnrollmentOptions{HTTPClient: client})
}

func StartServiceEnrollmentWithOptions(ctx context.Context, hub string, manifest ServiceEnrollmentManifest, options ServiceEnrollmentOptions) (*PendingServiceEnrollment, error) {
	base, err := validateEnrollmentHub(hub)
	if err != nil {
		return nil, err
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generating enrollment proof key: %w", err)
	}
	manifest.MachineFingerprint = enrollmentKeyFingerprint(publicKey)
	manifest, err = normalizeServiceEnrollmentManifest(manifest)
	if err != nil {
		return nil, err
	}
	digest, err := serviceManifestDigest(manifest)
	if err != nil {
		return nil, err
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	client = enrollmentNoRedirectClient(client)
	allowedOrigins, err := enrollmentVerificationOrigins(base, options.AllowedVerificationOrigins)
	if err != nil {
		return nil, err
	}
	reqBody := serviceEnrollmentStartRequest{
		Protocol: serviceEnrollmentProtocol, Manifest: manifest,
		ManifestSHA256:  digest,
		DevicePublicKey: base64.RawURLEncoding.EncodeToString(publicKey),
	}
	var started serviceEnrollmentStartResponse
	if err := postEnrollmentJSON(ctx, client, base+serviceEnrollmentStartPath, reqBody, &started); err != nil {
		return nil, err
	}
	if started.DeviceCode == "" || len(started.DeviceCode) > 512 || started.UserCode == "" || len(started.UserCode) > 32 || started.ExpiresIn <= 0 || started.ExpiresIn > 600 {
		return nil, fmt.Errorf("Finch enrollment start returned an incomplete challenge")
	}
	if started.ManifestSHA256 != digest {
		return nil, fmt.Errorf("Finch enrollment start changed the approved manifest")
	}
	if err := validateVerificationURL(started.VerificationURI, allowedOrigins); err != nil {
		return nil, fmt.Errorf("invalid verification_uri: %w", err)
	}
	if err := validateVerificationURL(started.VerificationURIComplete, allowedOrigins); err != nil {
		return nil, fmt.Errorf("invalid verification_uri_complete: %w", err)
	}
	if manifest.EdgeAuth == "public" && !started.PublicApprovalRequired {
		return nil, fmt.Errorf("Finch did not require separate public-access approval")
	}
	interval := started.Interval
	if interval <= 0 {
		interval = 3
	}
	if interval > 30 {
		return nil, fmt.Errorf("Finch enrollment poll interval is unreasonably long")
	}
	prompt := ServiceEnrollmentPrompt{
		VerificationURI: started.VerificationURI, VerificationURIComplete: started.VerificationURIComplete,
		UserCode: started.UserCode, ExpiresAt: time.Now().Add(time.Duration(started.ExpiresIn) * time.Second),
		IntervalSeconds: interval, ManifestSHA256: digest, Manifest: manifest,
		PublicApprovalRequired: started.PublicApprovalRequired,
	}
	return &PendingServiceEnrollment{
		hub: base, deviceCode: started.DeviceCode, publicKey: publicKey, privateKey: privateKey,
		client: client, prompt: prompt, manifestDigest: digest,
	}, nil
}

// PollServiceEnrollment proves possession of the ephemeral key and retrieves
// at most one service-scoped grant. The worker is responsible for consuming an
// approved device code atomically.
func PollServiceEnrollment(ctx context.Context, pending *PendingServiceEnrollment) (*ServiceEnrollmentPoll, error) {
	if pending == nil || len(pending.privateKey) != ed25519.PrivateKeySize || pending.deviceCode == "" {
		return nil, fmt.Errorf("invalid pending Finch enrollment")
	}
	statement := serviceEnrollmentProofStatement(pending.deviceCode, pending.manifestDigest)
	signature := ed25519.Sign(pending.privateKey, []byte(statement))
	body := serviceEnrollmentPollRequest{
		Protocol:       serviceEnrollmentProtocol,
		DeviceCode:     pending.deviceCode,
		ManifestSHA256: pending.manifestDigest,
	}
	body.Proof.Algorithm = "Ed25519"
	body.Proof.PublicKey = base64.RawURLEncoding.EncodeToString(pending.publicKey)
	body.Proof.Signature = base64.RawURLEncoding.EncodeToString(signature)
	var polled ServiceEnrollmentPoll
	if err := postEnrollmentJSON(ctx, pending.client, pending.hub+serviceEnrollmentPollPath, body, &polled); err != nil {
		return nil, err
	}
	switch polled.Status {
	case "pending", "denied", "expired":
		if polled.Grant != nil {
			return nil, fmt.Errorf("Finch returned a credential for enrollment state %q", polled.Status)
		}
		return &polled, nil
	case "approved":
		if polled.DeliveryID == "" || len(polled.DeliveryID) > 256 {
			return nil, fmt.Errorf("approved Finch enrollment omitted delivery_id")
		}
		if err := validateServiceEnrollmentGrant(pending.prompt.Manifest, pending.manifestDigest, polled.Grant); err != nil {
			return nil, err
		}
		return &polled, nil
	default:
		return nil, fmt.Errorf("Finch returned unknown enrollment state %q", polled.Status)
	}
}

// AckServiceEnrollment confirms durable credential persistence. Until this
// proof-bound acknowledgement arrives, the Worker retains and redelivers the
// same approved grant for a short bounded window.
func AckServiceEnrollment(ctx context.Context, pending *PendingServiceEnrollment, deliveryID string) error {
	if pending == nil || len(pending.privateKey) != ed25519.PrivateKeySize || deliveryID == "" || len(deliveryID) > 256 {
		return fmt.Errorf("invalid Finch enrollment delivery acknowledgement")
	}
	body := serviceEnrollmentPollRequest{
		Protocol: serviceEnrollmentProtocol, DeviceCode: pending.deviceCode,
		ManifestSHA256: pending.manifestDigest, AckDelivery: deliveryID,
	}
	statement := serviceEnrollmentAckStatement(pending.deviceCode, pending.manifestDigest, deliveryID)
	signature := ed25519.Sign(pending.privateKey, []byte(statement))
	body.Proof.Algorithm = "Ed25519"
	body.Proof.PublicKey = base64.RawURLEncoding.EncodeToString(pending.publicKey)
	body.Proof.Signature = base64.RawURLEncoding.EncodeToString(signature)
	var acknowledged ServiceEnrollmentPoll
	if err := postEnrollmentJSON(ctx, pending.client, pending.hub+serviceEnrollmentPollPath, body, &acknowledged); err != nil {
		return err
	}
	if acknowledged.Status != "consumed" || acknowledged.Grant != nil {
		return fmt.Errorf("Finch did not acknowledge enrollment delivery")
	}
	return nil
}

// PersistServiceEnrollmentGrant atomically writes the scoped credential using
// Finch's normal owner-only state path. The caller must wake the relay
// reconciler immediately after this returns; it must not wait for lease expiry.
func PersistServiceEnrollmentGrant(hub, credentialPath string, grant *ServiceEnrollmentGrant, manifest ServiceEnrollmentManifest) error {
	if grant == nil || grant.RefreshToken == "" || grant.Tenant == "" || grant.Service == "" || grant.Box == "" {
		return fmt.Errorf("cannot persist an incomplete Finch service grant")
	}
	canonical, err := normalizeServiceEnrollmentManifest(manifest)
	if err != nil {
		return fmt.Errorf("cannot persist invalid approved manifest: %w", err)
	}
	digest, err := serviceManifestDigest(canonical)
	if err != nil {
		return err
	}
	if err := validateServiceEnrollmentGrant(canonical, digest, grant); err != nil {
		return fmt.Errorf("cannot persist a grant that differs from its approved manifest: %w", err)
	}
	return saveState(credentialPath, &agentState{
		Hub: strings.TrimRight(hub, "/"), Tenant: grant.Tenant, Service: grant.Service,
		Box: grant.Box, RefreshToken: grant.RefreshToken,
		ApprovedRoutes: append([]string(nil), canonical.Routes...), ApprovedEdgeAuth: canonical.EdgeAuth,
		ApprovedTenant: grant.Tenant, ApprovedManifestSHA256: digest,
	})
}

func normalizeServiceEnrollmentManifest(m ServiceEnrollmentManifest) (ServiceEnrollmentManifest, error) {
	m.Service = strings.TrimSpace(m.Service)
	m.AppPath = strings.TrimSpace(m.AppPath)
	m.Machine = strings.TrimSpace(m.Machine)
	if !serviceEnrollmentLabel.MatchString(m.Service) {
		return m, fmt.Errorf("service must be 1-100 ASCII letters, digits, spaces, dot, underscore, or hyphen")
	}
	if !serviceEnrollmentAppPath.MatchString(m.AppPath) {
		return m, fmt.Errorf("app_path must be one safe URL segment")
	}
	if !serviceEnrollmentMachine.MatchString(m.Machine) {
		return m, fmt.Errorf("machine must be 1-64 characters using letters, digits, spaces, dot, underscore, or hyphen")
	}
	if !strings.HasPrefix(m.MachineFingerprint, "SHA256:") {
		return m, fmt.Errorf("machine_fingerprint must be derived from the device proof key")
	}
	if m.EdgeAuth == "" {
		m.EdgeAuth = "key"
	}
	if m.EdgeAuth != "key" && m.EdgeAuth != "public" {
		return m, fmt.Errorf("edge_auth must be key or public")
	}
	if m.ExpectedTenant != "" && !serviceEnrollmentTenant.MatchString(m.ExpectedTenant) {
		return m, fmt.Errorf("expected_tenant contains unsafe characters")
	}
	if len(m.Routes) == 0 {
		m.Routes = []string{"/mcp", "/api/v1", "/birdz"}
	}
	if len(m.Routes) > 16 {
		return m, fmt.Errorf("at most 16 routes are allowed")
	}
	seen := map[string]bool{}
	routes := make([]string, 0, len(m.Routes))
	for _, route := range m.Routes {
		route = strings.TrimSuffix(strings.TrimSpace(route), "/")
		if route == "" || len(route) > 256 || route == "/" || !strings.HasPrefix(route, "/") || strings.ContainsAny(route, "*?#\\%") || path.Clean(route) != route {
			return m, fmt.Errorf("route %q must be a safe non-root path prefix", route)
		}
		for _, segment := range strings.Split(strings.TrimPrefix(route, "/"), "/") {
			if !serviceEnrollmentRouteSegment.MatchString(segment) {
				return m, fmt.Errorf("route %q contains an unsafe path segment", route)
			}
		}
		if !seen[route] {
			seen[route] = true
			routes = append(routes, route)
		}
	}
	sort.Strings(routes)
	m.Routes = routes
	return m, nil
}

func serviceManifestDigest(manifest ServiceEnrollmentManifest) (string, error) {
	b, err := json.Marshal(manifest)
	if err != nil {
		return "", fmt.Errorf("encoding Finch service manifest: %w", err)
	}
	digest := sha256.Sum256(b)
	return hex.EncodeToString(digest[:]), nil
}

func enrollmentKeyFingerprint(publicKey ed25519.PublicKey) string {
	digest := sha256.Sum256(publicKey)
	return "SHA256:" + hex.EncodeToString(digest[:16])
}

func serviceEnrollmentProofStatement(deviceCode, manifestDigest string) string {
	return serviceEnrollmentProtocol + "\npoll\n" + deviceCode + "\n" + manifestDigest
}

func serviceEnrollmentAckStatement(deviceCode, manifestDigest, deliveryID string) string {
	return serviceEnrollmentProtocol + "\nack\n" + deviceCode + "\n" + manifestDigest + "\n" + deliveryID
}

func validateServiceEnrollmentGrant(manifest ServiceEnrollmentManifest, digest string, grant *ServiceEnrollmentGrant) error {
	if grant == nil || grant.RefreshToken == "" || grant.Tenant == "" || grant.Box == "" {
		return fmt.Errorf("approved Finch enrollment omitted its service credential")
	}
	if grant.ManifestSHA256 != digest || grant.EdgeAuth != manifest.EdgeAuth || grant.MachineFingerprint != manifest.MachineFingerprint {
		return fmt.Errorf("approved Finch enrollment does not match the requested manifest")
	}
	if grant.Service != manifest.AppPath {
		return fmt.Errorf("approved Finch service %q does not match app_path %q", grant.Service, manifest.AppPath)
	}
	if grant.Box != manifest.Machine {
		return fmt.Errorf("approved Finch box %q does not match machine %q", grant.Box, manifest.Machine)
	}
	if manifest.ExpectedTenant != "" && grant.Tenant != manifest.ExpectedTenant {
		return fmt.Errorf("approved Finch tenant %q does not match expected tenant %q", grant.Tenant, manifest.ExpectedTenant)
	}
	if manifest.EdgeAuth == "public" && !grant.PublicApproved {
		return fmt.Errorf("public Finch service was not explicitly approved")
	}
	return nil
}

func validateEnrollmentHub(hub string) (string, error) {
	hub = strings.TrimRight(strings.TrimSpace(hub), "/")
	if hub == "" {
		hub = "https://finchmcp.com"
	}
	u, err := url.Parse(hub)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("invalid Finch hub %q", hub)
	}
	return hub, nil
}

func validateVerificationURL(raw string, allowedOrigins map[string]bool) error {
	if len(raw) > 2048 {
		return fmt.Errorf("URL is too long")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Fragment != "" {
		return fmt.Errorf("must be an absolute http(s) URL without credentials or fragment")
	}
	if !allowedOrigins[urlOrigin(u)] {
		return fmt.Errorf("origin %q is not an allowed Finch dashboard", urlOrigin(u))
	}
	return nil
}

func enrollmentVerificationOrigins(hub string, extras []string) (map[string]bool, error) {
	hubURL, _ := url.Parse(hub)
	origins := map[string]bool{urlOrigin(hubURL): true}
	for _, raw := range extras {
		u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("invalid Finch verification origin %q", raw)
		}
		if hubURL.Scheme == "https" && u.Scheme != "https" {
			return nil, fmt.Errorf("Finch verification origin %q downgrades HTTPS", raw)
		}
		origins[urlOrigin(u)] = true
	}
	return origins, nil
}

func urlOrigin(u *url.URL) string {
	return strings.ToLower(u.Scheme + "://" + u.Host)
}

func postEnrollmentJSON(ctx context.Context, client *http.Client, endpoint string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "finch-agent/"+agentVersion)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	limited := io.LimitReader(resp.Body, maxEnrollmentResponseBytes+1)
	payload, err := io.ReadAll(limited)
	if err != nil {
		return err
	}
	if len(payload) > maxEnrollmentResponseBytes {
		return fmt.Errorf("Finch enrollment response exceeded %d bytes", maxEnrollmentResponseBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var e struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(payload, &e) != nil || e.Error.Code == "" {
			e.Error.Code = "http_error"
		}
		code, detail := safeServiceEnrollmentError(resp.StatusCode, e.Error.Code)
		return &ServiceEnrollmentHTTPError{Status: resp.StatusCode, Code: code, Detail: detail}
	}
	if err := json.Unmarshal(payload, output); err != nil {
		return fmt.Errorf("decoding Finch enrollment response: %w", err)
	}
	return nil
}

func enrollmentNoRedirectClient(client *http.Client) *http.Client {
	clone := *client
	clone.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &clone
}

func safeServiceEnrollmentError(status int, code string) (string, string) {
	messages := map[string]string{
		"rate_limited":       "Finch enrollment is rate limited; retry later",
		"invalid_manifest":   "Finch rejected the service manifest",
		"manifest_conflict":  "The Finch app path is already owned by another manifest",
		"invalid_proof":      "Finch rejected the device proof",
		"enrollment_expired": "The Finch enrollment expired",
		"enrollment_denied":  "The Finch enrollment was denied",
		"unauthorized":       "Finch enrollment requires an authorized approver",
	}
	if detail := messages[code]; detail != "" {
		return code, detail
	}
	return "http_error", fmt.Sprintf("Finch enrollment endpoint returned HTTP %d", status)
}
