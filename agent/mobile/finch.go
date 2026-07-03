// Package finch is the embeddable mobile SDK surface for the finch agent. It is
// bound to a Java/Kotlin `.aar` (and an iOS framework) with gomobile, so an app
// you build can publish a LOCAL service — an MCP server, a web app, any HTTP/WS
// endpoint your app runs on 127.0.0.1 — through the finch hub, with no inbound
// ports (the device dials OUT).
//
// It is a thin wrapper over agent/core's embeddable relay: the protocol, auth,
// and SSRF confinement are byte-identical to the `finch` CLI. Only gomobile-
// friendly types cross the boundary (strings/bool structs + one callback
// interface), so this package binds cleanly to Kotlin/Java/Swift.
//
// Lifecycle (mirrors `finch enroll` + `finch run`):
//
//	val svc = Finch.newService(cfg, listener)
//	svc.enroll(ticket)   // once per device (mint the ticket in the dashboard)
//	svc.start()          // resumes from the saved credential, relays in background
//	svc.stop()           // cancels the relay
//
// Build the .aar with agent/scripts/build-aar.sh.
package finch

import (
	"context"
	"sync"

	"github.com/digibugcat/finch/agent/core"
)

// Config describes the appliance the app wants to publish. All fields are plain
// values so gomobile binds Config as a simple Kotlin/Java class with getters and
// setters.
type Config struct {
	// Hub is the finch hub base URL. Empty defaults to https://finchmcp.com.
	Hub string
	// Machine is this device's name in the dashboard. Empty defaults to the OS
	// hostname (often not meaningful on Android — set something stable like an
	// install id).
	Machine string
	// AppPath is the public URL segment / appliance id (the slug host serves it
	// at https://<slug>.finchmcp.com/<AppPath>/…). Set it to the appliance the
	// enrollment ticket was minted for.
	AppPath string
	// Upstream is the LOCAL service to publish, e.g. "http://127.0.0.1:8080".
	// Your app runs this server; finch forwards hub requests to it.
	Upstream string
	// CredentialPath is a writable file (e.g. context.getFilesDir()+"/finch.json")
	// where the long-lived refresh credential is stored after Enroll, so Start
	// resumes without a new ticket.
	CredentialPath string
	// ForwardAll exposes the WHOLE local host (every path) instead of confining to
	// /mcp. Leave false for an MCP server; set true to host a website / arbitrary
	// HTTP app.
	ForwardAll bool
}

// Listener receives relay lifecycle updates. Implement it in Kotlin/Java/Swift;
// callbacks arrive on a background thread, so marshal to the UI thread yourself.
// `state` is one of: connecting, enrolled, live, connected, reconnecting, warn,
// stopped. `detail` is a human-readable note (often the public URL or an error).
type Listener interface {
	OnState(state, detail string)
}

// Service is one embeddable relay. Create it with NewService, Enroll once with a
// dashboard ticket, then Start/Stop. A Service is safe to use from multiple
// threads.
type Service struct {
	cfg      Config
	listener Listener

	mu      sync.Mutex
	cancel  context.CancelFunc
	running bool
}

// NewService creates a relay for cfg. listener may be nil. The relay does not
// start until Start is called.
func NewService(cfg *Config, listener Listener) *Service {
	c := Config{}
	if cfg != nil {
		c = *cfg
	}
	return &Service{cfg: c, listener: listener}
}

func (s *Service) opts() core.EmbedOptions {
	return core.EmbedOptions{
		Hub:            s.cfg.Hub,
		Machine:        s.cfg.Machine,
		AppPath:        s.cfg.AppPath,
		Upstream:       s.cfg.Upstream,
		CredentialPath: s.cfg.CredentialPath,
		ForwardAll:     s.cfg.ForwardAll,
	}
}

func (s *Service) emit(state, detail string) {
	if s.listener != nil {
		s.listener.OnState(state, detail)
	}
}

// Enroll trades a one-shot dashboard ticket for a saved refresh credential at
// CredentialPath. Call it once per box (the ticket is minted in the dashboard
// under "Add box"). Synchronous — returns a non-nil error for a bad/expired
// ticket or an unwritable CredentialPath, so the app can show it immediately.
func (s *Service) Enroll(ticket string) error {
	o := s.opts()
	o.Ticket = ticket
	return core.EmbedEnroll(o)
}

// Start launches the relay on a background goroutine and returns immediately. It
// resumes from the saved credential; lifecycle updates flow to the Listener.
// Calling Start while already running is a no-op. Pair every Start with a Stop
// (e.g. in your Service/onDestroy).
func (s *Service) Start() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.running = true
	s.mu.Unlock()

	go func() {
		err := core.Embed(ctx, s.opts(), func(state, detail string) {
			s.emit(state, detail)
		})
		s.mu.Lock()
		s.running = false
		s.cancel = nil
		s.mu.Unlock()
		if err != nil && ctx.Err() == nil {
			s.emit("stopped", err.Error())
		} else {
			s.emit("stopped", "")
		}
	}()
}

// Stop cancels the relay. Safe to call when not running and to call repeatedly.
func (s *Service) Stop() {
	s.mu.Lock()
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Running reports whether the relay loop is currently active.
func (s *Service) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

// Version returns the finch agent version this SDK was built from — handy for an
// app's about screen and for the dashboard's "outdated" check.
func Version() string { return core.Version() }
