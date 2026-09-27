package core

// relay_loop.go — the one relay lifecycle every serve path shares. `finch run`
// (one relay per finch.yml ingress rule) and single-service `finch join` both
// go through superviseRelay → runRelay, so resume/refresh/reconnect behavior and
// the SSRF/auth invariants in serve/forward are identical for both.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// relayOptions configures one service relay.
type relayOptions struct {
	Hub            string // hub base URL; "" defaults to https://finchmcp.com
	Box            string // this box's name; "" defaults to os.Hostname()
	AppPath        string // public URL segment / service id; "" in single-service mode (logs only)
	Upstream       string // local service base URL, e.g. http://127.0.0.1:8080
	CredentialPath string // file the refresh credential is read from / written to
	Ticket         string // single-service `finch join --ticket` re-enroll fallback; "" in config mode
	ForwardAll     bool   // forward the whole host (default: confine to /mcp)
	AutoApprove    bool   // config mode: self-approve AppPath again whenever a new credential is picked up
	WatchManifest  bool   // single-service mode: hand off to finch.yml once `finch add` writes it
	// Report, when set, receives the relay's state transitions (see
	// run_status.go): connected, reconnecting, credential_error.
	Report func(state, detail string)
}

func (o relayOptions) report(state, detail string) {
	if o.Report != nil {
		o.Report(state, detail)
	}
}

func (o relayOptions) hub() string {
	if o.Hub == "" {
		return "https://finchmcp.com"
	}
	return strings.TrimRight(o.Hub, "/")
}

func (o relayOptions) box() string {
	if o.Box != "" {
		return o.Box
	}
	h, _ := os.Hostname()
	return h
}

// logPrefix labels a relay's log lines with its app_path in config mode.
func (o relayOptions) logPrefix() string {
	if o.AppPath == "" {
		return "finch"
	}
	return "finch[" + o.AppPath + "]"
}

// validate parses + checks the upstream and required fields. Returns the parsed
// upstream URL.
func (o relayOptions) validate() (*url.URL, error) {
	if o.CredentialPath == "" {
		return nil, fmt.Errorf("CredentialPath is required")
	}
	if _, err := validateHubTransportURL(o.hub()); err != nil {
		return nil, err
	}
	return parseUpstreamTransportURL(o.Upstream)
}

// errNotEnrolled is runRelay's result when the service has no usable saved
// credential for this hub and no ticket to enroll with.
var errNotEnrolled = errors.New("not enrolled on this box")

// errManifestChanged is superviseRelay's result in single-service mode when
// finch.yml was written while the relay waited for a new credential: the
// recovery for a revoked `finch join` credential is `finch add`, which enrolls
// into finch.yml, so the caller switches this process over to serving it.
var errManifestChanged = errors.New("finch.yml changed")

// credentialError is runRelay's terminal "this credential cannot serve" result
// (errNotEnrolled or a hub auth rejection). It records the fingerprint of the
// credential runRelay actually tried ("" when none was usable), so the
// supervisor waits for a credential different from THAT one — not whatever is
// on disk by the time the rejection surfaces, which `finch add` may already
// have replaced with a good one.
type credentialError struct {
	attempted string
	err       error
}

func (e *credentialError) Error() string { return e.err.Error() }
func (e *credentialError) Unwrap() error { return e.err }

// runConfig serves every ingress rule from a finch.yml — one relay per service,
// concurrently, over a single process (the cloudflared model) — until SIGINT or
// SIGTERM, which closes each relay cleanly.
func runConfig(cfg *config) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return serveConfig(ctx, cfg)
}

func serveConfig(ctx context.Context, cfg *config) error {
	if len(cfg.Ingress) == 0 {
		return newCLIError(codeNotFound, "finch add <name> --service <url>", "finch.yml lists no services yet; add one with 'finch add <name> --service <url>'")
	}
	// One box-level lock for the whole config run: a second finch run against the
	// same credentials dir would dial the same slugs and supersede these relays,
	// flapping both. (The systemd unit is the intended owner.)
	release, ok := lockState(filepath.Join(cfg.CredentialsDir, "finch-run"))
	if !ok {
		return newCLIError(codeInternal, "finch service status", "another 'finch run' is already serving this machine (%s); stop it first (Ctrl-C in its terminal), or check the background service", cfg.CredentialsDir)
	}
	defer release()
	status := newRunStatusWriter(cfg)
	defer status.remove()

	var wg sync.WaitGroup
	for _, ing := range cfg.Ingress {
		o := relayOptions{
			Hub: cfg.Hub, Box: cfg.Box, AppPath: ing.AppPath, Upstream: ing.Service,
			CredentialPath: cfg.statePathFor(ing.AppPath), ForwardAll: ing.ForwardAll,
			AutoApprove: true, Report: status.reporter(ing.AppPath),
		}
		autoApproveAsync(o.hub(), o.AppPath)
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = superviseRelay(ctx, o)
		}()
	}
	log.Printf("finch: publishing %d service(s) from finch.yml as machine %q", len(cfg.Ingress), cfg.Box)
	wg.Wait()
	return nil
}

