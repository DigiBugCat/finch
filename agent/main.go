// finch agent — runs on the appliance (Mac mini, Pi, laptop). It claims a
// machine slot with a one-shot enrollment ticket, then dials OUT to the finch
// hub over a single WebSocket (works behind any NAT, no inbound ports) and
// relays each request the hub sends down to the local MCP server.
//
// Usage:
//
//	finch join --hub http://localhost:8787 --ticket <tkt> --upstream http://127.0.0.1:8000
//
// The ticket is minted in the dashboard ("Add device"). On join the hub tells
// us which appliance/machine we are AND hands us a short-lived per-machine
// connect-token; we present that token on the relay dial (?ct=<token>) — it is
// the sole proof that authenticates this box-side channel. We then hold the
// relay WebSocket open, reconnect with backoff, and send WS-protocol pings for
// NAT keepalive (the hub auto-pongs them without waking the Durable Object, so
// they're free).
//
// Reconnect model: the enrollment ticket is ONE-SHOT — the hub burns it on the
// first /join and 409s any replay. So /join also hands us a long-lived (~30d)
// per-machine REFRESH token. While the still-valid connect-token holds we just
// reconnect with it; once it nears expiry we trade the refresh token at /refresh
// for a fresh connect-token. The one-shot join ticket is never re-used.
//
// We persist that refresh token to --state (0600), so a restart/reboot resumes
// straight from it without a new dashboard ticket — "authenticate once", like
// ngrok. --ticket is only needed on first enroll (or if the credential was
// revoked).
package main

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

	"github.com/BurntSushi/toml"
	"github.com/coder/websocket"
)

// agentVersion is the canonical default. Release builds may stamp it via
// `-ldflags "-X main.agentVersion=<v>"`; the literal here is the source of
// truth that CI (scripts/check-versions.mjs) asserts matches the worker's
// LATEST_AGENT and the web dashboard constant. Keep all three in sync.
var agentVersion = "1.4.0"

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
	OK        bool   `json:"ok"`
	Tenant    string `json:"tenant"`
	Appliance string `json:"appliance"`
	Machine   string `json:"machine"`
	Host      string `json:"host"` // public host, e.g. <slug>.finchmcp.com
	URL       string `json:"url"`  // public MCP endpoint for this appliance
	// Short-lived (~120s) per-machine HMAC grant. We present it on the _connect
	// dial as ?ct=<connectToken>; the hub verifies it BEFORE accepting the relay
	// socket. (FLEET_SECRET is gone — this token is the whole proof.)
	ConnectToken string `json:"connectToken"`
	// Long-lived (~30d) per-machine credential, returned only by /join. We keep
	// it and present it at /refresh to mint fresh connect-tokens, so we never
	// re-use the one-shot enrollment ticket. Empty on a /refresh response.
	RefreshToken string `json:"refreshToken"`
	Error        string `json:"error"`
}

func main() {
	// Setup subcommands (cloudflared-style): `finch login` saves a CLI token,
	// `finch add` enrolls an appliance + appends an [[ingress]] rule. These run
	// and exit; `join`/`run`/bare fall through to the relay agent below.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "login":
			cmdLogin(os.Args[2:])
			return
		case "add":
			cmdAdd(os.Args[2:])
			return
		}
	}

	hostName, _ := os.Hostname()
	hub := flag.String("hub", "https://finchmcp.com", "finch hub base URL (http[s]://…)")
	ticket := flag.String("ticket", "", "one-shot enrollment ticket from the dashboard (first run only; later runs resume from --state)")
	machine := flag.String("machine", hostName, "this box's name")
	upstream := flag.String("upstream", "http://127.0.0.1:8000", "local MCP server base URL")
	statePath := flag.String("state", defaultStatePath(), "file that persists the per-machine refresh credential so a restart needs no new ticket")
	configPath := flag.String("config", "", "path to a finch.toml manifest; serves every [[ingress]] rule (one local service per appliance) over one process")

	// The install one-liners are `finch join …` (single service) and `finch run`
	// (read finch.toml). flag.Parse stops at the first non-flag arg, so strip a
	// leading subcommand — both `finch join …`/`finch run` and bare `finch …` work.
	if len(os.Args) > 1 && (os.Args[1] == "join" || os.Args[1] == "run") {
		os.Args = append(os.Args[:1], os.Args[2:]...)
	}
	flag.Parse()

	// Config-driven (cloudflared-style) when --config is given, or a finch.toml
	// sits in the working dir and no single-service flags were overridden.
	cfgPath := *configPath
	if cfgPath == "" && *ticket == "" {
		if _, err := os.Stat("finch.toml"); err == nil {
			cfgPath = "finch.toml"
		}
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
	runAppliance(*hub, *machine, *ticket, *statePath, upstreamURL, "", "")
}

