package core

import (
	"context"
	"net/url"
	"testing"
)

func TestRelayRequestRegistry_BoundsAndPreservesStreamIdentity(t *testing.T) {
	r := newRelayRequestRegistry(1)
	one := &outStream{cancel: func() {}}
	two := &outStream{cancel: func() {}}
	if !r.add("same", one) {
		t.Fatal("first stream rejected")
	}
	if r.add("same", two) {
		t.Fatal("active duplicate request ID replaced its owner")
	}
	if r.add("other", two) {
		t.Fatal("in-flight limit was exceeded")
	}
	r.remove("same", two)
	if got := r.lookup("same"); got != one {
		t.Fatal("late completion removed a different stream generation")
	}
	r.remove("same", one)
	if !r.add("other", two) {
		t.Fatal("capacity was not released after completion")
	}
	if r.add("", one) || r.add(string(make([]byte, maxRelayRequestIDBytes+1)), one) {
		t.Fatal("empty or oversized request ID was accepted")
	}
}

func TestRunForwardedRelayRequest_CancelsAndUnregistersOnNormalReturn(t *testing.T) {
	parent := context.Background()
	ctx, cancel := context.WithCancel(parent)
	stream := &outStream{resume: make(chan struct{}, 1), cancel: cancel}
	r := newRelayRequestRegistry(1)
	if !r.add("request", stream) {
		t.Fatal("register stream")
	}
	base, _ := url.Parse("http://127.0.0.1:8000")
	runForwardedRelayRequest(ctx, r, base, frame{ID: "request", Method: "GET", Path: "/outside"}, func(frame) error { return nil }, stream, false, nil)
	select {
	case <-ctx.Done():
	default:
		t.Fatal("completed request left its child context attached to relay")
	}
	if r.lookup("request") != nil {
		t.Fatal("completed request remained in in-flight registry")
	}
}
