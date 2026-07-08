// finch agent — runs on the box (Mac mini, Pi, laptop). It claims a
// box slot with a one-shot enrollment ticket, then dials OUT to the finch
// hub over a single WebSocket (works behind any NAT, no inbound ports) and
// relays each request the hub sends down to the local MCP server.
//
// Usage:
//
//	finch join --hub http://localhost:8787 --ticket <tkt> --upstream http://127.0.0.1:8000
//
// The ticket is minted in the dashboard ("Add device"). On join the hub tells
// us which service/box we are AND hands us a short-lived per-box
// connect-token; we present that token on the relay dial (?ct=<token>) — it is
// the sole proof that authenticates this box-side channel. We then hold the
// relay WebSocket open, reconnect with backoff, and send WS-protocol pings for
// NAT keepalive (the hub auto-pongs them without waking the Durable Object, so
// they're free).
//
// Reconnect model: the enrollment ticket is ONE-SHOT — the hub burns it on the
// first /join and 409s any replay. So /join also hands us a long-lived (~30d)
// per-box REFRESH token. While the still-valid connect-token holds we just
// reconnect with it; once it nears expiry we trade the refresh token at /refresh
// for a fresh connect-token. The one-shot join ticket is never re-used.
//
// We persist that refresh token to --state (0600), so a restart/reboot resumes
// straight from it without a new dashboard ticket — "authenticate once", like
// ngrok. --ticket is only needed on first enroll (or if the credential was
// revoked).
package core

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"gopkg.in/yaml.v3"
)

// agentVersion is the canonical default. Release builds may stamp it via
// `-ldflags "-X main.agentVersion=<v>"`; the literal here is the source of
// truth that CI (scripts/check-versions.mjs) asserts matches the worker's
// LATEST_AGENT and the web dashboard constant. Keep all three in sync.
var agentVersion = "1.5.7"

// connectSkew is how long before a connect-token's exp we treat it as already
// expired and force a fresh /join, so we never dial with a token that lapses
// mid-handshake.
const connectSkew = 5 * time.Second

// headerPair is one ordered [name, value] header tuple. It marshals to / from a
// JSON 2-element array (e.g. ["set-cookie","a=1"]) so the `head` frame can carry
// an ORDERED, duplicate-preserving header list (two Set-Cookie survive). It is a
// distinct shape from the request side's name->value map.
type headerPair [2]string

// frame is the RELAY v2 wire frame: one WS message = one JSON frame. Every frame
// carries { id, type }; `id` correlates a request with its streamed response.
//
// Variants (see worker/test/relay-vectors.json — the shared golden fixture):
//
//	DO -> agent:   req    { id, type, method, path, headers(map), body }
//	               window { id, type, credits }   // flow control: 0=pause, >0=resume
//	agent -> DO:   head   { id, type, status, headers([][name,value]) }
//	               chunk  { id, type, data }   // data = base64(std,padded) body slice
//	               end    { id, type }
//	               err    { id, type, status, message }   // pre-head failure only
//	either:        reset  { id, type, message? }          // abort an in-flight stream
//
// `window` is the additive backpressure frame (DO -> agent only). credits===0 is
// a PAUSE (stop sending body chunks for this id); credits>0 is a RESUME. The DO
// emits it when its in-memory relay queue crosses / drains below the high-water
// mark; the agent NEVER sends window frames.
//
// CRITICAL: the request side's `headers` is a name->value MAP (ReqHeaders) while
// the `head` frame's `headers` is an ORDERED [name,value] LIST (HeadHeaders).
// They are different JSON shapes, so they MUST live in different struct fields —
// both serialize to the key "headers", but only one is ever set per frame type,
// so they never collide on the wire (the unused one is omitempty-elided).
type frame struct {
	ID   string `json:"id"`
	Type string `json:"type"` // req | head | chunk | end | err | reset

	// req (DO -> agent)
	Method     string            `json:"method,omitempty"`
	Path       string            `json:"path,omitempty"`
	ReqHeaders map[string]string `json:"-"`
	Body       string            `json:"body,omitempty"`

	// head (agent -> DO): ordered, duplicate-preserving [name,value] pairs.
	HeadHeaders []headerPair `json:"-"`

	// chunk (agent -> DO): base64(std,padded) of a body byte slice.
	Data string `json:"data,omitempty"`

	// err (agent -> DO, pre-head only) / head: HTTP status.
	Status int `json:"status,omitempty"`
	// err / reset: human-readable detail (omitted when empty).
	Message string `json:"message,omitempty"`

	// window (DO -> agent only): flow-control credits. 0 => pause sending body
	// chunks for this id; >0 => resume. A pointer so a literal credits:0 frame is
	// distinguishable from an absent field on the wire (the agent treats nil as
	// "not a window frame"). The agent only ever RECEIVES window frames — it never
	// constructs one in any production path. MarshalJSON does serialize Credits
	// (the *int keeps credits:0 while a nil pointer is omitempty-elided) solely so
	// the shared golden-vector codec round-trip passes.
	Credits *int `json:"-"`
}

// frameWire is the on-the-wire JSON shape. We hand-marshal so the single
// "headers" key can hold EITHER the request map OR the ordered head list
// depending on the frame type, while keeping omitempty semantics everywhere.
type frameWire struct {
	ID          string            `json:"id"`
	Type        string            `json:"type"`
	Method      string            `json:"method,omitempty"`
	Path        string            `json:"path,omitempty"`
	ReqHeaders  map[string]string `json:"-"`
	HeadHeaders []headerPair      `json:"-"`
	Headers     json.RawMessage   `json:"headers,omitempty"`
	Body        string            `json:"body,omitempty"`
	Data        string            `json:"data,omitempty"`
	Status      int               `json:"status,omitempty"`
	Message     string            `json:"message,omitempty"`
	Credits     *int              `json:"credits,omitempty"`
}

// MarshalJSON renders a frame to the canonical wire JSON. The "headers" key is
// the request map for a `req` frame and the ordered list for a `head` frame.
func (f frame) MarshalJSON() ([]byte, error) {
	w := frameWire{
		ID: f.ID, Type: f.Type,
		Method: f.Method, Path: f.Path, Body: f.Body,
		Data: f.Data, Status: f.Status, Message: f.Message,
		Credits: f.Credits,
	}
	switch {
	case f.ReqHeaders != nil:
		raw, err := json.Marshal(f.ReqHeaders)
		if err != nil {
			return nil, err
		}
		w.Headers = raw
	case f.HeadHeaders != nil:
		raw, err := json.Marshal(f.HeadHeaders)
		if err != nil {
			return nil, err
		}
		w.Headers = raw
	}
	return json.Marshal(w)
}

