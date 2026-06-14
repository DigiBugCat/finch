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
// us which appliance/machine we are; we then hold the relay WebSocket open and
// reconnect with backoff, sending WS-protocol pings for NAT keepalive (the hub
// auto-pongs them without waking the Durable Object, so they're free).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const agentVersion = "1.4.0"

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
	OK          bool   `json:"ok"`
	Tenant      string `json:"tenant"`
	Appliance   string `json:"appliance"`
	Machine     string `json:"machine"`
	ConnectURL  string `json:"connectUrl"`
	FleetSecret string `json:"fleetSecret"`
	Error       string `json:"error"`
}

func main() {
	hostName, _ := os.Hostname()
	hub := flag.String("hub", "https://finchmcp.com", "finch hub base URL (http[s]://…)")
	ticket := flag.String("ticket", "", "one-shot enrollment ticket from the dashboard (required)")
	machine := flag.String("machine", hostName, "this box's name")
	upstream := flag.String("upstream", "http://127.0.0.1:8000", "local MCP server base URL")
	flag.Parse()

	if *ticket == "" {
		log.Fatal("finch: --ticket is required (mint one in the dashboard → Add device)")
	}

	jr, err := join(*hub, *ticket, *machine)
	if err != nil {
		log.Fatalf("finch: join failed: %v", err)
	}
	log.Printf("finch: joined as appliance=%q machine=%q (tenant %s)", jr.Appliance, jr.Machine, jr.Tenant)

	// Build the relay WS URL from the hub base + appliance/machine, so the
	// scheme/host always match the hub we were given (the hub's connectUrl may
	// assume prod wss://finchmcp.com which is wrong for local dev).
	wsURL := relayURL(*hub, jr.Appliance, jr.Machine)

	backoff := time.Second
	for {
		err := serve(wsURL, *upstream)
		if err != nil {
			log.Printf("finch: link down: %v (reconnecting in %s)", err, backoff)
			time.Sleep(backoff)
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
	}
}

// join claims a machine slot with the ticket and returns the hub's assignment.
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
	return &jr, nil
}

// relayURL builds ws(s)://<host>/<appliance>/<machine>/_connect from the hub base.
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
func serve(wsURL, upstream string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return err
	}
	defer c.Close(websocket.StatusNormalClosure, "bye")
	c.SetReadLimit(32 << 20) // 32 MiB frames
	log.Printf("finch: relay open %s -> %s", wsURL, upstream)

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

	// NAT keepalive — hub auto-pongs without waking the Durable Object.
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
				_ = c.Ping(pctx)
				pcancel()
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

// forward replays one hub request against the local MCP server.
func forward(ctx context.Context, upstream string, f frame) frame {
	out := frame{ID: f.ID, Type: "res"}
	req, err := http.NewRequestWithContext(ctx, f.Method, strings.TrimRight(upstream, "/")+f.Path, bytes.NewReader([]byte(f.Body)))
	if err != nil {
		out.Status, out.Body = 502, err.Error()
		return out
	}
	for k, v := range f.Headers {
		switch strings.ToLower(k) {
		case "host", "connection", "upgrade", "content-length", "transfer-encoding":
			// hop-by-hop / recomputed — skip
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
	out.Headers = map[string]string{"content-type": resp.Header.Get("content-type")}
	return out
}
