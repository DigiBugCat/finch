package core

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
)

// relayRunFunc owns one desired relay until ctx is cancelled. Production uses
// Embed; the seam keeps lease/reconciliation tests completely local.
type relayRunFunc func(context.Context, ServiceStatus, func(state, detail string)) error

type supervisedRelay struct {
	desired ServiceStatus
	cancel  context.CancelFunc
	done    chan struct{}
}

const relayStopTimeout = 5 * time.Second

// runRelayReconciler maintains one relay per static config entry or live
// AviaryMCP lease. Dynamic lease renewals only move the deadline; they do not
// bounce a healthy relay. Delete, expiry, replacement, and parent shutdown each
// cancel the old relay exactly once through its context.CancelFunc.
func runRelayReconciler(ctx context.Context, registry *DynamicRegistry, run relayRunFunc) error {
	if run == nil {
		panic("nil relay runner")
	}
	running := map[string]*supervisedRelay{}
	var wg sync.WaitGroup

	stop := func(appPath string, relay *supervisedRelay) bool {
		relay.cancel()
		// Do not overlap two relays for the same public service. In particular,
		// wait for serve() to close its authenticated WebSocket before a new lease
		// owner can dial and mutate the hub's online/offline state.
		select {
		case <-relay.done:
			delete(running, appPath)
			return true
		case <-time.After(relayStopTimeout):
			return false
		}
	}
	start := func(service ServiceStatus) {
		relayCtx, cancel := context.WithCancel(ctx)
		relay := &supervisedRelay{desired: service, cancel: cancel, done: make(chan struct{})}
		running[service.AppPath] = relay
		registry.UpdateState(service.AppPath, service.LeaseID, "starting", "")
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				close(relay.done)
				registry.signal()
			}()
			setStatus := func(state, detail string) {
				registry.UpdateState(service.AppPath, service.LeaseID, state, detail)
			}
			for {
				err := callRelayRunner(relayCtx, run, service, setStatus)
				if relayCtx.Err() != nil {
					return
				}
				if err == nil {
					err = fmt.Errorf("relay exited unexpectedly")
				}
				setStatus("error", err.Error())
				select {
				case <-relayCtx.Done():
					return
				case <-time.After(5 * time.Second):
					setStatus("starting", "retrying relay")
				}
			}
		}()
	}

	reconcile := func() {
		desired := registry.Services() // also expires every lease at or past now
		want := make(map[string]ServiceStatus, len(desired))
		for _, service := range desired {
			want[service.AppPath] = service
		}
		for appPath, relay := range running {
			service, ok := want[appPath]
			if !ok || !sameRelayIdentity(relay.desired, service) {
				if !stop(appPath, relay) {
					if ok {
						registry.UpdateState(service.AppPath, service.LeaseID, "error", "previous relay did not stop within timeout")
					}
					// Keep the old entry as a tombstone so a replacement cannot
					// overlap it. Its eventual exit signals another reconciliation.
					delete(want, appPath)
				}
			}
		}
		for appPath, service := range want {
			if _, ok := running[appPath]; !ok {
				start(service)
			}
		}
	}

	reconcile()
	for {
		var timer *time.Timer
		var timerC <-chan time.Time
		if expiry, ok := registry.NextExpiry(); ok {
			delay := expiry.Sub(registry.now())
			if delay < 0 {
				delay = 0
			}
			timer = time.NewTimer(delay)
			timerC = timer.C
		}
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			for _, relay := range running {
				relay.cancel()
			}
			waitDone := make(chan struct{})
			go func() { wg.Wait(); close(waitDone) }()
			select {
			case <-waitDone:
				return nil
			case <-time.After(relayStopTimeout):
				return fmt.Errorf("relay shutdown exceeded %s", relayStopTimeout)
			}
		case <-registry.Changed():
			if timer != nil {
				timer.Stop()
			}
			reconcile()
		case <-timerC:
			reconcile()
		}
	}
}

func callRelayRunner(ctx context.Context, run relayRunFunc, service ServiceStatus, status func(string, string)) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("relay panic: %v", recovered)
		}
	}()
	return run(ctx, service, status)
}

func sameRelayIdentity(a, b ServiceStatus) bool {
	return a.AppPath == b.AppPath &&
		a.Upstream == b.Upstream &&
		a.Source == b.Source &&
		a.LeaseID == b.LeaseID &&
		a.EdgeAuth == b.EdgeAuth &&
		a.ExpectedTenant == b.ExpectedTenant &&
		a.ForwardAll == b.ForwardAll &&
		slices.Equal(a.Routes, b.Routes)
}

