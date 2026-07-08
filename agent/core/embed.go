package core

// embed.go — the embeddable relay entry points. These let the SAME relay engine
// the `finch` CLI runs be driven in-process by another program (notably the
// gomobile-bound Android SDK in ../mobile), without the CLI's flag parsing,
// log.Fatal exits, or finch.yml. They reuse join/refresh/serve/enrollToState
// verbatim — the protocol and SSRF/auth invariants are identical to `finch run`.
//
// Two entry points, mirroring `finch enroll` + `finch run`:
//   - EmbedEnroll: one-shot — trade a dashboard ticket for a saved credential.
//   - Embed:       resume from the credential and hold the relay open until the
//                  passed context is cancelled (the host app's Stop()).

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Version returns the agent version literal (overridable at build/release time
// via -ldflags "-X github.com/digibugcat/finch/agent/core.agentVersion=<v>").
// Exposed so the mobile SDK and host apps can display / report it.
func Version() string { return agentVersion }

// EmbedOptions configures one embedded service relay. All fields are plain
// values so the mobile bind layer can pass them straight through.
type EmbedOptions struct {
	Hub            string // hub base URL; "" defaults to https://finchmcp.com
	Box            string // this device's name; "" defaults to os.Hostname()
	AppPath        string // public URL segment / service id (informational here)
	Upstream       string // local service base URL, e.g. http://127.0.0.1:8080
	CredentialPath string // file the refresh credential is read from / written to
	Ticket         string // one-shot enrollment ticket (first run / re-enroll only)
	ForwardAll     bool   // forward the whole host (default: confine to /mcp)
}

func (o EmbedOptions) hub() string {
	if o.Hub == "" {
		return "https://finchmcp.com"
	}
	return strings.TrimRight(o.Hub, "/")
}

func (o EmbedOptions) box() string {
	if o.Box != "" {
		return o.Box
	}
	h, _ := os.Hostname()
	return h
}

// validate parses + checks the upstream and required fields shared by both
// entry points. Returns the parsed upstream URL.
func (o EmbedOptions) validate() (*url.URL, error) {
	if o.CredentialPath == "" {
		return nil, fmt.Errorf("CredentialPath is required")
	}
	up, err := url.Parse(strings.TrimRight(o.Upstream, "/"))
	if err != nil || up.Scheme == "" || up.Host == "" {
		return nil, fmt.Errorf("upstream %q is not a valid absolute URL", o.Upstream)
	}
	return up, nil
}

// EmbedEnroll trades a one-shot dashboard ticket for a long-lived refresh
// credential and writes it (0600) to o.CredentialPath. Call once per device;
// afterwards Embed resumes from the credential with no ticket. Synchronous so the
// host app can surface a bad/expired ticket immediately.
func EmbedEnroll(o EmbedOptions) error {
	if _, err := o.validate(); err != nil {
		return err
	}
	if o.Ticket == "" {
		return fmt.Errorf("a ticket is required to enroll")
	}
	if _, _, err := enrollToState(o.hub(), o.box(), o.Ticket, o.CredentialPath); err != nil {
		return err
	}
	return nil
}

// RunConfig loads a finch.yml manifest and serves every ingress rule concurrently
// — the same multi-service model as `finch run`, but ctx-aware and non-fatal so
// a host program (the desktop tray app) can drive it and Stop() it cleanly. It
// reuses the per-service Embed loop, and when the box is logged in (finch login)
// best-effort self-approves each service so none are stuck pending — the CLI
// token holder is the tenant admin. status, if non-nil, receives per-service
// lifecycle updates (app_path, state, detail); the caller marshals to its UI.
//
// Returns nil once ctx is cancelled and all relays have wound down; a non-nil
// error only for a terminal manifest problem (unreadable finch.yml, no rules).
func RunConfig(ctx context.Context, configPath string, status func(appPath, state, detail string)) error {
	if status == nil {
		status = func(string, string, string) {}
	}
	host, _ := os.Hostname()
	cfg, err := loadConfig(configPath, host)
	if err != nil {
		return err
	}
	if len(cfg.Ingress) == 0 {
		return fmt.Errorf("finch.yml has no ingress rules — nothing to serve")
	}

	// Self-approve via the saved CLI token (best-effort, idempotent): clears the
	// pending gate so services go live without a dashboard hop. Only when the
	// token targets this manifest's hub.
	if cred := loadCliCredQuiet(); cred != nil && cred.Hub == cfg.hubBase() {
		for _, ing := range cfg.Ingress {
			_ = cliApprove(cred, ing.AppPath)
		}
	}

	var wg sync.WaitGroup
	for _, ing := range cfg.Ingress {
		ing := ing
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := Embed(ctx, EmbedOptions{
				Hub:            cfg.Hub,
				Box:            cfg.Box,
				AppPath:        ing.AppPath,
				Upstream:       ing.Service,
				CredentialPath: cfg.statePathFor(ing.AppPath),
				ForwardAll:     ing.ForwardAll,
			}, func(state, detail string) { status(ing.AppPath, state, detail) }); err != nil {
				status(ing.AppPath, "error", err.Error())
			}
		}()
	}
	wg.Wait()
	return nil
}