// UnmarshalJSON parses a wire frame, decoding "headers" into the request map
// (object) or the ordered head list (array) based on its JSON shape. The agent
// only ever RECEIVES `req` (object headers), but we handle both for the codec
// round-trip test against the shared golden vectors.
func (f *frame) UnmarshalJSON(data []byte) error {
	var w frameWire
	if err := json.Unmarshal(data, &w); err != nil {
		return err
	}
	f.ID, f.Type = w.ID, w.Type
	f.Method, f.Path, f.Body = w.Method, w.Path, w.Body
	f.Data, f.Status, f.Message = w.Data, w.Status, w.Message
	f.Credits = w.Credits
	f.ReqHeaders, f.HeadHeaders = nil, nil
	if len(w.Headers) > 0 {
		trimmed := bytes.TrimSpace(w.Headers)
		switch {
		case len(trimmed) > 0 && trimmed[0] == '[':
			if err := json.Unmarshal(w.Headers, &f.HeadHeaders); err != nil {
				return err
			}
		case len(trimmed) > 0 && trimmed[0] == '{':
			if err := json.Unmarshal(w.Headers, &f.ReqHeaders); err != nil {
				return err
			}
		}
	}
	return nil
}

type joinResp struct {
	OK      bool   `json:"ok"`
	Tenant  string `json:"tenant"`
	Service string `json:"service"`
	Box     string `json:"box"`
	Host    string `json:"host"` // public host, e.g. <slug>.finchmcp.com
	URL     string `json:"url"`  // public MCP endpoint for this service
	// Fully-formed relay dial URL (wss://<slug-host>/<service>/<box>/_connect),
	// computed hub-side from the tenant's real host — correct in every env
	// (staging → inbound workers.dev host; prod → <slug>.finchmcp.com). We PREFER
	// this over rebuilding from the local `hub` config, which only knows the host
	// the operator typed at login (the apex on prod, which the relay plane does
	// NOT serve — that path is owned by the web worker and 404s the WS upgrade).
	// Empty only on a legacy hub, where we fall back to relayURL(hub,…).
	ConnectURL string `json:"connectUrl"`
	// Short-lived (~120s) per-box HMAC grant. We present it on the _connect
	// dial as ?ct=<connectToken>; the hub verifies it BEFORE accepting the relay
	// socket. (FLEET_SECRET is gone — this token is the whole proof.)
	ConnectToken string `json:"connectToken"`
	// Long-lived (~30d) per-box credential, returned only by /join. We keep
	// it and present it at /refresh to mint fresh connect-tokens, so we never
	// re-use the one-shot enrollment ticket. Empty on a /refresh response.
	RefreshToken string `json:"refreshToken"`
	Error        string `json:"error"`
}

func Main() {
	// Setup subcommands (cloudflared-style): `finch login` saves a CLI token,
	// `finch add` enrolls a service + appends an ingress rule. These run
	// and exit; `join`/`run`/bare fall through to the relay agent below.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "login":
			cmdLogin(os.Args[2:])
			return
		case "add":
			cmdAdd(os.Args[2:])
			return
		case "enroll":
			cmdEnroll(os.Args[2:])
			return
		case "approve":
			cmdApprove(os.Args[2:])
			return
		case "auth":
			cmdAuth(os.Args[2:])
			return
		case "token":
			cmdToken(os.Args[2:])
			return
		case "status":
			cmdStatus(os.Args[2:])
			return
		case "keys":
			cmdKeys(os.Args[2:])
			return
		case "domain":
			cmdDomain(os.Args[2:])
			return
		case "fleet", "ls":
			cmdFleet(os.Args[2:])
			return
		case "rm":
			cmdRm(os.Args[2:])
			return
		case "revoke-tokens":
			cmdRevokeTokens(os.Args[2:])
			return
		case "test":
			cmdTest(os.Args[2:])
			return
		case "call":
			cmdCall(os.Args[2:])
			return
		case "update":
			cmdUpdate(os.Args[2:])
			return
		case "guide":
			printGuide()
			return
		case "help", "-h", "--help":
			printUsage()
			return
		}
	}

	hostName, _ := os.Hostname()
	hub := flag.String("hub", "https://finchmcp.com", "finch hub base URL (http[s]://…)")
	ticket := flag.String("ticket", "", "one-shot enrollment ticket from the dashboard (first run only; '-' reads it from stdin, or set FINCH_TICKET; later runs resume from --state)")
	box := flag.String("box", hostName, "this box's name")
	upstream := flag.String("upstream", "http://127.0.0.1:8000", "local MCP server base URL")
	statePath := flag.String("state", defaultStatePath(), "file that persists the per-box refresh credential so a restart needs no new ticket")
	configPath := flag.String("config", "", "path to a finch.yml manifest; serves every ingress rule (one local service per app_path) over one process")
	forwardAll := flag.Bool("forward-all", false, "forward the WHOLE loopback host (every path), not just /mcp — for a website or any non-MCP HTTP app (single-service mode)")

	// The install one-liners are `finch join …` (single service) and `finch run`
	// (read finch.yml). flag.Parse stops at the first non-flag arg, so strip a
	// leading subcommand — both `finch join …`/`finch run` and bare `finch …` work.
	if len(os.Args) > 1 && (os.Args[1] == "join" || os.Args[1] == "run") {
		os.Args = append(os.Args[:1], os.Args[2:]...)
	}
	flag.Parse()

	// Argv-free ticket intake (--ticket - from stdin, FINCH_TICKET from env),
	// same as `finch enroll`: keep the refresh-token-minting ticket off the
	// process table / shell history on the single-service `finch join` path.
	*ticket = resolveTicket(*ticket)

	// finch.toml support (TOML parsing) was removed in favor of a cloudflared-style
	// finch.yml. Fail loudly rather than silently dropping an upgraded
	// multi-service box to single-service mode and serving nothing: both when
	// --config points at a .toml and when a legacy finch.toml is the only manifest
	// in the working dir.
	if strings.HasSuffix(strings.ToLower(*configPath), ".toml") {
		fatalLegacyTOML(*configPath, hostName)
	}

	// Config-driven (cloudflared-style) when --config is given, or a finch.yml is
	// found in the search path and no single-service flags were overridden. The
	// search prefers the working dir (project-local manifests keep working) then
	// falls back to the dotfile home (~/.finch/finch.yml, ~/.config/finch/finch.yml)
	// so a box with a home-dir manifest serves from anywhere, not just when cwd
	// happens to be home. A legacy finch.toml in cwd still fails loudly.
	cfgPath := *configPath
	if cfgPath == "" && *ticket == "" {
		if _, terr := os.Stat("finch.toml"); terr == nil {
			fatalLegacyTOML("finch.toml", hostName)
		}
		cfgPath = findManifest()
	}
	if cfgPath != "" {
		cfg, err := loadConfig(cfgPath, hostName)
		if err != nil {
			log.Fatalf("finch: %v", err)
		}
		runConfig(cfg)
		return
	}

	// Single-service: confine forwarded requests to one upstream (SSRF guard in
	// forward()). Parse it once.
	upstreamURL, err := url.Parse(strings.TrimRight(*upstream, "/"))
	if err != nil || upstreamURL.Scheme == "" || upstreamURL.Host == "" {
		log.Fatalf("finch: --upstream %q is not a valid absolute URL", *upstream)
	}
	// `finch join --ticket <t>` enrolls inline (first run), then resumes from the
	// saved credential — the same enroll-then-resume split `finch enroll`/`finch
	// run` use, collapsed into one command for the single-service path.
	if *ticket != "" {
		if saved, _ := loadState(*statePath); saved == nil || saved.RefreshToken == "" || saved.Hub != *hub {
			if _, _, eerr := enrollToState(*hub, *box, *ticket, *statePath); eerr != nil {
				log.Fatalf("finch: enroll failed: %v", eerr)
			}
			log.Printf("finch: enrolled — credential saved to %s", *statePath)
		}
	}
	// Refuse to start if another finch run already holds this state — a second
	// process would dial out for the same slugs and supersede the incumbent
	// relay, causing the two to flap forever. (The systemd unit is the intended
	// owner; this stops a stray manual `finch run` from fighting it.)
	release, ok := lockState(*statePath)
	if !ok {
		log.Fatalf("finch: another finch run already holds %s — refusing to start a second relay", *statePath)
	}
	defer release()

	// Thread the ticket into the run path so a same-hub-but-revoked credential can
	// still recover from a fresh ticket: runService re-enrolls if resume fails.
	// superviseService restarts the relay on a panic/unexpected return, matching
	// config mode's self-heal.
	superviseService(serviceOpts{
		hub: *hub, statePath: *statePath, upstream: upstreamURL,
		ticket: *ticket, box: *box, forwardAll: *forwardAll,
	})
}