// runConfig serves every [[ingress]] rule from a finch.toml — one relay loop per
// appliance, concurrently, over a single process (the cloudflared model). Each
// rule maps a public path (<slug>.finchmcp.com/<path>/mcp) to a local service.
// A rule with a bad service or a fatal enroll error is logged and skipped; its
// siblings keep running.
func runConfig(cfg *config) {
	if len(cfg.Ingress) == 0 {
		log.Fatal("finch: finch.toml has no [[ingress]] rules — nothing to serve")
	}
	var wg sync.WaitGroup
	started := 0
	for _, ing := range cfg.Ingress {
		up, err := url.Parse(strings.TrimRight(ing.Service, "/"))
		if err != nil || up.Scheme == "" || up.Host == "" {
			log.Printf("finch[%s]: service %q is not a valid absolute URL — skipping", ing.Path, ing.Service)
			continue
		}
		statePath := cfg.statePathFor(ing.Path)
		started++
		wg.Add(1)
		go func(ing ingress, up *url.URL, sp string) {
			defer wg.Done()
			runAppliance(cfg.Hub, cfg.Machine, ing.Ticket, sp, up, ing.Path, ing.Name)
		}(ing, up, statePath)
	}
	if started == 0 {
		log.Fatal("finch: no valid [[ingress]] rules to serve")
	}
	log.Printf("finch: serving %d ingress rule(s) from finch.toml as machine %q", started, cfg.Machine)
	wg.Wait()
}

// runAppliance resumes-or-enrolls one appliance, then holds its relay open and
// reconnects forever. `label` prefixes logs (the ingress path in config mode,
// empty in single-service mode). Fatal enroll errors return so a sibling rule
// in config mode survives; in single-service mode main() has nothing else to do.
func runAppliance(hub, machine, ticket, statePath string, upstreamURL *url.URL, label, appName string) {
	lp := "finch"
	if label != "" {
		lp = "finch[" + label + "]"
	}

	// Resume-or-enroll. A saved refresh credential for THIS hub skips the one-shot
	// ticket; only first run (or a revoked/stale credential) falls back to it.
	var jr *joinResp
	refreshToken := ""
	if saved, _ := loadState(statePath); saved != nil && saved.RefreshToken != "" && saved.Hub == hub {
		if r, rerr := refresh(hub, saved.RefreshToken); rerr == nil {
			jr = r
			refreshToken = saved.RefreshToken
			log.Printf("%s: resumed from saved credential (%s)", lp, statePath)
		} else {
			log.Printf("%s: saved credential at %s unusable (%v) — falling back to a ticket", lp, statePath, rerr)
		}
	}
	if jr == nil {
		if ticket == "" {
			log.Printf("%s: no ticket and no saved credential — enroll this appliance in the dashboard and add its ticket (mint one in → Add device)", lp)
			return
		}
		r, jerr := join(hub, ticket, machine)
		if jerr != nil {
			log.Printf("%s: join failed: %v", lp, jerr)
			return
		}
		jr = r
		refreshToken = jr.RefreshToken
		if refreshToken != "" {
			st := &agentState{Hub: hub, Tenant: jr.Tenant, Appliance: jr.Appliance, Machine: jr.Machine, RefreshToken: refreshToken}
			if serr := saveState(statePath, st); serr != nil {
				log.Printf("%s: warning: could not persist credential to %s: %v", lp, statePath, serr)
			}
		}
	}
	// Describe the rule by its full name: the application, its public endpoint,
	// and the local service it fronts.
	name := appName
	if name == "" {
		name = jr.Appliance
	}
	endpoint := jr.URL
	if endpoint == "" { // older hub without host/url in the join response
		endpoint = relayURL(hub, jr.Appliance, jr.Machine)
	}
	log.Printf("%s: %q live at %s  →  %s  (machine %q, tenant %s)",
		lp, name, endpoint, upstreamURL, jr.Machine, jr.Tenant)

	// Build the relay WS URL from the hub base + appliance/machine so scheme/host
	// always match the hub we were given (the hub's connectUrl may assume prod).
	wsBase := relayURL(hub, jr.Appliance, jr.Machine)
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
			var fresh *joinResp
			var err error
			if refreshToken != "" {
				fresh, err = refresh(hub, refreshToken)
			} else {
				fresh, err = join(hub, ticket, machine)
			}
			if err != nil {
				log.Printf("%s: connect-token refresh failed: %v (retrying in %s)", lp, err, backoff)
				backoffSleep()
				continue
			}
			connectToken = fresh.ConnectToken
			connectExp = tokenExp(connectToken)
			wsBase = relayURL(hub, fresh.Appliance, fresh.Machine)
			log.Printf("%s: refreshed connect-token (valid until %s)", lp, connectExp.Format(time.RFC3339))
		}

		wsURL := wsBase + "?ct=" + url.QueryEscape(connectToken)
		start := time.Now()
		if err := serve(wsURL, upstreamURL); err != nil {
			log.Printf("%s: link down: %v (reconnecting in %s)", lp, err, backoff)
			backoffSleep()
			continue
		}
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
	}
}

