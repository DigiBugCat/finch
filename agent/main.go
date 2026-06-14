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
// Reconnect model: the enrollment ticket is one-shot (the dashboard consumes it
// on first /join), but the connect-token lives only ~120s. So we do NOT re-/join
// on every blip — we keep reconnecting with the SAME still-valid connect-token,
// and only re-/join (re-using the original ticket while it remains within its own
// TTL) once the connect-token has expired.
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
	"runtime"
	"strings"
	"sync"
	"time"

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

type frame struct {
	ID      string            `json:"id"`
	Type    string            `json:"type"` // "req" (hub->agent) | "res" (agent->hub)
	Method  string            `json:"method,omitempty"`
	Path    string            `json:"path,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
	Status  int               `json:"status,omitempty"`
}

type joinResp struct {
	OK        bool   `json:"ok"`
	Tenant    string `json:"tenant"`
	Appliance string `json:"appliance"`
	Machine   string `json:"machine"`
	// Short-lived (~120s) per-machine HMAC grant. We present it on the _connect
	// dial as ?ct=<connectToken>; the hub verifies it BEFORE accepting the relay
	// socket. (FLEET_SECRET is gone — this token is the whole proof.)
	ConnectToken string `json:"connectToken"`
	Error        string `json:"error"`
}

func main() {
	hostName, _ := os.Hostname()
	hub := flag.String("hub", "https://finchmcp.com", "finch hub base URL (http[s]://…)")
	ticket := flag.String("ticket", "", "one-shot enrollment ticket from the dashboard (required)")
	machine := flag.String("machine", hostName, "this box's name")
	upstream := flag.String("upstream", "http://127.0.0.1:8000", "local MCP server base URL")

	// The dashboard/install one-liner is `finch join --hub … --ticket …`, but
	// flag.Parse stops at the first non-flag arg (`join`), so --ticket would
	// never be read. Strip a leading `join` subcommand so both `finch join …`
	// and bare `finch …` work.
	if len(os.Args) > 1 && os.Args[1] == "join" {
		os.Args = append(os.Args[:1], os.Args[2:]...)
	}
	flag.Parse()

	if *ticket == "" {
		log.Fatal("finch: --ticket is required (mint one in the dashboard → Add device)")
	}

	// Confine forwarded requests to the configured upstream: parse it once so
	// forward() can reject any path that would escape the base (SSRF guard).
	upstreamURL, err := url.Parse(strings.TrimRight(*upstream, "/"))
	if err != nil || upstreamURL.Scheme == "" || upstreamURL.Host == "" {
		log.Fatalf("finch: --upstream %q is not a valid absolute URL", *upstream)
	}

	// First join: claims the slot and yields the assignment + connect-token.
	jr, err := join(*hub, *ticket, *machine)
	if err != nil {
		log.Fatalf("finch: join failed: %v", err)
	}
	log.Printf("finch: joined as appliance=%q machine=%q (tenant %s)", jr.Appliance, jr.Machine, jr.Tenant)

	// Build the relay WS URL from the hub base + appliance/machine, so the
	// scheme/host always match the hub we were given (the hub's connectUrl may
	// assume prod wss://finchmcp.com which is wrong for local dev).
	wsBase := relayURL(*hub, jr.Appliance, jr.Machine)

	connectToken := jr.ConnectToken
	connectExp := tokenExp(connectToken)

	// Exponential backoff (capped at 30s) shared by the re-join and reconnect
	// paths below. Sleeps the current delay, then doubles it for next time.
	backoff := time.Second
	backoffSleep := func() {
		time.Sleep(backoff)
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
	for {
		// Refresh the connect-token if it has (nearly) expired. The dashboard
		// ticket is one-shot, but re-/join with the SAME ticket succeeds while
		// the ticket itself is within its (longer) TTL — that's how steady-state
		// reconnection survives past the 120s connect-token lifetime.
		if time.Now().Add(connectSkew).After(connectExp) {
			fresh, err := join(*hub, *ticket, *machine)
			if err != nil {
				log.Printf("finch: re-join failed: %v (retrying in %s)", err, backoff)
				backoffSleep()
				continue
			}
			connectToken = fresh.ConnectToken
			connectExp = tokenExp(connectToken)
			// The hub may have re-pinned the appliance/machine; rebuild the URL.
			wsBase = relayURL(*hub, fresh.Appliance, fresh.Machine)
			log.Printf("finch: refreshed connect-token (valid until %s)", connectExp.Format(time.RFC3339))
		}

		wsURL := wsBase + "?ct=" + url.QueryEscape(connectToken)
		start := time.Now()
		err := serve(wsURL, upstreamURL)
		if err != nil {
			log.Printf("finch: link down: %v (reconnecting in %s)", err, backoff)
			backoffSleep()
			continue
		}
		// A clean session: only reset backoff if the link actually held for a
		// while (a session that drops instantly shouldn't reset the ramp).
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

	// One writer at a time: coder/websocket forbids concurrent writes.
	var wmu sync.Mutex
	write := func(f frame) {
		data, _ := json.Marshal(f)
		wmu.Lock()
		defer wmu.Unlock()
		wctx, wcancel := context.WithTimeout(ctx, 30*time.Second)
		defer wcancel()
		if err := c.Write(wctx, websocket.MessageText, data); err != nil {
			log.Printf("finch: write %s: %v", f.ID, err)
		}
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

	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return err
		}
		var f frame
		if json.Unmarshal(data, &f) != nil || f.Type != "req" {
			continue
		}
		go write(forward(ctx, upstream, f))
	}
}

// forward replays one hub request against the local MCP server. The hub-supplied
// path is sanitized (path.Clean + scheme/host-injection reject + base
// confinement) so a malicious or buggy path can never escape --upstream — the
// relay is otherwise an SSRF foothold into the box's loopback.
func forward(ctx context.Context, upstream *url.URL, f frame) frame {
	out := frame{ID: f.ID, Type: "res"}

	target, err := resolveUpstream(upstream, f.Path)
	if err != nil {
		out.Status, out.Body = 403, err.Error()
		return out
	}

	// Bound the upstream call below the hub's relay timeout so a hung local
	// server can't pin a goroutine indefinitely; still cancels on link drop
	// since it's a child of the relay ctx.
	reqCtx, cancel := context.WithTimeout(ctx, 28*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, f.Method, target, strings.NewReader(f.Body))
	if err != nil {
		out.Status, out.Body = 502, err.Error()
		return out
	}
	for k, v := range f.Headers {
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
		out.Status, out.Body = 502, err.Error()
		return out
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	out.Status = resp.StatusCode
	out.Body = string(b)
	// Forward the FULL upstream header set (minus hop-by-hop / recomputed) so
	// stateful MCP works end-to-end — collapsing to content-type stripped the
	// Mcp-Session-Id returned on `initialize`, which 4xx'd every follow-up call.
	// The hub re-emits these (also minus hop-by-hop) onto the client response.
	out.Headers = map[string]string{}
	for k, vs := range resp.Header {
		switch strings.ToLower(k) {
		case "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "content-encoding":
			// hop-by-hop / recomputed — never forward.
		default:
			if len(vs) > 0 {
				out.Headers[k] = vs[0]
			}
		}
	}
	return out
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