// enrollToState trades a one-shot ticket for a long-lived refresh credential via
// /join and persists it (0600) to statePath, returning the join response too so
// callers can read the hub-slugified service id. Shared by the single-service
// `finch join` path and `finch add` (both write a fixed state file).
func enrollToState(hub, box, ticket, statePath string) (*agentState, *joinResp, error) {
	jr, err := join(hub, ticket, box)
	if err != nil {
		return nil, nil, err
	}
	st, err := persistJoin(hub, jr, statePath)
	if err != nil {
		return nil, nil, err
	}
	return st, jr, nil
}

// persistJoin saves a /join result as the box-side refresh credential (0600).
// Only /join returns the long-lived refresh token, so it must be present. Split
// out of enrollToState so `finch enroll` can read the hub-slugified service id
// from the join response BEFORE choosing the credential filename.
func persistJoin(hub string, jr *joinResp, statePath string) (*agentState, error) {
	if jr.RefreshToken == "" {
		return nil, fmt.Errorf("hub returned no refresh token")
	}
	st := &agentState{Hub: hub, Tenant: jr.Tenant, Service: jr.Service, Box: jr.Box, RefreshToken: jr.RefreshToken}
	if err := saveState(statePath, st); err != nil {
		return nil, fmt.Errorf("persisting credential to %s: %w", statePath, err)
	}
	return st, nil
}

// runConfig serves every ingress rule from a finch.yml — one relay loop per
// service, concurrently, over a single process (the cloudflared model). Each
// rule maps a public path (<slug>.finchmcp.com/<app_path>/…) to a local service.
// A rule with a bad service or a not-yet-enrolled service is logged and
// skipped; its siblings keep running.
func runConfig(cfg *config) {
	if len(cfg.Ingress) == 0 {
		log.Fatal("finch: finch.yml has no ingress rules — nothing to serve")
	}
	// One box-level lock for the whole config run: a second finch run against the
	// same credentials dir would dial the same slugs and supersede these relays,
	// flapping both. (The systemd unit is the intended owner.)
	release, ok := lockState(filepath.Join(cfg.CredentialsDir, "finch-run"))
	if !ok {
		log.Fatalf("finch: another finch run already serves %s — refusing to start a second relay", cfg.CredentialsDir)
	}
	defer release()
	// If this box is logged in (finch login), self-approve the services we
	// serve — the CLI token holder is the tenant admin, so no dashboard hop.
	autoApprove := loadCliCredQuiet() != nil

	var wg sync.WaitGroup
	started := 0
	for _, ing := range cfg.Ingress {
		up, err := url.Parse(strings.TrimRight(ing.Service, "/"))
		if err != nil || up.Scheme == "" || up.Host == "" {
			log.Printf("finch[%s]: service %q is not a valid absolute URL — skipping", ing.AppPath, ing.Service)
			continue
		}
		statePath := cfg.statePathFor(ing.AppPath)
		started++
		wg.Add(1)
		go func(ing ingress, up *url.URL, sp string) {
			defer wg.Done()
			superviseService(serviceOpts{
				hub: cfg.Hub, statePath: sp, upstream: up,
				label: ing.AppPath, autoApprove: autoApprove, forwardAll: ing.ForwardAll,
			})
		}(ing, up, statePath)
	}
	if started == 0 {
		log.Fatal("finch: no valid ingress rules to serve")
	}
	log.Printf("finch: serving %d ingress rule(s) from finch.yml as box %q", started, cfg.Box)
	wg.Wait()
}

// serviceOpts bundles one relay loop's inputs: the hub + saved-credential path,
// the local upstream, a log label, whether to auto-approve, the whole-host
// forwarding opt-in, and the single-service ticket fallback (ticket+box, both
// empty in config mode).
type serviceOpts struct {
	hub         string
	statePath   string
	upstream    *url.URL
	label       string
	autoApprove bool
	forwardAll  bool
	ticket      string // single-service `finch join --ticket` recovery; "" in config mode
	box         string // box name the ticket fallback enrolls under
}