// hubBase mirrors EmbedOptions.hub()'s normalization for the config's hub, so the
// CLI-token hub comparison in RunConfig matches how relays actually dial out.
func (c *config) hubBase() string {
	if c.Hub == "" {
		return "https://finchmcp.com"
	}
	return strings.TrimRight(c.Hub, "/")
}

// Embed resumes the service from its saved credential and holds the relay open,
// reconnecting with backoff, until ctx is cancelled. If no usable credential
// exists and o.Ticket is set, it enrolls first (the same resume-then-ticket
// fallback the single-service CLI path uses). status, if non-nil, receives
// lifecycle updates ("connecting"/"live"/"connected"/"reconnecting"/"enrolled"/
// "warn") on this goroutine — the caller marshals to its UI thread.
//
// Returns nil on a clean ctx cancellation; a non-nil error only for a terminal
// setup failure (bad upstream, not enrolled and no ticket, enroll rejected).
func Embed(ctx context.Context, o EmbedOptions, status func(state, detail string)) error {
	if status == nil {
		status = func(string, string) {}
	}
	up, err := o.validate()
	if err != nil {
		return err
	}
	hub := o.hub()

	// Resume from the saved credential for THIS hub; fall back to the ticket.
	var jr *joinResp
	refreshToken := ""
	if saved, _ := loadState(o.CredentialPath); saved != nil && saved.RefreshToken != "" && saved.Hub == hub {
		if r, rerr := refresh(hub, saved.RefreshToken); rerr == nil {
			jr, refreshToken = r, saved.RefreshToken
			status("connecting", "resumed from saved credential")
		} else {
			status("warn", fmt.Sprintf("saved credential unusable: %v", rerr))
		}
	}
	if jr == nil && o.Ticket != "" {
		st, ejr, eerr := enrollToState(hub, o.box(), o.Ticket, o.CredentialPath)
		if eerr != nil {
			return fmt.Errorf("enroll failed: %w", eerr)
		}
		jr, refreshToken = ejr, st.RefreshToken
		status("enrolled", "credential saved")
	}
	if jr == nil {
		return fmt.Errorf("not enrolled: pass a Ticket on first run")
	}

	wsBase := relayDialURL(jr, hub)
	connectToken := jr.ConnectToken
	connectExp := tokenExp(connectToken)
	status("live", jr.URL)

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
		// Refresh the connect-token near expiry by trading the refresh token.
		if time.Now().Add(connectSkew).After(connectExp) {
			fresh, rerr := refresh(hub, refreshToken)
			if rerr != nil {
				status("reconnecting", fmt.Sprintf("refresh failed: %v", rerr))
				if !sleep() {
					return nil
				}
				continue
			}
			connectToken = fresh.ConnectToken
			connectExp = tokenExp(connectToken)
			wsBase = relayDialURL(fresh, hub)
		}

		wsURL := wsBase + "?ct=" + url.QueryEscape(connectToken)
		start := time.Now()
		status("connected", "")
		serr := serve(ctx, wsURL, up, o.ForwardAll, hub)
		if ctx.Err() != nil {
			return nil // Stop() cancelled the link — clean shutdown
		}
		if serr != nil {
			status("reconnecting", serr.Error())
			if !sleep() {
				return nil
			}
			continue
		}
		// Clean disconnect with no ctx cancel — reset backoff if we held a while.
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
	}
}