// join claims a machine slot with the ticket and returns the hub's assignment
// (including the per-machine connect-token). Safe to call again on reconnect
// while the ticket remains within its own TTL.
func join(hub, ticket, machine string) (*joinResp, error) {
	body, _ := json.Marshal(map[string]string{
		"ticket":  ticket,
		"machine": machine,
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
	if !jr.OK || jr.Appliance == "" || jr.Machine == "" {
		return nil, fmt.Errorf("join rejected: %s", jr.Error)
	}
	if jr.ConnectToken == "" {
		return nil, fmt.Errorf("join response missing connectToken")
	}
	return &jr, nil
}

// refresh trades the long-lived per-machine refresh token for a fresh
// connect-token, without re-using the one-shot enrollment ticket. The hub
// rejects it (403) if the machine was removed from the dashboard, which is how
// revocation propagates to the box within a connect-token TTL.
func refresh(hub, refreshToken string) (*joinResp, error) {
	body, _ := json.Marshal(map[string]string{"refreshToken": refreshToken})
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
	if !jr.OK || jr.Appliance == "" || jr.Machine == "" || jr.ConnectToken == "" {
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

// relayURL builds ws(s)://<host>/<appliance>/<machine>/_connect from the hub
// base (without the query string — the caller appends ?ct=<token>).
func relayURL(hub, appliance, machine string) string {
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
	u.Path = "/" + appliance + "/" + machine + "/_connect"
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
func serve(wsURL string, upstream *url.URL) error {
	ctx, cancel := context.WithCancel(context.Background())
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
				forward(fctx, upstream, f, write, os)
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
// machine until head arrives); a failure AFTER head aborts the stream (the DO
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
func forward(ctx context.Context, upstream *url.URL, f frame, write func(frame) error, os *outStream) {
	target, err := resolveUpstream(upstream, f.Path)
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

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// Dial / connect failure — pre-head, so the DO maps it to a 502 and may
		// still fail over to another machine.
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
				// link drop). We're committed to this machine; abort the stream so
				// the DO errors its readable rather than seeing a clean end.
				write(frame{ID: f.ID, Type: "reset", Message: rerr.Error()})
			}
			return
		}
	}
}

// resolveUpstream turns the hub-supplied request path into an absolute upstream
// URL, refusing anything that would escape the configured --upstream base.
// Defenses, in order:
//   - reject scheme/authority injection (a path that itself parses to an
//     absolute URL, or starts with "//" → protocol-relative host).
//   - path.Clean to collapse "." / ".." segments, then confine the cleaned
//     path to the allowed route prefix so a "/mcp/../admin" can't climb out of
//     the MCP route the hub gated and SSRF something else on loopback.
//   - rebuild the URL from the trusted base host/scheme + the cleaned path +
//     the (query-only) raw query, so host/scheme can never come from the frame.
//
// The confinement prefix is the upstream's own base path when one is configured
// (e.g. --upstream http://127.0.0.1:8000/mcp), otherwise the canonical "/mcp"
// route the hub forwards. Either way the result must equal the prefix or be a
// child of it — collapsing "/mcp/../admin" to "/admin" is therefore rejected.
func resolveUpstream(base *url.URL, rawPath string) (string, error) {
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

	// Confine to the allowed prefix: the upstream's configured base path if any,
	// else the canonical "/mcp" route. The cleaned path must BE the prefix or a
	// child of it — this is what makes the hub's "/mcp"-only gate un-bypassable
	// by traversal (e.g. "/mcp/../admin" → "/admin" is rejected here).
	prefix := strings.TrimRight(base.Path, "/")
	if prefix == "" {
		prefix = "/mcp"
	}
	if clean != prefix && !strings.HasPrefix(clean, prefix+"/") {
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
// per-machine refresh token (and the assignment, for clarity).
// ---- finch.toml manifest (cloudflared-style ingress) -----------------------

// ingress is one rule: expose a local `service` as the appliance named `path`.
//
//	name    — human label for the application (e.g. "Label Printer"); logs only.
//	path    — the public URL segment AND the appliance enrolled in the dashboard.
//	          Full endpoint: https://<your-slug>.finchmcp.com/<path>/mcp
//	service — the local server to forward to (e.g. http://127.0.0.1:8000).
//	ticket  — one-shot enrollment ticket, first run only (then state resumes).
type ingress struct {
	Name    string `toml:"name"`
	Path    string `toml:"path"`
	Service string `toml:"service"`
	Ticket  string `toml:"ticket"`
}

// config is a parsed finch.toml. `state` is a DIRECTORY in config mode — each
// appliance's refresh credential is persisted at <state>/<path>.json, so one box
// can front many appliances without their credentials colliding.
type config struct {
	Hub     string    `toml:"hub"`
	Machine string    `toml:"machine"`
	State   string    `toml:"state"`
	Ingress []ingress `toml:"ingress"`
}

// loadConfig reads + validates a finch.toml, applying defaults (prod hub, this
// box's hostname, ~/.finch state dir).
func loadConfig(path, hostName string) (*config, error) {
	var c config
	if _, err := toml.DecodeFile(path, &c); err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	if c.Hub == "" {
		c.Hub = "https://finchmcp.com"
	}
	if c.Machine == "" {
		c.Machine = hostName
	}
	if c.State == "" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			c.State = filepath.Join(home, ".finch")
		} else {
			c.State = ".finch"
		}
	}
	c.State = expandHome(c.State)
	seen := map[string]bool{}
	for i, ing := range c.Ingress {
		if ing.Path == "" || ing.Service == "" {
			return nil, fmt.Errorf("[[ingress]] #%d: both `path` and `service` are required", i+1)
		}
		if strings.ContainsAny(ing.Path, "/ ") {
			return nil, fmt.Errorf("[[ingress]] path %q must be a single URL segment (no slashes or spaces)", ing.Path)
		}
		if seen[ing.Path] {
			return nil, fmt.Errorf("[[ingress]] path %q is listed twice", ing.Path)
		}
		seen[ing.Path] = true
	}
	return &c, nil
}

// statePathFor is where appliance `path`'s refresh credential lives: a per-rule
// file under the state dir, so concurrent ingress rules never clobber each other.
func (c *config) statePathFor(path string) string {
	return filepath.Join(c.State, path+".json")
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
	Appliance    string `json:"appliance"`
	Machine      string `json:"machine"`
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
// long-lived per-machine credential, so keep it owner-only.
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