// superviseService keeps one app's relay alive for the whole process lifetime.
// runService already reconnects forever on its own, so the only ways it hands
// control back are (a) a panic somewhere in the serve/forward path, which would
// otherwise silently kill just this goroutine and leave the app dark while
// siblings keep running, or (b) an unexpected return of the reconnect loop. Both
// are treated as transient: log and restart after a short delay. The one
// non-transient outcome is "not enrolled" (runService returns enrolled=false),
// which is an operator/config error no restart can fix — we stop and leave the
// sibling apps running. This is the self-heal that makes a single wedged app
// (see the woodpecker silent-relay incident) recover without a full restart.
func superviseService(o serviceOpts) {
	lp := "finch"
	if o.label != "" {
		lp = "finch[" + o.label + "]"
	}
	for {
		enrolled := func() (enrolled bool) {
			defer func() {
				if r := recover(); r != nil {
					// A panic left enrolled at its zero value (false); force true so
					// the caller restarts rather than treating it as "not enrolled".
					enrolled = true
					log.Printf("%s: relay panic recovered: %v — restarting in 5s", lp, r)
				}
			}()
			return runService(o)
		}()
		if !enrolled {
			return // not enrolled — a restart can't help; let siblings run.
		}
		log.Printf("%s: relay exited unexpectedly — restarting in 5s", lp)
		time.Sleep(5 * time.Second)
	}
}

