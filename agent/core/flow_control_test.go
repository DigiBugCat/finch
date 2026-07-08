package core

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// intp is a tiny helper for a *int literal (window credits).
func intp(v int) *int { return &v }

// TestVectors_WindowFrame round-trips the shared `window` golden vectors through
// the agent's codec. The worker side OWNS these fixture entries; the agent only
// READS them and must agree on the wire shape (id, type:"window", credits)
// byte-for-byte. window_pause carries credits:0 (PAUSE), window_resume carries
// credits>0 (RESUME). If a vector is absent (the two sides landing independently)
// we skip that sub-case rather than fail.
func TestVectors_WindowFrame(t *testing.T) {
	v := loadVectors(t)
	cases := []struct {
		name        string
		wantCredits int
	}{
		{"window_pause", 0},
		{"window_resume", 1048576},
	}
	ran := 0
	for _, c := range cases {
		fr, ok := v.Frames[c.name]
		if !ok {
			t.Logf("vector %q not in fixture yet (worker side owns it) — skipping", c.name)
			continue
		}
		ran++
		t.Run(c.name, func(t *testing.T) {
			wire := fr.Wire
			var f frame
			if err := json.Unmarshal(wire, &f); err != nil {
				t.Fatalf("unmarshal %s: %v", c.name, err)
			}
			if f.Type != "window" {
				t.Fatalf("%s type = %q, want window", c.name, f.Type)
			}
			// credits decodes to a non-nil *int (credits:0 must survive as 0, NOT
			// be elided to nil — that is the whole point of the pointer field).
			if f.Credits == nil {
				t.Fatalf("%s decoded with nil credits (credits:%d expected)", c.name, c.wantCredits)
			}
			if *f.Credits != c.wantCredits {
				t.Errorf("%s credits = %d, want %d", c.name, *f.Credits, c.wantCredits)
			}

			// Canonical round-trip: re-marshal and deep-equal the decoded objects
			// (JSON key order is free), matching the other codec tests.
			remarshaled, err := json.Marshal(f)
			if err != nil {
				t.Fatalf("remarshal %s: %v", c.name, err)
			}
			var want, got map[string]any
			if err := json.Unmarshal(wire, &want); err != nil {
				t.Fatalf("decode want %s: %v", c.name, err)
			}
			if err := json.Unmarshal(remarshaled, &got); err != nil {
				t.Fatalf("decode got %s: %v", c.name, err)
			}
			if !reflect.DeepEqual(want, got) {
				t.Errorf("%s round-trip mismatch:\n want %s\n  got %s", c.name, wire, remarshaled)
			}
		})
	}
	if ran == 0 {
		t.Skip("no window vectors in the shared fixture yet (worker side owns them)")
	}
}

// TestWindowFrame_CreditsDecode pins the agent's interpretation of the credits
// field independent of the shared fixture: credits:0 decodes to a non-nil zero
// (PAUSE), credits>0 to a positive (RESUME), and an absent credits to nil (which
// the read loop fails closed on). A *int (not int) is what makes credits:0
// distinguishable from "no credits field".
func TestWindowFrame_CreditsDecode(t *testing.T) {
	cases := []struct {
		wire    string
		wantNil bool
		wantVal int
	}{
		{`{"id":"x","type":"window","credits":0}`, false, 0},
		{`{"id":"x","type":"window","credits":1048576}`, false, 1048576},
		{`{"id":"x","type":"window"}`, true, 0}, // absent -> nil
	}
	for _, c := range cases {
		var f frame
		if err := json.Unmarshal([]byte(c.wire), &f); err != nil {
			t.Fatalf("unmarshal %s: %v", c.wire, err)
		}
		if c.wantNil {
			if f.Credits != nil {
				t.Errorf("%s: credits = %v, want nil", c.wire, *f.Credits)
			}
			continue
		}
		if f.Credits == nil {
			t.Fatalf("%s: credits = nil, want %d", c.wire, c.wantVal)
		}
		if *f.Credits != c.wantVal {
			t.Errorf("%s: credits = %d, want %d", c.wire, *f.Credits, c.wantVal)
		}
	}
}