// configRelayRunner adapts desired services onto the existing context-aware
// relay engine. A missing credential is a stable state, not a cloud retry loop:
// the separate enrollment/bootstrap flow creates the credential, after which
// the application can renew/re-register its lease.
func configRelayRunner(cfg *config, registry *DynamicRegistry) relayRunFunc {
	return func(ctx context.Context, service ServiceStatus, status func(string, string)) error {
		credentialPath := cfg.statePathFor(service.AppPath)
		for {
			saved, err := waitForUsableCredential(ctx, registry, cfg.hubBase(), credentialPath, "", status)
			if err != nil {
				return nil // context cancellation
			}
			fingerprint := credentialFingerprint(saved)
			if service.Source == "aviarymcp" {
				if err := validateApprovedManifest(saved, service); err != nil {
					status("needs_enrollment", "approved manifest mismatch: "+err.Error())
					if err := waitForCredentialReplacement(ctx, registry, cfg.hubBase(), credentialPath, fingerprint); err != nil {
						return nil
					}
					continue
				}
				registry.UpdateTenant(service.AppPath, service.LeaseID, saved.Tenant)
			}
			err = Embed(ctx, EmbedOptions{
				Hub:            cfg.Hub,
				Box:            cfg.Box,
				AppPath:        service.AppPath,
				Upstream:       service.Upstream,
				CredentialPath: credentialPath,
				ForwardAll:     service.ForwardAll,
				Routes:         service.Routes,
			}, status)
			if ctx.Err() != nil {
				return nil
			}
			if !isHubAuthRejection(err) {
				return err
			}
			// A saved credential that cannot resume (including a hub-side 403
			// revocation) is stable enrollment work. Keep it for forensics and
			// wait for the device flow to atomically replace it; do not hammer the
			// cloud every five seconds.
			status("needs_enrollment", fmt.Sprintf("saved credential unusable: %v", err))
			if _, err := waitForUsableCredential(ctx, registry, cfg.hubBase(), credentialPath, fingerprint, status); err != nil {
				return nil
			}
		}
	}
}

func validateApprovedManifest(saved *agentState, service ServiceStatus) error {
	if saved == nil || saved.ApprovedManifestSHA256 == "" {
		return fmt.Errorf("dynamic service requires a scoped credential bound to an approved manifest")
	}
	if saved.Service != service.AppPath {
		return fmt.Errorf("approved service %q does not match registration %q", saved.Service, service.AppPath)
	}
	if !slices.Equal(saved.ApprovedRoutes, service.Routes) {
		return fmt.Errorf("registered routes differ from the approved manifest; start a new enrollment")
	}
	if saved.ApprovedEdgeAuth != service.EdgeAuth {
		return fmt.Errorf("edge_auth %q differs from approved %q; start a new enrollment", service.EdgeAuth, saved.ApprovedEdgeAuth)
	}
	if saved.Tenant == "" || saved.ApprovedTenant != saved.Tenant {
		return fmt.Errorf("scoped credential is missing its approved tenant binding; start a new enrollment")
	}
	if service.ExpectedTenant != "" && saved.Tenant != service.ExpectedTenant {
		return fmt.Errorf("expected_tenant %q does not match the approved credential tenant; start a new enrollment", service.ExpectedTenant)
	}
	return nil
}

func waitForCredentialReplacement(ctx context.Context, registry *DynamicRegistry, hub, credentialPath, previousFingerprint string) error {
	for {
		changed := registry.CredentialChanged()
		saved, err := loadState(credentialPath)
		if err == nil && saved != nil && saved.Hub == hub && saved.RefreshToken != "" {
			if credentialFingerprint(saved) != previousFingerprint {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changed:
		case <-time.After(time.Second):
		}
	}
}

func waitForUsableCredential(ctx context.Context, registry *DynamicRegistry, hub, credentialPath, previousFingerprint string, status func(string, string)) (*agentState, error) {
	for {
		// Capture the broadcast generation before reading disk: a grant written
		// after this point closes the channel; a grant written earlier is visible
		// in the following load. That ordering avoids a lost wakeup.
		credentialChanged := registry.CredentialChanged()
		saved, err := loadState(credentialPath)
		if err == nil && saved != nil && saved.RefreshToken != "" && saved.Hub == hub {
			fingerprint := credentialFingerprint(saved)
			if fingerprint != previousFingerprint {
				return saved, nil
			}
		}
		detail := "service has no credential on this box"
		if err != nil {
			detail = fmt.Sprintf("read credential: %v", err)
		} else if previousFingerprint != "" {
			detail = "waiting for replacement enrollment credential"
		}
		status("needs_enrollment", detail)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-credentialChanged:
		case <-time.After(time.Second):
		}
	}
}

func credentialFingerprint(saved *agentState) string {
	if saved == nil {
		return ""
	}
	return strings.Join([]string{
		saved.Hub,
		saved.Service,
		saved.RefreshToken,
		strings.Join(saved.ApprovedRoutes, "\x1f"),
		saved.ApprovedEdgeAuth,
		saved.ApprovedTenant,
		saved.ApprovedManifestSHA256,
	}, "\x00")
}