// runService resumes one already-enrolled service from its saved credential,
// then holds its relay open and reconnects forever. `o.label` prefixes logs (the
// ingress app_path in config mode, empty in single-service mode). Enrollment is
// normally a separate one-time step (`finch enroll`); in single-service mode a
// fresh `o.ticket` is a fallback that re-enrolls when the saved credential is
// missing/revoked. It returns false only when no usable credential and no ticket
// are found (logs how to enroll); the forever-reconnect loop otherwise never
// returns, so a normal return is unexpected and reported as enrolled=true.
func runService(o serviceOpts) (enrolled bool) {
	hub, statePath, upstreamURL, label, autoApprove := o.hub, o.statePath, o.upstream, o.label, o.autoApprove
	lp := "finch"
	if label != "" {
		lp = "finch[" + label + "]"
	}

	// Resume from a saved refresh credential for THIS hub. Enrollment (minting the
	// credential from a one-shot ticket) happens out-of-band in `finch enroll`.
	var jr *joinResp
	refreshToken := ""
	if saved, _ := loadState(statePath); saved != nil && saved.RefreshToken != "" && saved.Hub == hub {
		if r, rerr := refresh(hub, saved.RefreshToken); rerr == nil {
			jr = r
			refreshToken = saved.RefreshToken
			log.Printf("%s: resumed from saved credential (%s)", lp, statePath)
		} else {
			log.Printf("%s: saved credential at %s unusable (%v)", lp, statePath, rerr)
		}
	}
	// Resume-then-ticket fallback (single-service `finch join --ticket`): if the
	// saved credential is missing/revoked/expired and we hold an enrollment ticket,
	// re-enroll with it (overwriting the stale state) and proceed — so a fresh valid
	// ticket always recovers a box whose credential was revoked server-side. The
	// join response already carries a connect-token, so no extra /refresh is needed.
	// Config mode passes no ticket and falls through to the enroll hint below.
	if jr == nil && o.ticket != "" {
		if st, ejr, eerr := enrollToState(hub, o.box, o.ticket, statePath); eerr != nil {
			log.Printf("%s: re-enroll from ticket failed: %v", lp, eerr)
		} else {
			jr = ejr
			refreshToken = st.RefreshToken
			log.Printf("%s: re-enrolled from ticket — credential saved to %s", lp, statePath)
		}
	}
	if jr == nil {
		enrollHint := label
		if enrollHint == "" {
			enrollHint = "<app_path>"
		}
		log.Printf("%s: not enrolled — run: finch enroll %s --ticket <t>", lp, enrollHint)
		return false
	}
	// Describe the rule by its full name: the application, its public endpoint,
	// and the local service it fronts.
	name := label
	if name == "" {
		name = jr.Service
	}
	endpoint := jr.URL
	if endpoint == "" { // older hub without host/url in the join response
		endpoint = relayURL(hub, jr.Service, jr.Box)
	}
	log.Printf("%s: %q live at %s  →  %s  (box %q, tenant %s)",
		lp, name, endpoint, upstreamURL, jr.Box, jr.Tenant)

	// Self-approve via the saved CLI token (best-effort): the box just
	// registered as `pending` if the tenant requires approval; clear that so it
	// goes live once the relay connects — no dashboard hop.
	if autoApprove {
		if cred := loadCliCredQuiet(); cred != nil && cred.Hub == hub {
			if err := cliApprove(cred, jr.Service); err != nil {
				log.Printf("%s: auto-approve skipped (%v) — approve in the dashboard if it stays pending", lp, err)
			} else {
				log.Printf("%s: approved", lp)
			}
		}
	}

	wsBase := relayDialURL(jr, hub)
	connectToken := jr.ConnectToken
	connectExp := tokenExp(connectToken)

	// Exponential backoff (capped at 30s) shared by refresh and reconnect.
	backoff := time.Second
	backoffSleep := func() {
		time.Sleep(backoff)
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
	for {
		// Refresh the connect-token near expiry by trading the long-lived refresh
		// token at /refresh — never the one-shot join ticket (the hub burned it).
		if time.Now().Add(connectSkew).After(connectExp) {
			fresh, err := refresh(hub, refreshToken)
			if err != nil {
				log.Printf("%s: connect-token refresh failed: %v (retrying in %s)", lp, err, backoff)
				backoffSleep()
				continue
			}
			connectToken = fresh.ConnectToken
			connectExp = tokenExp(connectToken)
			// Re-read each refresh so a host change is picked up, not pinned to the
			// first value.
			wsBase = relayDialURL(fresh, hub)
			log.Printf("%s: refreshed connect-token (valid until %s)", lp, connectExp.Format(time.RFC3339))
		}

		wsURL := wsBase + "?ct=" + url.QueryEscape(connectToken)
		start := time.Now()
		if err := serve(context.Background(), wsURL, upstreamURL, o.forwardAll, hub); err != nil {
			log.Printf("%s: link down: %v (reconnecting in %s)", lp, err, backoff)
			backoffSleep()
			continue
		}
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
	}
}

// join claims a box slot with the ticket and returns the hub's assignment
// (including the per-box connect-token). Safe to call again on reconnect
// while the ticket remains within its own TTL.
func join(hub, ticket, box string) (*joinResp, error) {
	body, _ := json.Marshal(map[string]string{
		"ticket":  ticket,
		"box":     box,
		"os":      osLabel(),
		"version": agentVersion,
	})
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(hub, "/")+"/join", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("hub %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var jr joinResp
	if err := json.Unmarshal(b, &jr); err != nil {
		return nil, fmt.Errorf("bad join response: %w", err)
	}
	if !jr.OK || jr.Service == "" || jr.Box == "" {
		return nil, fmt.Errorf("join rejected: %s", jr.Error)
	}
	if jr.ConnectToken == "" {
		return nil, fmt.Errorf("join response missing connectToken")
	}
	return &jr, nil
}

// refresh trades the long-lived per-box refresh token for a fresh
// connect-token, without re-using the one-shot enrollment ticket. The hub
// rejects it (403) if the box was removed from the dashboard, which is how
// revocation propagates to the box within a connect-token TTL.
func refresh(hub, refreshToken string) (*joinResp, error) {
	// version rides along so the hub can re-stamp it: after a hub-pushed update
	// the agent re-execs and resumes via /refresh (never /join), so this is the
	// only place the NEW version reaches the registry. Older hubs ignore it.
	body, _ := json.Marshal(map[string]string{
		"refreshToken": refreshToken,
		"version":      agentVersion,
	})
	req, err := http.NewRequest(http.MethodPost, strings.TrimRight(hub, "/")+"/refresh", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("hub %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var jr joinResp
	if err := json.Unmarshal(b, &jr); err != nil {
		return nil, fmt.Errorf("bad refresh response: %w", err)
	}
	if !jr.OK || jr.Service == "" || jr.Box == "" || jr.ConnectToken == "" {
		return nil, fmt.Errorf("refresh rejected: %s", jr.Error)
	}
	return &jr, nil
}

// tokenExp decodes the (unsigned) expiry from a finch HMAC token of the form
// base64url(JSON payload) "." base64url(sig). We only read the `exp` claim to
// decide when to refresh — the hub still verifies the signature, so trusting
// the unverified payload here is safe (a forged exp only makes us re-/join
// sooner/later, never bypasses hub auth). On any parse failure we return a
// zero time so the caller treats the token as already expired (fail-safe →
// forces a fresh /join).
func tokenExp(token string) time.Time {
	dot := strings.IndexByte(token, '.')
	if dot <= 0 {
		return time.Time{}
	}
	raw, err := base64.RawURLEncoding.DecodeString(token[:dot])
	if err != nil {
		return time.Time{}
	}
	var p struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(raw, &p); err != nil || p.Exp == 0 {
		return time.Time{}
	}
	return time.Unix(p.Exp, 0)
}

// relayDialURL is the relay WS base every dial site must use: PREFER the
// hub-supplied jr.ConnectURL (computed server-side from the tenant's real host —
// correct in staging AND prod), falling back to a local rebuild from `hub` only
// for a legacy hub that predates connectUrl. Rebuilding from `hub` alone is wrong
// on prod, where `hub` is the login apex but the relay plane lives on the tenant
// slug subdomain (the apex WS path is the web worker's and 404s the upgrade).
func relayDialURL(jr *joinResp, hub string) string {
	if jr.ConnectURL != "" {
		return jr.ConnectURL
	}
	return relayURL(hub, jr.Service, jr.Box)
}

// relayURL builds ws(s)://<host>/<service>/<box>/_connect from the hub
// base (without the query string — the caller appends ?ct=<token>).
func relayURL(hub, service, box string) string {
	u, err := url.Parse(strings.TrimRight(hub, "/"))
	if err != nil {
		return hub
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.Path = "/" + service + "/" + box + "/_connect"
	u.RawQuery = ""
	return u.String()
}

func osLabel() string {
	switch runtime.GOOS {
	case "darwin":
		return "macOS"
	case "linux":
		return "Linux"
	case "windows":
		return "Windows"
	default:
		return runtime.GOOS
	}
}

// outStream is the agent's per-in-flight-forward flow-control + cancel handle.
// The read loop owns the registry that maps a request id to its outStream; a
// `window` frame toggles `paused` (and pokes `resume` on a 0->credits resume),
// and a `reset` frame calls `cancel` to abort the upstream read promptly. The
// forwarding goroutine reads `paused` under `mu` and blocks on `resume` (or ctx
// cancel) before each body chunk, which is what bounds the DO's relay queue.
type outStream struct {
	mu     sync.Mutex
	paused bool
	resume chan struct{} // buffered(1): a non-blocking resume signal
	cancel context.CancelFunc
}

// isPaused reports the current pause state under the lock.
func (o *outStream) isPaused() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.paused
}

// setPaused records a new pause state and, on a transition to RESUMED, pokes the
// resume channel non-blockingly so a forward() blocked in waitResume wakes up.
func (o *outStream) setPaused(p bool) {
	o.mu.Lock()
	o.paused = p
	o.mu.Unlock()
	if !p {
		select {
		case o.resume <- struct{}{}:
		default:
		}
	}
}

// serve holds one relay connection for its lifetime; returns on disconnect.
// forwardAll is threaded down to each forward() so resolveUpstream knows whether
// to confine to /mcp (default) or forward the whole host. hub is the box's own
// hub base URL — the pinned source a hub-pushed "update" frame downloads from.
func serve(parent context.Context, wsURL string, upstream *url.URL, forwardAll bool, hub string) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return err
	}
	defer c.Close(websocket.StatusNormalClosure, "bye")
	c.SetReadLimit(32 << 20) // 32 MiB frames
	log.Printf("finch: relay open -> %s", upstream)

	// One writer at a time: coder/websocket forbids concurrent writes. write
	// returns an error so a streaming forward() can ABORT mid-stream when the DO
	// link is dead — otherwise the agent would keep reading a whole upstream body
	// and base64ing it into a void. A write failure also cancels the connection
	// ctx so the read loop unwinds and the reconnect loop takes over.
	var wmu sync.Mutex
	write := func(f frame) error {
		data, err := json.Marshal(f)
		if err != nil {
			log.Printf("finch: marshal %s: %v", f.ID, err)
			return err
		}
		wmu.Lock()
		defer wmu.Unlock()
		wctx, wcancel := context.WithTimeout(ctx, 30*time.Second)
		defer wcancel()
		if err := c.Write(wctx, websocket.MessageText, data); err != nil {
			log.Printf("finch: write %s: %v", f.ID, err)
			cancel()
			return err
		}
		return nil
	}

	// NAT keepalive — hub auto-pongs without waking the Durable Object. Track
	// consecutive ping failures and cancel the connection ctx on the 2nd (we
	// tolerate one missed pong) so a dead peer is detected in ~60s instead of
	// falling back to OS TCP keepalive (~165s). cancel() unblocks c.Read below,
	// which returns and lets the reconnect loop take over. (code-review #26)
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		fails := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
				err := c.Ping(pctx)
				pcancel()
				if err != nil {
					fails++
					log.Printf("finch: keepalive ping failed (%d): %v", fails, err)
					if fails >= 2 {
						log.Printf("finch: peer unresponsive — dropping link")
						cancel()
						return
					}
				} else {
					fails = 0
				}
			}
		}
	}()

	// In-flight forward registry, keyed by request id. The read loop is the SOLE
	// writer of this map (serial), so window/reset routing is naturally
	// serialized against registration; forward() only reads its own outStream
	// (under outStream.mu) and deletes its entry on return. outMu guards the map
	// itself against the concurrent delete each forward goroutine does.
	var outMu sync.Mutex
	out := map[string]*outStream{}
	lookup := func(id string) *outStream {
		outMu.Lock()
		defer outMu.Unlock()
		return out[id]
	}
	remove := func(id string) {
		outMu.Lock()
		delete(out, id)
		outMu.Unlock()
	}

	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return err
		}
		var f frame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		// req/window/reset are the only frame types the agent receives. A req
		// spawns a registered forward; window toggles its pause state; reset
		// cancels + deregisters it. Anything else is ignored.
		switch f.Type {
		case "req":
			fctx, fcancel := context.WithCancel(ctx)
			os := &outStream{resume: make(chan struct{}, 1), cancel: fcancel}
			outMu.Lock()
			out[f.ID] = os
			outMu.Unlock()
			go func(f frame, os *outStream) {
				defer remove(f.ID)
				forward(fctx, upstream, f, write, os, forwardAll)
			}(f, os)
		case "window":
			if os := lookup(f.ID); os != nil {
				// credits===0 => PAUSE; credits>0 => RESUME. A missing credits
				// field (nil) is treated as a pause (fail-closed: never grow the
				// queue on a malformed window).
				resume := f.Credits != nil && *f.Credits > 0
				os.setPaused(!resume)
			}
		case "reset":
			// Abort the in-flight forward: cancel its ctx (stops the upstream
			// read promptly) and drop it from the registry. The DO sends this on
			// idle-after-head / client-cancel; the old read loop IGNORED it and
			// kept draining the upstream into a dead stream — this is the fix.
			if os := lookup(f.ID); os != nil {
				os.cancel()
				remove(f.ID)
			}
		case "update":
			// Out-of-band hub push (dashboard "update now"): self-update from OUR
			// hub's /releases and re-exec in place. Runs in a goroutine so the
			// read loop (and in-flight forwards) are never blocked; singleflight
			// inside drops repeats. Old agents ignore this frame (default case).
			go selfUpdateFromHub(hub)
		}
	}
}

