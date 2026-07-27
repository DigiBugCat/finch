package core

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// worstCaseReqFrame builds the largest `req` frame the Worker can legitimately
// produce: a body at exactly MAX_RELAY_BODY_BYTES made entirely of NUL bytes.
// NUL is valid UTF-8 (so the DO's TextDecoder(fatal:true) accepts it) and has no
// short JSON escape, so JSON.stringify — and encoding/json, identically — emits
// the six-byte backslash-u0000 form per input byte. That 6x is the worst
// expansion any single input byte can reach.
func worstCaseReqFrame() frame {
	return frame{
		ID:     "00000000-0000-4000-8000-000000000000",
		Type:   "req",
		Method: "POST",
		Path:   "/mcp",
		ReqHeaders: map[string]string{
			"content-type": "application/json",
			"accept":       "application/json, text/event-stream",
		},
		Assertion: strings.Repeat("a", 2048), // signed caller JWS, order-of-magnitude
		Body:      strings.Repeat("\x00", maxRelayBodyBytes),
	}
}

// TestMaxRelayFrameBytesCoversWorstCaseSerializedBody pins the read limit to the
// derivation in the constant's comment. It FAILS if anyone tidies the limit back
// down (the pre-fix 8 MiB value cuts off at 1.33 MiB of control bytes, and a
// tripped read limit kills the socket and every concurrent stream on the box).
func TestMaxRelayFrameBytesCoversWorstCaseSerializedBody(t *testing.T) {
	if maxRelayFrameBytes < 6*maxRelayBodyBytes {
		t.Fatalf("read limit %d is below the 6x JSON-escape worst case %d for a permitted %d-byte body",
			maxRelayFrameBytes, 6*maxRelayBodyBytes, maxRelayBodyBytes)
	}
	wire, err := json.Marshal(worstCaseReqFrame())
	if err != nil {
		t.Fatalf("marshal worst-case frame: %v", err)
	}
	if len(wire) <= 6*maxRelayBodyBytes {
		t.Fatalf("worst-case frame serialized to %d bytes, expected > %d — the 6x escape assumption no longer holds",
			len(wire), 6*maxRelayBodyBytes)
	}
	if len(wire) > maxRelayFrameBytes {
		t.Fatalf("a body the Worker permits (%d bytes) serializes to %d bytes, over the %d-byte read limit",
			maxRelayBodyBytes, len(wire), maxRelayFrameBytes)
	}
}

// TestRelayReadLimitAcceptsWorstCaseFrame is the same claim against the real
// transport: coder/websocket enforces SetReadLimit by closing the connection
// with StatusMessageTooBig, so a limit sized below the worst case turns a
// permitted request into a link-wide outage rather than a per-request error.
func TestRelayReadLimitAcceptsWorstCaseFrame(t *testing.T) {
	wire, err := json.Marshal(worstCaseReqFrame())
	if err != nil {
		t.Fatalf("marshal worst-case frame: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "done")
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = c.Write(ctx, websocket.MessageText, wire)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "bye")
	c.SetReadLimit(maxRelayFrameBytes) // exactly as serveWithRoutesStatus does

	_, got, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read limit rejected a frame the Worker is allowed to send: %v", err)
	}
	if len(got) != len(wire) {
		t.Fatalf("read %d bytes, sent %d", len(got), len(wire))
	}
	var f frame
	if err := json.Unmarshal(got, &f); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(f.Body) != maxRelayBodyBytes {
		t.Fatalf("body round-tripped as %d bytes, want %d", len(f.Body), maxRelayBodyBytes)
	}
}
