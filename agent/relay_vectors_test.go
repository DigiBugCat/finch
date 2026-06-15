package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"
)

// vectorsPath points at the SHARED golden-vectors fixture. Both this Go codec
// test and the TS worker test load the SAME file and must agree byte-for-byte on
// the wire shapes — that is the whole point of a single fixture.
func vectorsPath(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("..", "worker", "test", "relay-vectors.json"))
	if err != nil {
		t.Fatalf("abs vectors path: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("shared golden vectors not found at %s: %v", p, err)
	}
	return p
}

type vectorsFile struct {
	Frames map[string]struct {
		Wire json.RawMessage `json:"wire"`
	} `json:"frames"`
}

func loadVectors(t *testing.T) vectorsFile {
	t.Helper()
	b, err := os.ReadFile(vectorsPath(t))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectorsFile
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return v
}

func wireFor(t *testing.T, v vectorsFile, name string) json.RawMessage {
	t.Helper()
	fr, ok := v.Frames[name]
	if !ok {
		t.Fatalf("vector %q missing from fixture", name)
	}
	return fr.Wire
}

// TestVectors_CodecRoundTrip unmarshals each golden wire frame into the agent's
// frame struct, then re-marshals it, and asserts the re-marshaled JSON decodes
// back to the SAME canonical object as the original wire (NOT a raw-string
// compare — JSON object key order is free). This proves the agent's codec agrees
// with the shared contract on every frame type.
func TestVectors_CodecRoundTrip(t *testing.T) {
	v := loadVectors(t)
	for _, name := range []string{"req", "head", "chunk_hello", "chunk_world", "end", "err", "reset", "reset_no_message"} {
		name := name
		t.Run(name, func(t *testing.T) {
			wire := wireFor(t, v, name)

			var f frame
			if err := json.Unmarshal(wire, &f); err != nil {
				t.Fatalf("unmarshal %s: %v", name, err)
			}
			remarshaled, err := json.Marshal(f)
			if err != nil {
				t.Fatalf("remarshal %s: %v", name, err)
			}

			// Canonical compare: decode both to generic maps (key order, and the
			// absence of omitempty fields, both matter) and deep-equal them.
			var want, got map[string]any
			if err := json.Unmarshal(wire, &want); err != nil {
				t.Fatalf("decode want %s: %v", name, err)
			}
			if err := json.Unmarshal(remarshaled, &got); err != nil {
				t.Fatalf("decode got %s: %v", name, err)
			}
			if !reflect.DeepEqual(want, got) {
				t.Errorf("%s round-trip mismatch:\n want %s\n  got %s", name, wire, remarshaled)
			}
		})
	}
}

// TestVectors_HeadHeadersOrdered asserts the `head` frame decodes to an ORDERED
// [][2]string list that PRESERVES both set-cookie entries in order — the property
// that makes multi-cookie responses survive the relay.
func TestVectors_HeadHeadersOrdered(t *testing.T) {
	v := loadVectors(t)
	var f frame
	if err := json.Unmarshal(wireFor(t, v, "head"), &f); err != nil {
		t.Fatalf("unmarshal head: %v", err)
	}
	if f.Type != "head" || f.Status != 200 {
		t.Fatalf("head decoded wrong: type=%q status=%d", f.Type, f.Status)
	}
	want := []headerPair{
		{"content-type", "text/event-stream"},
		{"mcp-session-id", "sess-abc"},
		{"set-cookie", "a=1; Path=/"},
		{"set-cookie", "b=2; Path=/"},
	}
	if !reflect.DeepEqual(f.HeadHeaders, want) {
		t.Errorf("head.headers = %v, want %v (ordered, dupes preserved)", f.HeadHeaders, want)
	}
	// The request-side map must be nil for a head frame (different shape).
	if f.ReqHeaders != nil {
		t.Errorf("head frame should not populate ReqHeaders, got %v", f.ReqHeaders)
	}
}

// TestVectors_ReqHeadersMap asserts the `req` frame decodes its headers into the
// name->value map (the request side stays a map, matching the DO's
// Object.fromEntries(req.headers)).
func TestVectors_ReqHeadersMap(t *testing.T) {
	v := loadVectors(t)
	var f frame
	if err := json.Unmarshal(wireFor(t, v, "req"), &f); err != nil {
		t.Fatalf("unmarshal req: %v", err)
	}
	if f.Type != "req" || f.Method != "POST" || f.Path != "/mcp" {
		t.Fatalf("req decoded wrong: %+v", f)
	}
	wantHdr := map[string]string{"content-type": "application/json", "mcp-session-id": "sess-abc"}
	if !reflect.DeepEqual(f.ReqHeaders, wantHdr) {
		t.Errorf("req.headers = %v, want %v", f.ReqHeaders, wantHdr)
	}
	if f.HeadHeaders != nil {
		t.Errorf("req frame should not populate HeadHeaders, got %v", f.HeadHeaders)
	}
}