// relayChunkSize is the upstream read granularity. We read the body in ~32KiB
// slices and base64-encode each into one `chunk` frame, so a streaming/SSE/
// long-running upstream is relayed incrementally instead of buffered whole.
const relayChunkSize = 32 << 10

// forward replays one hub request against the local MCP server and STREAMS the
// response back over the relay: a `head` frame the INSTANT status+headers are
// known (this is what unblocks SSE / progress / long-running tools), then zero+
// `chunk` frames of base64'd body slices, then `end`. A failure BEFORE head is
// reported as a single `err` frame (the DO can still fail over to another
// box until head arrives); a failure AFTER head aborts the stream (the DO
// errors its readable) since we are already committed to this box.
//
// The hub-supplied path is sanitized (path.Clean + scheme/host-injection reject
// + base confinement) so a malicious or buggy path can never escape --upstream —
// the relay is otherwise an SSRF foothold into the box's loopback.
//
// There is NO total timeout: a long-running ("thinking") tool or an open SSE
// stream may legitimately run for minutes. The relay ctx still cancels the
// upstream request when the link drops (the DO's idle timeout fires the abort).
//
// Backpressure: `os` carries the flow-control state set by inbound `window`
// frames. BEFORE sending each body chunk forward() blocks while os.paused (on
// os.resume or ctx.Done), so a slow client can't grow the DO's relay queue
// unbounded. The head is emitted before any wait — head is never paused. os may
// be nil (no flow control / direct unit-test call): then it never pauses.
func forward(ctx context.Context, upstream *url.URL, f frame, write func(frame) error, os *outStream, forwardAll bool) {
	target, err := resolveUpstream(upstream, f.Path, forwardAll)
	if err != nil {
		// SSRF reject — pre-head, so the DO turns this into a 403 response.
		write(frame{ID: f.ID, Type: "err", Status: 403, Message: err.Error()})
		return
	}

	req, err := http.NewRequestWithContext(ctx, f.Method, target, strings.NewReader(f.Body))
	if err != nil {
		write(frame{ID: f.ID, Type: "err", Status: 502, Message: err.Error()})
		return
	}
	for k, v := range f.ReqHeaders {
		switch strings.ToLower(k) {
		case "host", "connection", "upgrade", "content-length", "transfer-encoding", "authorization":
			// hop-by-hop / recomputed / credential — never forward to the box.
			// (The hub already strips the caller's finch_ key; we drop it again
			// here as defense-in-depth.)
		default:
			req.Header.Set(k, v)
		}
	}

	resp, err := relayClient(upstream, forwardAll).Do(req)
	if err != nil {
		// Dial / connect failure — pre-head, so the DO maps it to a 502 and may
		// still fail over to another box.
		write(frame{ID: f.ID, Type: "err", Status: 502, Message: err.Error()})
		return
	}
	defer resp.Body.Close()

	// Build the ORDERED, duplicate-preserving head header list (minus hop-by-hop
	// / recomputed), lowercased. We iterate EVERY value per key (not just vs[0])
	// so duplicate Set-Cookie headers survive — collapsing them broke multi-cookie
	// responses. Stateful MCP relies on this (e.g. Mcp-Session-Id from initialize).
	// Non-nil so the `head` frame always carries a "headers" key (even when every
	// upstream header is hop-by-hop) — the DO guards undefined too, but this keeps
	// the wire shape uniform.
	headers := []headerPair{}
	for k, vs := range resp.Header {
		switch strings.ToLower(k) {
		case "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "content-encoding":
			// hop-by-hop / recomputed — never forward.
		default:
			lk := strings.ToLower(k)
			for _, v := range vs {
				headers = append(headers, headerPair{lk, v})
			}
		}
	}
	// Emit head IMMEDIATELY, before reading any body. A write failure here means
	// the DO link is gone; abort (write() already cancelled the ctx).
	if err := write(frame{ID: f.ID, Type: "head", Status: resp.StatusCode, HeadHeaders: headers}); err != nil {
		return
	}

	// Stream the body in ~32KiB reads. Each non-empty read becomes one base64
	// `chunk`; a write failure mid-stream aborts (the DO is dead — don't drain
	// the whole upstream into a void). On clean EOF send `end`.
	buf := make([]byte, relayChunkSize)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			// Backpressure: block here while the DO has paused us (window
			// credits:0), so we don't grow its relay queue beyond the HWM. A
			// resume (window credits>0) or a ctx cancel (reset / link drop)
			// releases us. Re-check after each wake: the DO may have re-paused
			// between our wake and this read. The head was already emitted above,
			// before any wait — head is never paused.
			if os != nil {
				for os.isPaused() {
					select {
					case <-os.resume:
					case <-ctx.Done():
						return
					}
				}
			}
			data := base64.StdEncoding.EncodeToString(buf[:n])
			if werr := write(frame{ID: f.ID, Type: "chunk", Data: data}); werr != nil {
				return
			}
		}
		if rerr != nil {
			if rerr == io.EOF {
				write(frame{ID: f.ID, Type: "end"})
			} else {
				// Body read failed AFTER head (e.g. upstream reset, ctx cancel on
				// link drop). We're committed to this box; abort the stream so
				// the DO errors its readable rather than seeing a clean end.
				write(frame{ID: f.ID, Type: "reset", Message: rerr.Error()})
			}
			return
		}
	}
}

