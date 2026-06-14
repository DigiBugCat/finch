// finch agent — runs on the appliance (mac mini, pi, laptop). It dials OUT to
// the finch hub over a single WebSocket (works behind any NAT, no inbound
// ports), then relays each request the hub sends down to the local MCP server
// and ships the response back up the same socket.
//
// Usage:
//
//	finch connect --id garage-printer --upstream http://127.0.0.1:8000
//
// The hub default is wss://finchmcp.com. Reconnects with backoff on drop;
// sends WS-protocol pings for NAT keepalive (the hub auto-pongs them without
// waking the Durable Object, so they're free).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type frame struct {
	ID      string            `json:"id"`
	Type    string            `json:"type"` // "req" (hub->agent) | "res" (agent->hub)
	Method  string            `json:"method,omitempty"`
	Path    string            `json:"path,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
	Status  int               `json:"status,omitempty"`
}

func main() {
	hub := flag.String("hub", "wss://finchmcp.com", "finch hub base URL (wss://...)")
	id := flag.String("id", "", "appliance id (required)")
	upstream := flag.String("upstream", "http://127.0.0.1:8000", "local MCP server base URL")
	flag.Parse()

	if *id == "" {
		log.Fatal("finch: --id is required")
	}

	backoff := time.Second
	for {
		err := serve(*hub, *id, *upstream)
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

// serve holds one connection for its lifetime; returns on disconnect.
func serve(hub, id, upstream string) error {
	url := strings.TrimRight(hub, "/") + "/" + id + "/_connect"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return err
	}
	defer c.Close(websocket.StatusNormalClosure, "bye")
	c.SetReadLimit(32 << 20) // 32 MiB frames
	log.Printf("finch: connected to %s as %q -> %s", hub, id, upstream)

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