// autoApproveAsync self-approves a service a logged-in box serves (best effort,
// idempotent): the CLI-token holder is the tenant admin, so a service that
// registered as pending goes live without a separate `finch approve`. It runs
// at startup and again whenever a relay picks up a re-enrolled credential (the
// re-join lands pending too). The CLI login is read per call, so a login made
// after `finch run` started still counts, and the request runs in the
// background so one slow hub call never blocks a sibling or a relay.
func autoApproveAsync(hub, appPath string) {
	cred, _ := readCliCred()
	if cred == nil || strings.TrimRight(cred.Hub, "/") != hub {
		return
	}
	go func() {
		if err := cliApprove(cred, appPath); err != nil {
			log.Printf("finch[%s]: auto-approve skipped (%v) — run `finch approve %s` if it stays pending", appPath, err, appPath)
		}
	}()
}

// superviseRelay keeps one service's relay alive until ctx is cancelled
// (returning nil). runRelay reconnects on its own and hands control back only
// on a terminal problem (or a panic, recovered here). A missing or hub-rejected
// credential is stable operator work — re-enroll with `finch add` — so we wait
// for a replacement credential rather than hammer the hub; anything else
// retries with a capped backoff. One wedged service never takes its siblings
// down.
//
// With o.WatchManifest (single-service `finch join` mode) that wait also ends
// when finch.yml changes, returning errManifestChanged: `finch add` writes its
// credential under the manifest's credentials dir, never to this relay's
// --state file, so the caller must switch to serving the manifest.
func superviseRelay(ctx context.Context, o relayOptions) error {
	lp := o.logPrefix()
	backoff := 5 * time.Second
	var manifestChanged func() bool
	if o.WatchManifest {
		baseline := manifestFingerprint()
		manifestChanged = func() bool { return manifestFingerprint() != baseline }
	}
	for {
		started := time.Now()
		err := callRelay(ctx, o)
		if ctx.Err() != nil {
			return nil
		}
		var cerr *credentialError
		if errors.As(err, &cerr) {
			o.report(relayCredentialError, err.Error())
			if o.WatchManifest {
				log.Printf("%s: %v — run 'finch login', then 'finch add <name> --service %s'; this process switches to serving finch.yml once it is written",
					lp, err, o.Upstream)
			} else {
				log.Printf("%s: %v — run 'finch add %s --service %s' to publish it again; waiting for a new credential at %s",
					lp, err, o.AppPath, o.Upstream, o.CredentialPath)
			}
			if werr := waitForNewCredential(ctx, o.CredentialPath, o.hub(), cerr.attempted, manifestChanged); werr != nil {
				if errors.Is(werr, errManifestChanged) {
					return werr
				}
				return nil
			}
			if o.AutoApprove && o.AppPath != "" {
				// The re-enrollment registered as pending; approve it like startup does.
				autoApproveAsync(o.hub(), o.AppPath)
			}
			backoff = 5 * time.Second
			continue
		}
		if err == nil {
			err = errors.New("relay exited unexpectedly")
		}
		if time.Since(started) > time.Minute {
			backoff = 5 * time.Second
		}
		o.report(relayReconnecting, err.Error())
		log.Printf("%s: %v — restarting in %s", lp, err, backoff)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		if backoff < time.Minute {
			backoff *= 2
		}
	}
}

// callRelay runs one relay, converting a panic in the serve/forward path into an
// error so the supervisor restarts just this service.
func callRelay(ctx context.Context, o relayOptions) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("relay panic: %v", recovered)
		}
	}()
	return runRelay(ctx, o)
}

// credentialFingerprint identifies one saved credential ("" for none), so
// waitForNewCredential can tell a replacement from the rejected one.
func credentialFingerprint(st *agentState) string {
	if st == nil {
		return ""
	}
	return st.Hub + "\x00" + st.RefreshToken
}