// relayClient returns an http.Client for the relay forward path whose redirect
// policy re-runs the SSRF confinement on EVERY hop. Go's default client follows
// up to 10 redirects to an ARBITRARY host/scheme, which would let a fronted
// service (via an open redirect or reflected Location) steer the agent to
// http://169.254.169.254/ or another loopback port — the exact escape
// resolveUpstream exists to prevent. We re-derive the allowed target from the
// trusted base + the redirect's path and refuse the hop if it doesn't match,
// so a Location can never move host/scheme or climb out of the prefix.
func relayClient(base *url.URL, forwardAll bool) *http.Client {
	return &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("stopped after 10 redirects")
			}
			// The redirect target must stay on the trusted base host+scheme AND
			// pass the same prefix confinement. Host/scheme is pinned by direct
			// comparison (a Location to another host/port/scheme is the SSRF
			// escape). The path is validated through resolveUpstream, which rejects
			// a prefix escape; we compare on the trailing-slash-normalized path so
			// a legitimate canonicalizing 302 (/docs -> /docs/) is still followed.
			if req.URL.Scheme != base.Scheme || req.URL.Host != base.Host {
				return fmt.Errorf("redirect blocked (SSRF confinement): %q leaves %s://%s", req.URL.String(), base.Scheme, base.Host)
			}
			if _, err := resolveUpstream(base, req.URL.Path, forwardAll); err != nil {
				return fmt.Errorf("redirect blocked (SSRF confinement): %w", err)
			}
			return nil
		},
	}
}

// resolveUpstream turns the hub-supplied request path into an absolute upstream
// URL, refusing anything that would escape the allowed prefix.
// Defenses, in order:
//   - reject scheme/authority injection (a path that itself parses to an
//     absolute URL, or starts with "//" → protocol-relative host).
//   - path.Clean to collapse "." / ".." segments, then confine the cleaned path
//     to the allowed prefix so "/mcp/../admin" can't climb out and SSRF
//     something else on loopback.
//   - rebuild the URL from the trusted base host/scheme + the cleaned path +
//     the (query-only) raw query, so host/scheme can never come from the frame.
//
// The allowed prefix is: the service's configured base path when one is set
// (service: http://127.0.0.1:8000/mcp → /mcp); else /mcp by DEFAULT (finch is an
// MCP tunnel first, so the loopback host isn't exposed wholesale). Set forwardAll
// (ingress forward_all: true / --forward-all) to opt OUT of that default and
// forward the WHOLE /<app_path>/* subtree — for a website or any non-MCP HTTP
// app. In every case host/scheme come only from the trusted base, never the frame.
func resolveUpstream(base *url.URL, rawPath string, forwardAll bool) (string, error) {
	if rawPath == "" {
		rawPath = "/"
	}
	// Split off any query string the hub appended (it lives in f.Path).
	reqPath := rawPath
	rawQuery := ""
	if i := strings.IndexByte(rawPath, '?'); i >= 0 {
		reqPath = rawPath[:i]
		rawQuery = rawPath[i+1:]
	}

	// Reject absolute-URL or protocol-relative injection outright: a legitimate
	// relay path is always origin-relative (starts with a single "/").
	if strings.Contains(reqPath, "://") || strings.HasPrefix(reqPath, "//") {
		return "", fmt.Errorf("rejected path (scheme/host injection): %q", reqPath)
	}
	if !strings.HasPrefix(reqPath, "/") {
		return "", fmt.Errorf("rejected path (not origin-relative): %q", reqPath)
	}

	// Collapse . and .. ; path.Clean of an absolute path can never produce a
	// result that climbs above "/", so the cleaned path is always rooted.
	clean := path.Clean(reqPath)

	// Confine to the allowed prefix: the service's configured base path when one is
	// set (e.g. service http://127.0.0.1:8000/mcp confines to /mcp), else /mcp by
	// DEFAULT — UNLESS forwardAll is set, which opts out and forwards the whole
	// /<app_path>/* subtree ("" prefix). When a prefix IS set the cleaned path must
	// BE it or a child of it, so "/mcp/../admin" → "/admin" stays rejected.
	prefix := strings.TrimRight(base.Path, "/")
	if prefix == "" && !forwardAll {
		prefix = "/mcp"
	}
	if prefix != "" && clean != prefix && !strings.HasPrefix(clean, prefix+"/") {
		return "", fmt.Errorf("rejected path (escapes upstream prefix %q): %q", prefix, clean)
	}

	// Build the upstream URL from the trusted base host/scheme + the cleaned
	// path. When the upstream carries a base path it's already a prefix of
	// `clean`, so assigning `clean` is correct (no double-prefix).
	out := *base
	out.Path = clean
	out.RawQuery = rawQuery
	return out.String(), nil
}