// TestVectors_ChunkBase64 asserts the two chunk frames decode, base64.Std-decode,
// and CONCATENATE to exactly "hello world" — proving the agent agrees with the
// contract's std-padded base64 (NOT RawURLEncoding).
func TestVectors_ChunkBase64(t *testing.T) {
	v := loadVectors(t)
	var got []byte
	for _, name := range []string{"chunk_hello", "chunk_world"} {
		var f frame
		if err := json.Unmarshal(wireFor(t, v, name), &f); err != nil {
			t.Fatalf("unmarshal %s: %v", name, err)
		}
		if f.Type != "chunk" {
			t.Fatalf("%s type = %q, want chunk", name, f.Type)
		}
		dec, err := base64.StdEncoding.DecodeString(f.Data)
		if err != nil {
			t.Fatalf("base64 std decode %s (%q): %v", name, f.Data, err)
		}
		got = append(got, dec...)
	}
	if string(got) != "hello world" {
		t.Errorf("chunk_hello+chunk_world = %q, want %q", got, "hello world")
	}
}

// TestVectors_ResetOmitsEmptyMessage asserts a reset with an empty Message
// marshals WITHOUT a `message` key (omitempty), matching reset_no_message's wire.
func TestVectors_ResetOmitsEmptyMessage(t *testing.T) {
	v := loadVectors(t)

	// reset_no_message must NOT have a message key on the wire.
	var m map[string]any
	if err := json.Unmarshal(wireFor(t, v, "reset_no_message"), &m); err != nil {
		t.Fatalf("decode reset_no_message: %v", err)
	}
	if _, ok := m["message"]; ok {
		t.Fatalf("fixture reset_no_message unexpectedly carries a message key: %v", m)
	}

	// Our own marshal of an empty-message reset must match it exactly.
	out, err := json.Marshal(frame{ID: m["id"].(string), Type: "reset"})
	if err != nil {
		t.Fatalf("marshal reset: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("decode our reset: %v", err)
	}
	if _, ok := got["message"]; ok {
		t.Errorf("empty-message reset serialized WITH a message key: %s", out)
	}
	if !reflect.DeepEqual(got, m) {
		t.Errorf("reset_no_message round-trip mismatch:\n want %v\n  got %v", m, got)
	}

	// And a reset WITH a message keeps it.
	out2, _ := json.Marshal(frame{ID: "x", Type: "reset", Message: "idle timeout"})
	var got2 map[string]any
	_ = json.Unmarshal(out2, &got2)
	if got2["message"] != "idle timeout" {
		t.Errorf("non-empty reset dropped message: %s", out2)
	}
}

// collectingWriter captures the frames a forward() emits, in order, under a mutex
// (forward writes from one goroutine, but mirror the real single-writer model).
type collectingWriter struct {
	mu     sync.Mutex
	frames []frame
	failAt int // if >0, the Nth (1-based) write fails, simulating a dead DO link
	n      int
}

func (w *collectingWriter) write(f frame) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.n++
	if w.failAt > 0 && w.n >= w.failAt {
		return fmt.Errorf("simulated write failure at frame %d", w.n)
	}
	w.frames = append(w.frames, f)
	return nil
}

func (w *collectingWriter) snapshot() []frame {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]frame, len(w.frames))
	copy(out, w.frames)
	return out
}