// TestForward_BackpressurePausesChunks drives forward() directly with an
// outStream and proves the pause/resume contract: once paused, forward() blocks
// BEFORE sending the next chunk (no chunk frames appear within a window), and a
// resume releases it so the body completes. The upstream emits a head + many
// body pieces; we pause right after head, observe a quiet window, then resume
// and assert head -> chunk* -> end with the full body intact.
func TestForward_BackpressurePausesChunks(t *testing.T) {
	const piece = "0123456789abcdef" // 16B/piece
	const pieces = 64                // 1KiB total, many reads
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		fl, _ := w.(http.Flusher)
		for i := 0; i < pieces; i++ {
			io.WriteString(w, piece)
			if fl != nil {
				fl.Flush()
			}
		}
	}))
	defer srv.Close()

	upstream := mustParse(t, srv.URL+"/mcp")
	cw := &collectingWriter{}
	os := &outStream{resume: make(chan struct{}, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	os.cancel = cancel

	// PAUSE before forward() starts: head is never paused, so head still flows,
	// but the very first body chunk must block until we resume.
	os.setPaused(true)

	done := make(chan struct{})
	go func() {
		forward(ctx, upstream, frame{ID: "bp-1", Type: "req", Method: "GET", Path: "/mcp"}, cw.write, os, false)
		close(done)
	}()

	// The head must arrive promptly even while paused.
	waitFor(t, 2*time.Second, func() bool { return hasType(cw.snapshot(), "head") })

	// While paused, NO chunk may appear within a window. Record the chunk count
	// after the head, sleep a window, assert it didn't grow and we saw no end.
	time.Sleep(150 * time.Millisecond)
	pausedFrames := cw.snapshot()
	if n := countType(pausedFrames, "chunk"); n != 0 {
		t.Fatalf("paused: agent sent %d chunk(s) while paused, want 0: %+v", n, pausedFrames)
	}
	if hasType(pausedFrames, "end") {
		t.Fatalf("paused: stream ended while paused — body drained past the pause")
	}
	select {
	case <-done:
		t.Fatalf("paused: forward() returned while paused, want still blocked")
	default:
	}

	// RESUME: credits>0. forward() unblocks and the body completes.
	os.setPaused(false)
	waitFor(t, 3*time.Second, func() bool {
		fr := cw.snapshot()
		return len(fr) > 0 && fr[len(fr)-1].Type == "end"
	})
	<-done // forward() returned cleanly

	// head -> chunk* -> end, and the decoded chunks equal the full body.
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
	if want := strings.Repeat(piece, pieces); string(assembled) != want {
		t.Errorf("assembled body len=%d, want len=%d", len(assembled), len(want))
	}
}

// TestForward_ResetCancelsBlockingUpstream proves a reset (modeled as ctx
// cancel, which is exactly what the read loop's reset case does) aborts a
// forward() that is parked reading a BLOCKING upstream. Without the cancel,
// forward() would hang on resp.Body.Read forever; with it, forward() returns
// promptly. This is the dead-stream-drain bug the reset frame fixes.
func TestForward_ResetCancelsBlockingUpstream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		fl, _ := w.(http.Flusher)
		if fl != nil {
			fl.Flush() // commit the head so the agent emits its head frame
		}
		io.WriteString(w, "first")
		if fl != nil {
			fl.Flush()
		}
		// Then block until the request ctx is cancelled. forward()'s ctx-cancel
		// (the reset path) cancels the HTTP request, which propagates here and
		// unblocks us — so there's no teardown deadlock.
		<-r.Context().Done()
	}))
	defer srv.Close()

	upstream := mustParse(t, srv.URL+"/mcp")
	cw := &collectingWriter{}
	os := &outStream{resume: make(chan struct{}, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	os.cancel = cancel

	done := make(chan struct{})
	go func() {
		forward(ctx, upstream, frame{ID: "rst-1", Type: "req", Method: "GET", Path: "/mcp"}, cw.write, os, false)
		close(done)
	}()

	// Wait until the head (and likely the first chunk) has been relayed, proving
	// forward() is now parked in the blocking Body.Read.
	waitFor(t, 2*time.Second, func() bool { return hasType(cw.snapshot(), "head") })

	// RESET: the read loop calls os.cancel() on a reset frame. Assert forward()
	// returns promptly rather than draining a dead/blocked upstream forever.
	start := time.Now()
	os.cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("forward() did not return within 3s of reset (still draining blocked upstream)")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("forward() took %s to abort after reset, want prompt", d)
	}
}