// agentState is the small credential the agent persists between runs so a
// restart resumes without a fresh dashboard ticket. It holds the long-lived
// per-box refresh token (and the assignment, for clarity).
// ---- finch.yml manifest (cloudflared-style ingress) ------------------------

// ingress is one rule: expose a local `service` as the service named `path`.
//
//	name    — human label for the application (e.g. "Label Printer"); logs only.
//	path    — the public URL segment AND the service enrolled in the dashboard.
//	          Full endpoint: https://<your-slug>.finchmcp.com/<path>/mcp
//	service — the local server to forward to (e.g. http://127.0.0.1:8000).
//	ticket  — one-shot enrollment ticket, first run only (then state resumes).
type ingress struct {
	AppPath string `yaml:"app_path"`
	Service string `yaml:"service"`
	// ForwardAll opts this rule out of the default /mcp confinement and forwards
	// the WHOLE /<app_path>/* subtree to the service (for a website or any non-MCP
	// HTTP app). Off by default — the default exposes only /mcp.
	ForwardAll bool `yaml:"forward_all,omitempty"`
}

// config is a parsed finch.yml. `credentials-dir` is a DIRECTORY — each
// service's refresh credential is persisted at <credentials-dir>/<app_path>.json,
// so one box can front many services without their credentials colliding. The
// credentials are written out-of-band by `finch enroll`, never by this manifest.
type config struct {
	Hub            string    `yaml:"hub"`
	Box            string    `yaml:"box"`
	CredentialsDir string    `yaml:"credentials-dir,omitempty"`
	Ingress        []ingress `yaml:"ingress"`
}

// fatalLegacyTOML aborts with a migration message. finch.toml support (TOML
// parsing) was removed in favor of a cloudflared-style finch.yml; an upgraded
// multi-service box must migrate rather than silently fall through to
// single-service mode and stop serving every service.
func fatalLegacyTOML(path, hostName string) {
	if hostName == "" {
		hostName = "this-box"
	}
	log.Fatalf("finch: %s is no longer supported — finch now reads a finch.yml manifest.\n"+
		"Migrate to finch.yml (one ingress rule per local service):\n\n"+
		"  hub: https://finchmcp.com\n"+
		"  box: %s\n"+
		"  ingress:\n"+
		"    - app_path: printer\n"+
		"      service: http://127.0.0.1:8000\n\n"+
		"Enroll each app once with `finch enroll <app_path> --ticket <t>`, then run `finch run`.",
		path, hostName)
}

// loadConfig reads + validates a finch.yml, applying defaults (prod hub, this
// box's hostname, ~/.finch credentials dir).
// findManifest locates the finch.yml to serve when no --config was given. Search
// order: the working dir first (project-local manifests, cloudflared-style), then
// the dotfile home so a box with a home-dir manifest serves from any cwd. Returns
// "" when none exists (the caller then falls through to single-service mode).
func findManifest() string {
	candidates := []string{"finch.yml"}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		candidates = append(candidates,
			filepath.Join(home, ".finch", "finch.yml"),
			filepath.Join(home, ".config", "finch", "finch.yml"),
		)
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// defaultManifestPath is where add/status operate by default: the manifest
// findManifest discovers (cwd first, then the dotfile home), or — when none
// exists yet — ~/.finch/finch.yml, so a fresh `finch add` creates the manifest
// in the box's dotfile home instead of littering whatever cwd it ran from.
func defaultManifestPath() string {
	if p := findManifest(); p != "" {
		return p
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".finch", "finch.yml")
	}
	return "finch.yml"
}

func loadConfig(path, hostName string) (*config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	var c config
	if err := yaml.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	if c.Hub == "" {
		c.Hub = "https://finchmcp.com"
	}
	if c.Box == "" {
		c.Box = hostName
	}
	if c.CredentialsDir == "" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			c.CredentialsDir = filepath.Join(home, ".finch")
		} else {
			c.CredentialsDir = ".finch"
		}
	}
	c.CredentialsDir = expandHome(c.CredentialsDir)
	seen := map[string]bool{}
	for i, ing := range c.Ingress {
		if ing.AppPath == "" || ing.Service == "" {
			return nil, fmt.Errorf("ingress #%d: both `app_path` and `service` are required", i+1)
		}
		if strings.ContainsAny(ing.AppPath, "/ ") {
			return nil, fmt.Errorf("ingress app_path %q must be a single URL segment (no slashes or spaces)", ing.AppPath)
		}
		if seen[ing.AppPath] {
			return nil, fmt.Errorf("ingress app_path %q is listed twice", ing.AppPath)
		}
		seen[ing.AppPath] = true
	}
	return &c, nil
}

// statePathFor is where service `appPath`'s refresh credential lives: a per-rule
// file under the credentials dir, so concurrent ingress rules never clobber each
// other.
func (c *config) statePathFor(appPath string) string {
	return filepath.Join(c.CredentialsDir, appPath+".json")
}

// expandHome resolves a leading ~ to the user's home dir.
func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			return filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))
		}
	}
	return p
}

type agentState struct {
	Hub          string `json:"hub"`
	Tenant       string `json:"tenant"`
	Service      string `json:"service"`
	Box          string `json:"box"`
	RefreshToken string `json:"refreshToken"`
}

// defaultStatePath is ~/.finch/agent.json (falls back to the cwd if there's no
// home dir). Boxes running more than one agent should pass a distinct --state.
func defaultStatePath() string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".finch", "agent.json")
	}
	return ".finch-agent.json"
}

// loadState reads the persisted credential, returning (nil,nil) if the file
// doesn't exist yet (first run).
func loadState(path string) (*agentState, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var st agentState
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

// saveState writes the credential 0600 (dir 0700). The refresh token is a
// long-lived per-box credential, so keep it owner-only.
func saveState(path string, st *agentState) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}