// TestForward_HeadChunkEndSequence drives forward() against a real httptest
// server returning a multi-write (chunked/SSE-shaped) body and asserts the exact
// frame sequence: head (status + ordered, dupe-preserving, hop-by-hop-free
// headers) -> chunk* -> end, with the concatenated decoded chunks equal to the
// full body.
func TestForward_HeadChunkEndSequence(t *testing.T) {
	const body = "data: one\n\ndata: two\n\ndata: three\n\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Mcp-Session-Id", "sess-xyz")
		// Two Set-Cookie headers must both survive, in order.
		w.Header().Add("Set-Cookie", "a=1; Path=/")
		w.Header().Add("Set-Cookie", "b=2; Path=/")
		// A hop-by-hop header that must be STRIPPED.
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(200)
		fl, _ := w.(http.Flusher)
		// Flush in pieces so the agent does multiple body reads.
		for _, part := range []string{"data: one\n\n", "data: two\n\n", "data: three\n\n"} {
			io.WriteString(w, part)
			if fl != nil {
				fl.Flush()
			}
		}
	}))
	defer srv.Close()

	upstream := mustParse(t, srv.URL+"/mcp")
	cw := &collectingWriter{}
	forward(context.Background(), upstream, frame{
		ID: "fwd-1", Type: "req", Method: "GET", Path: "/mcp",
		ReqHeaders: map[string]string{"accept": "text/event-stream", "authorization": "Bearer secret"},
	}, cw.write)

	frames := cw.snapshot()
	if len(frames) < 3 {
		t.Fatalf("expected at least head+chunk+end, got %d frames: %+v", len(frames), frames)
	}

	// First frame: head.
	head := frames[0]
	if head.ID != "fwd-1" || head.Type != "head" || head.Status != 200 {
		t.Fatalf("first frame not a 200 head: %+v", head)
	}
	// Headers: lowercased, ordered, dupes preserved, hop-by-hop absent.
	hm := map[string][]string{}
	for _, hp := range head.HeadHeaders {
		if hp[0] != toLowerASCII(hp[0]) {
			t.Errorf("head header name not lowercased: %q", hp[0])
		}
		if hp[0] == "connection" || hp[0] == "content-length" {
			t.Errorf("hop-by-hop header leaked into head: %q", hp[0])
		}
		hm[hp[0]] = append(hm[hp[0]], hp[1])
	}
	if got := hm["content-type"]; len(got) != 1 || got[0] != "text/event-stream" {
		t.Errorf("content-type = %v, want [text/event-stream]", got)
	}
	if got := hm["set-cookie"]; !reflect.DeepEqual(got, []string{"a=1; Path=/", "b=2; Path=/"}) {
		t.Errorf("set-cookie = %v, want both cookies in order", got)
	}

	// Last frame: end.
	last := frames[len(frames)-1]
	if last.Type != "end" || last.ID != "fwd-1" {
		t.Fatalf("last frame not an end: %+v", last)
	}

	// Middle frames: chunks; decode + concat must equal the body.
	var assembled []byte
	for _, f := range frames[1 : len(frames)-1] {
		if f.Type != "chunk" {
			t.Fatalf("expected chunk between head and end, got %+v", f)
		}
		dec, err := base64.StdEncoding.DecodeString(f.Data)
		if err != nil {
			t.Fatalf("decode chunk %q: %v", f.Data, err)
		}
		assembled = append(assembled, dec...)
	}
	if string(assembled) != body {
		t.Errorf("assembled body = %q, want %q", assembled, body)
	}
}

// TestForward_PreHeadDialFail asserts a dial failure (no server) produces a
// single pre-head `err` frame with status 502 — the DO can still fail over.
func TestForward_PreHeadDialFail(t *testing.T) {
	// Point at a port nothing is listening on.
	upstream := mustParse(t, "http://127.0.0.1:1/mcp")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cw := &collectingWriter{}
	forward(ctx, upstream, frame{ID: "fwd-2", Type: "req", Method: "POST", Path: "/mcp", Body: "{}"}, cw.write)

	frames := cw.snapshot()
	if len(frames) != 1 {
		t.Fatalf("dial fail should emit exactly one frame, got %d: %+v", len(frames), frames)
	}
	if frames[0].Type != "err" || frames[0].Status != 502 || frames[0].Message == "" {
		t.Errorf("dial-fail frame = %+v, want type=err status=502 with a message", frames[0])
	}
}

// TestForward_SSRFRejectPreHead asserts an SSRF-rejected path produces a pre-head
// `err` with status 403 and never touches the network.
func TestForward_SSRFRejectPreHead(t *testing.T) {
	upstream := mustParse(t, "http://127.0.0.1:8000")
	cw := &collectingWriter{}
	forward(context.Background(), upstream, frame{ID: "fwd-3", Type: "req", Method: "GET", Path: "/admin"}, cw.write)

	frames := cw.snapshot()
	if len(frames) != 1 || frames[0].Type != "err" || frames[0].Status != 403 {
		t.Fatalf("SSRF reject should emit one 403 err, got %+v", frames)
	}
}