// TestServe_FakeDOBackpressureAndReset stands up a fake DO over a REAL WebSocket
// and runs the production serve() read loop against it, exercising the actual
// req -> spawn / window -> pause-resume / reset -> cancel switch end-to-end.
//
//	(a) backpressure: the DO sends req, reads the head, then window{credits:0};
//	    the agent must STOP sending chunks (none within a window). window{>0}
//	    resumes them and the body completes with `end`.
//	(b) reset: a second id whose upstream BLOCKS forever — the DO sends a reset
//	    mid-stream and the agent's forward() must stop reading promptly (the
//	    upstream handler unblocks via ctx-cancel on the request).
func TestServe_FakeDOBackpressureAndReset(t *testing.T) {
	// --- upstream: id "a" streams pieces SLOWLY over ~1s so the pause reliably
	// lands mid-stream (a tiny instant body would all arrive before window:0 and
	// there'd be nothing to pause); id "b" blocks after head until ctx-cancel. ---
	const piece = "0123456789abcdef"          // 16B
	const pieceN = 2048                       // 32KiB per flushed piece (one agent read)
	const pieces = 40                         // ~1.25MiB total, emitted over ~1s
	bigPiece := strings.Repeat(piece, pieceN) // 32KiB
	wantLen := len(bigPiece) * pieces
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		fl, _ := w.(http.Flusher)
		if r.Header.Get("X-Block") == "1" {
			// Blocking upstream: emit head + a byte, then park until the request
			// ctx is cancelled (which is what the agent's reset->cancel does).
			io.WriteString(w, "x")
			if fl != nil {
				fl.Flush()
			}
			<-r.Context().Done()
			return
		}
		for i := 0; i < pieces; i++ {
			io.WriteString(w, bigPiece)
			if fl != nil {
				fl.Flush()
			}
			time.Sleep(25 * time.Millisecond) // spread the stream so a pause lands mid-body
		}
	}))
	defer srv.Close()
	upstream := mustParse(t, srv.URL+"/mcp")

	// --- fake DO: a WebSocket server that drives the agent's serve() loop. ---
	type doState struct {
		mu     sync.Mutex
		frames []frame
	}
	st := &doState{}
	record := func(f frame) {
		st.mu.Lock()
		st.frames = append(st.frames, f)
		st.mu.Unlock()
	}
	count := func(id, typ string) int {
		st.mu.Lock()
		defer st.mu.Unlock()
		n := 0
		for _, f := range st.frames {
			if f.ID == id && f.Type == typ {
				n++
			}
		}
		return n
	}
	hasIDType := func(id, typ string) bool { return count(id, typ) > 0 }

	serveErr := make(chan error, 1)
	doDone := make(chan struct{})
	httpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		// coder/websocket defaults to a 32KiB read limit; a single 32KiB body read
		// becomes a ~44KB base64+JSON chunk frame, so raise it to match the agent's
		// 32MiB limit or the DO reader trips a protocol close mid-stream.
		c.SetReadLimit(32 << 20)
		// NOT r.Context(): coder/websocket hijacks the conn in Accept, after which
		// the request context is cancelled — using it for the WS reads/writes
		// would close the link the instant Accept returns. Use an independent ctx.
		ctx, ctxCancel := context.WithCancel(context.Background())
		defer ctxCancel()
		defer c.Close(websocket.StatusNormalClosure, "done")
		defer close(doDone)

		send := func(f frame) error {
			b, _ := json.Marshal(f)
			return c.Write(ctx, websocket.MessageText, b)
		}

		// Reader goroutine: record every frame the agent (serve) writes back.
		go func() {
			for {
				_, data, err := c.Read(ctx)
				if err != nil {
					return
				}
				var f frame
				if json.Unmarshal(data, &f) == nil {
					record(f)
				}
			}
		}()

		// (a) backpressure stream, id "a".
		_ = send(frame{ID: "a", Type: "req", Method: "GET", Path: "/mcp", ReqHeaders: map[string]string{}})
		// Wait for the head AND the first body chunk, so the stream is genuinely
		// mid-body when we pause (the upstream is still emitting pieces). Non-fatal
		// waits: this runs on the DO handler goroutine where t.Fatal is illegal —
		// report via t.Errorf and bail so the link closes and serve() unwinds.
		if !pollUntil(3*time.Second, func() bool { return hasIDType("a", "head") }) {
			t.Errorf("fake-DO: never saw head for id a")
			return
		}
		if !pollUntil(3*time.Second, func() bool { return count("a", "chunk") > 0 }) {
			t.Errorf("fake-DO: never saw a first chunk for id a")
			return
		}
		// PAUSE.
		_ = send(frame{ID: "a", Type: "window", Credits: intp(0)})

		// Let the pause take effect and any already-read in-flight chunk flush,
		// THEN snapshot. The upstream keeps emitting a 32KiB piece every 25ms, so
		// observing a quiet window that spans many of those intervals proves the
		// agent is genuinely blocked at the chunk gate (not merely between reads).
		time.Sleep(250 * time.Millisecond)
		baseline := count("a", "chunk")
		time.Sleep(400 * time.Millisecond) // >> several 25ms upstream piece intervals
		if grew := count("a", "chunk"); grew != baseline {
			t.Errorf("fake-DO: chunks grew %d->%d while paused (agent ignored window:0)", baseline, grew)
		}
		if hasIDType("a", "end") {
			t.Errorf("fake-DO: id a ended while paused (body drained past the pause)")
		}

		// RESUME and let the body complete.
		_ = send(frame{ID: "a", Type: "window", Credits: intp(1 << 20)})
		if !pollUntil(5*time.Second, func() bool { return hasIDType("a", "end") }) {
			t.Errorf("fake-DO: id a never ended after resume")
			return
		}
		// The agent must have sent MORE chunks after resume than at the pause
		// baseline — proving resume actually re-opened the gate.
		if total := count("a", "chunk"); total <= baseline {
			t.Errorf("fake-DO: chunks after resume (%d) <= paused baseline (%d) — resume did not re-open", total, baseline)
		}

		// (b) reset on a blocking stream, id "b".
		_ = send(frame{ID: "b", Type: "req", Method: "GET", Path: "/mcp", ReqHeaders: map[string]string{"x-block": "1"}})
		if !pollUntil(3*time.Second, func() bool { return hasIDType("b", "head") }) {
			t.Errorf("fake-DO: never saw head for id b")
			return
		}
		// Send reset; the agent cancels forward(), which cancels the upstream
		// request, which unblocks the handler — the upstream then sees ctx.Done.
		_ = send(frame{ID: "b", Type: "reset"})
		// Give the agent a moment to act on the reset, then close to end serve().
		time.Sleep(200 * time.Millisecond)
	}))
	defer httpSrv.Close()

	wsURL := "ws" + strings.TrimPrefix(httpSrv.URL, "http")
	go func() { serveErr <- serve(context.Background(), wsURL, upstream, false, "") }()

	// The fake DO drives the whole script then closes; serve() returns on the
	// closed link. Bound the whole test so a hang fails loudly.
	select {
	case <-doDone:
	case <-time.After(15 * time.Second):
		t.Fatal("fake-DO script did not complete in time")
	}
	select {
	case <-serveErr:
	case <-time.After(5 * time.Second):
		t.Fatal("serve() did not return after the link closed")
	}

	// id "a" completed: head + >=1 chunk + end, and never an err/reset.
	if !hasIDType("a", "head") || !hasIDType("a", "end") {
		t.Errorf("id a: want head+end, got head=%v end=%v", hasIDType("a", "head"), hasIDType("a", "end"))
	}
	if count("a", "chunk") == 0 {
		t.Errorf("id a: no chunks after resume")
	}
	// The full body must survive the pause/resume cycle intact (no bytes lost or
	// duplicated by the flow-control gate).
	st.mu.Lock()
	var aBody []byte
	for _, f := range st.frames {
		if f.ID == "a" && f.Type == "chunk" {
			dec, _ := base64.StdEncoding.DecodeString(f.Data)
			aBody = append(aBody, dec...)
		}
	}
	st.mu.Unlock()
	if len(aBody) != wantLen {
		t.Errorf("id a: assembled body len=%d, want %d (bytes lost/dupped across pause)", len(aBody), wantLen)
	}
	// id "b": the reset must have aborted it. The agent's forward() emits a
	// `reset` frame when the upstream read fails on ctx cancel (committed,
	// post-head abort). It must NOT have produced an `end` for b.
	if hasIDType("b", "end") {
		t.Errorf("id b: ended despite reset (forward kept draining the blocked upstream)")
	}
}

// --- small polling/inspection helpers, kept local to this test file ---

// waitFor polls cond until true or the deadline, failing the test on timeout.
// MUST be called from the test goroutine only (it uses t.Fatalf).
func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	if !pollUntil(d, cond) {
		t.Fatalf("condition not met within %s", d)
	}
}

// pollUntil polls cond until it returns true or the deadline elapses, reporting
// the result as a bool. Goroutine-safe: it never touches *testing.T, so it is
// safe to call off the test goroutine (e.g. inside the fake-DO handler).
func pollUntil(d time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cond()
}

func hasType(frames []frame, typ string) bool { return countType(frames, typ) > 0 }

func countType(frames []frame, typ string) int {
	n := 0
	for _, f := range frames {
		if f.Type == typ {
			n++
		}
	}
	return n
}