// waitForNewCredential polls (locally — no hub traffic) until a usable
// credential for hub, different from previous, is saved at path. A non-nil
// manifestChanged is polled too; once it reports true the wait ends with
// errManifestChanged.
func waitForNewCredential(ctx context.Context, path, hub, previous string, manifestChanged func() bool) error {
	for {
		if saved, err := loadState(path); err == nil && saved != nil && saved.RefreshToken != "" &&
			saved.Hub == hub && credentialFingerprint(saved) != previous {
			return nil
		}
		if manifestChanged != nil && manifestChanged() {
			return errManifestChanged
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// manifestFingerprint identifies the finch.yml findManifest would serve right
// now: its path plus a hash of its contents ("" when there is none). `finch add`
// always rewrites the manifest, so any change means there is a rule to serve.
func manifestFingerprint() string {
	p := findManifest()
	if p == "" {
		return ""
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return p
	}
	sum := sha256.Sum256(b)
	return p + "\x00" + hex.EncodeToString(sum[:])
}

// runRelay resumes the service from its saved credential and holds the relay
// open, reconnecting with backoff, until ctx is cancelled. If no usable
// credential exists and o.Ticket is set, it enrolls first (the single-service
// `finch join --ticket` fallback, which also recovers a box whose credential was
// revoked server-side).
//
// Returns nil on ctx cancellation; otherwise a terminal error: a
// *credentialError (errNotEnrolled, or a hub auth rejection — 401/403, the
// credential was revoked), or a setup failure the supervisor retries.
func runRelay(ctx context.Context, o relayOptions) error {
	up, err := o.validate()
	if err != nil {
		return err
	}
	hub, lp := o.hub(), o.logPrefix()

	// Resume from the saved credential for THIS hub; fall back to the ticket.
	var jr *joinResp
	var resumeErr error
	refreshToken := ""
	attempted := "" // fingerprint of the credential this run relies on
	rejected := func(err error) error { return &credentialError{attempted: attempted, err: err} }
	if saved, _ := loadState(o.CredentialPath); saved != nil && saved.RefreshToken != "" && saved.Hub == hub {
		attempted = credentialFingerprint(saved)
		if r, rerr := refreshContext(ctx, hub, saved.RefreshToken); rerr == nil {
			jr, refreshToken = r, saved.RefreshToken
			log.Printf("%s: resumed from saved credential (%s)", lp, o.CredentialPath)
		} else {
			resumeErr = rerr
			log.Printf("%s: saved credential at %s unusable (%v)", lp, o.CredentialPath, rerr)
		}
	}
	if jr == nil && o.Ticket != "" {
		st, ejr, eerr := enrollToState(hub, o.box(), o.Ticket, o.CredentialPath)
		if eerr != nil {
			if isHubAuthRejection(resumeErr) {
				return rejected(fmt.Errorf("saved credential rejected: %w (re-enroll from ticket failed: %v)", resumeErr, eerr))
			}
			return fmt.Errorf("enroll failed: %w", eerr)
		}
		jr, refreshToken = ejr, st.RefreshToken
		attempted = credentialFingerprint(st)
		log.Printf("%s: enrolled from ticket — credential saved to %s", lp, o.CredentialPath)
	}
	if jr == nil {
		if resumeErr != nil {
			if isHubAuthRejection(resumeErr) {
				return rejected(fmt.Errorf("saved credential rejected: %w", resumeErr))
			}
			return fmt.Errorf("resume service: %w", resumeErr)
		}
		return rejected(errNotEnrolled)
	}

	name := o.AppPath
	if name == "" {
		name = jr.Service
	}
	endpoint := jr.URL
	if endpoint == "" { // older hub without host/url in the join response
		endpoint = relayURL(hub, jr.Service, jr.Box)
	}
	log.Printf("%s: ✓ %s is live at %s  →  %s  (machine %q)", lp, name, endpoint, up, jr.Box)

	wsBase := relayDialURL(jr, hub)
	connectToken := jr.ConnectToken
	connectExp := tokenExp(connectToken)

	// Exponential backoff (capped 30s); ctx-aware sleep returns false if cancelled.
	backoff := time.Second
	sleep := func() bool {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
		return true
	}

	for {
		if ctx.Err() != nil {
			return nil // clean shutdown
		}
		// Refresh the connect-token near expiry by trading the long-lived refresh
		// token at /refresh — never the one-shot join ticket (the hub burned it).
		if time.Now().Add(connectSkew).After(connectExp) {
			fresh, rerr := refreshContext(ctx, hub, refreshToken)
			if rerr != nil {
				if isHubAuthRejection(rerr) {
					return rejected(fmt.Errorf("saved credential rejected: %w", rerr))
				}
				o.report(relayReconnecting, "connect-token refresh failed: "+rerr.Error())
				log.Printf("%s: connect-token refresh failed: %v (retrying in %s)", lp, rerr, backoff)
				if !sleep() {
					return nil
				}
				continue
			}
			connectToken = fresh.ConnectToken
			connectExp = tokenExp(connectToken)
			// Re-read each refresh so a host change is picked up, not pinned to the
			// first value.
			wsBase = relayDialURL(fresh, hub)
			log.Printf("%s: refreshed connect-token (valid until %s)", lp, connectExp.Format(time.RFC3339))
		}

		wsURL, uerr := relayConnectURL(wsBase, connectToken)
		if uerr != nil {
			connectExp = time.Time{}
			log.Printf("%s: invalid relay assignment: %v (refreshing after %s)", lp, uerr, backoff)
			if !sleep() {
				return nil
			}
			continue
		}
		start := time.Now()
		serr := serveLink(ctx, wsURL, up, o.ForwardAll, hub, func() { o.report(relayConnected, "") })
		if ctx.Err() != nil {
			return nil // shutdown cancelled the link — clean exit
		}
		// Reset the backoff after a link that held for a while.
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		if serr != nil {
			o.report(relayReconnecting, serr.Error())
			log.Printf("%s: link down: %v (reconnecting in %s)", lp, serr, backoff)
			if !sleep() {
				return nil
			}
		}
	}
}