// TestForward_AuthorizationStripped asserts the authorization request header is
// dropped before hitting the upstream (defense-in-depth credential strip).
func TestForward_AuthorizationStripped(t *testing.T) {
	var sawAuth, sawHost string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		sawHost = r.Header.Get("X-Forwarded-Host-Marker")
		w.WriteHeader(204)
	}))
	defer srv.Close()

	upstream := mustParse(t, srv.URL+"/mcp")
	cw := &collectingWriter{}
	forward(context.Background(), upstream, frame{
		ID: "fwd-4", Type: "req", Method: "GET", Path: "/mcp",
		ReqHeaders: map[string]string{
			"authorization":           "Bearer leaked",
			"x-forwarded-host-marker": "kept",
			"content-length":          "999", // recomputed; must be dropped
		},
	}, cw.write)

	if sawAuth != "" {
		t.Errorf("authorization header leaked to upstream: %q", sawAuth)
	}
	if sawHost != "kept" {
		t.Errorf("non-hop-by-hop header should be forwarded, got %q", sawHost)
	}
	frames := cw.snapshot()
	if len(frames) < 2 || frames[0].Type != "head" || frames[0].Status != 204 {
		t.Fatalf("expected head(204)+end, got %+v", frames)
	}
}

// TestForward_WriteFailureAborts asserts that when the DO link dies mid-stream
// (write fails on the head), forward() stops and does NOT keep emitting chunks.
func TestForward_WriteFailureAborts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		io.WriteString(w, "body-bytes")
	}))
	defer srv.Close()

	upstream := mustParse(t, srv.URL+"/mcp")
	// Fail on the very first write (the head): forward must return immediately.
	cw := &collectingWriter{failAt: 1}
	forward(context.Background(), upstream, frame{ID: "fwd-5", Type: "req", Method: "GET", Path: "/mcp"}, cw.write)

	if got := cw.snapshot(); len(got) != 0 {
		t.Errorf("after head write failure, expected no captured frames, got %+v", got)
	}
}

// TestForward_StreamScript replays the fixture's streamScript end-to-end shape on
// the agent side: an httptest server emitting "hello" then " world" must produce
// head(200) -> chunk(hello) -> chunk(world)? -> end whose assembled body is
// exactly "hello world" (matching the DO integration expectation).
func TestForward_StreamScript(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl, _ := w.(http.Flusher)
		io.WriteString(w, "hello")
		if fl != nil {
			fl.Flush()
		}
		io.WriteString(w, " world")
		if fl != nil {
			fl.Flush()
		}
	}))
	defer srv.Close()

	upstream := mustParse(t, srv.URL+"/mcp")
	cw := &collectingWriter{}
	forward(context.Background(), upstream, frame{ID: "11111111-1111-4111-8111-111111111111", Type: "req", Method: "GET", Path: "/mcp"}, cw.write)

	frames := cw.snapshot()
	if frames[0].Type != "head" || frames[0].Status != 200 {
		t.Fatalf("first frame = %+v, want head 200", frames[0])
	}
	if frames[len(frames)-1].Type != "end" {
		t.Fatalf("last frame = %+v, want end", frames[len(frames)-1])
	}
	var assembled []byte
	for _, f := range frames[1 : len(frames)-1] {
		if f.Type != "chunk" {
			t.Fatalf("middle frame not chunk: %+v", f)
		}
		dec, _ := base64.StdEncoding.DecodeString(f.Data)
		assembled = append(assembled, dec...)
	}
	if string(assembled) != "hello world" {
		t.Errorf("streamScript assembled body = %q, want %q", assembled, "hello world")
	}
}

// toLowerASCII is a tiny helper to assert lowercasing without pulling strings in
// (keeps the test self-contained / readable).
func toLowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// sanity: ensure the fixture's hopByHop list matches the set forward() strips, so
// a drift in the contract is caught here rather than silently in production.
func TestVectors_HopByHopMatchesFixture(t *testing.T) {
	b, err := os.ReadFile(vectorsPath(t))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v struct {
		HopByHop []string `json:"hopByHop"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("parse hopByHop: %v", err)
	}
	want := []string{"connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "content-encoding"}
	sort.Strings(v.HopByHop)
	sort.Strings(want)
	if !reflect.DeepEqual(v.HopByHop, want) {
		t.Errorf("fixture hopByHop = %v, want %v (agent strips this exact set)", v.HopByHop, want)
	}
}
