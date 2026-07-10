package core

import (
	"context"
	"sync"
	"testing"
	"time"
)

type relayEvent struct {
	appPath string
	kind    string
	leaseID string
}

func recordingRelay(events chan<- relayEvent, exitDelay time.Duration) relayRunFunc {
	return func(ctx context.Context, service ServiceStatus, status func(string, string)) error {
		status("live", "test relay")
		events <- relayEvent{appPath: service.AppPath, kind: "start", leaseID: service.LeaseID}
		<-ctx.Done()
		if exitDelay > 0 {
			time.Sleep(exitDelay)
		}
		events <- relayEvent{appPath: service.AppPath, kind: "stop", leaseID: service.LeaseID}
		return nil
	}
}

func waitRelayEvent(t *testing.T, events <-chan relayEvent, appPath, kind string) relayEvent {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case event := <-events:
			if event.appPath == appPath && event.kind == kind {
				return event
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s %s", appPath, kind)
		}
	}
}

func expireLeaseSoon(t *testing.T, registry *DynamicRegistry, appPath string, delay time.Duration) {
	t.Helper()
	registry.mu.Lock()
	reg := registry.dynamic[appPath]
	reg.ExpiresAt = time.Now().Add(delay)
	registry.dynamic[appPath] = reg
	registry.mu.Unlock()
	registry.signal()
}

func TestRelayReconciler_DeleteAndExpiryStopDynamicButRetainStatic(t *testing.T) {
	registry := NewDynamicRegistry([]StaticService{{AppPath: "legacy", Upstream: "http://127.0.0.1:8000", ForwardAll: true}})
	events := make(chan relayEvent, 16)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runRelayReconciler(ctx, registry, recordingRelay(events, 0)) }()
	waitRelayEvent(t, events, "legacy", "start")

	first, err := registry.Register(RegistrationRequest{AppPath: "media", Upstream: "http://127.0.0.1:7342", LeaseSeconds: 10})
	if err != nil {
		t.Fatal(err)
	}
	waitRelayEvent(t, events, "media", "start")
	if err := registry.Remove(first.LeaseID); err != nil {
		t.Fatal(err)
	}
	waitRelayEvent(t, events, "media", "stop")

	if services := registry.Services(); len(services) != 1 || services[0].AppPath != "legacy" {
		t.Fatalf("static service was not retained: %+v", services)
	}
	second, err := registry.Register(RegistrationRequest{AppPath: "media", Upstream: "http://127.0.0.1:7342", LeaseSeconds: 10})
	if err != nil {
		t.Fatal(err)
	}
	waitRelayEvent(t, events, "media", "start")
	expireLeaseSoon(t, registry, "media", 75*time.Millisecond)
	stopped := waitRelayEvent(t, events, "media", "stop")
	if stopped.leaseID != second.LeaseID {
		t.Fatalf("stopped lease %q, want %q", stopped.leaseID, second.LeaseID)
	}

	cancel()
	waitRelayEvent(t, events, "legacy", "stop")
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRelayReconciler_RenewalWinsExpiryRace(t *testing.T) {
	registry := NewDynamicRegistry(nil)
	events := make(chan relayEvent, 8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runRelayReconciler(ctx, registry, recordingRelay(events, 0))
	lease, err := registry.Register(RegistrationRequest{AppPath: "media", Upstream: "http://127.0.0.1:7342", LeaseSeconds: 10})
	if err != nil {
		t.Fatal(err)
	}
	waitRelayEvent(t, events, "media", "start")
	expireLeaseSoon(t, registry, "media", 100*time.Millisecond)
	time.Sleep(30 * time.Millisecond)
	if _, err := registry.Renew(lease.LeaseID); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-events:
		if event.appPath == "media" && event.kind == "stop" {
			t.Fatal("renewed relay was stopped at its old expiry")
		}
	case <-time.After(150 * time.Millisecond):
	}
}

func TestRelayReconciler_ReplacementNeverOverlapsOldRelay(t *testing.T) {
	registry := NewDynamicRegistry(nil)
	var mu sync.Mutex
	active, maxActive := 0, 0
	started := make(chan string, 4)
	run := func(ctx context.Context, service ServiceStatus, _ func(string, string)) error {
		mu.Lock()
		active++
		if active > maxActive {
			maxActive = active
		}
		mu.Unlock()
		started <- service.LeaseID
		<-ctx.Done()
		time.Sleep(75 * time.Millisecond)
		mu.Lock()
		active--
		mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runRelayReconciler(ctx, registry, run)
	first, _ := registry.Register(RegistrationRequest{AppPath: "media", Upstream: "http://127.0.0.1:7342", LeaseSeconds: 10})
	if got := <-started; got != first.LeaseID {
		t.Fatalf("first start=%q", got)
	}
	if err := registry.Remove(first.LeaseID); err != nil {
		t.Fatal(err)
	}
	second, err := registry.Register(RegistrationRequest{AppPath: "media", Upstream: "http://127.0.0.1:7442", LeaseSeconds: 10})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-started:
		if got != second.LeaseID {
			t.Fatalf("replacement start=%q, want %q", got, second.LeaseID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("replacement did not start")
	}
	mu.Lock()
	defer mu.Unlock()
	if maxActive != 1 {
		t.Fatalf("old/new relays overlapped: max active=%d", maxActive)
	}
}

func TestCallRelayRunner_RecoversPanic(t *testing.T) {
	err := callRelayRunner(context.Background(), func(context.Context, ServiceStatus, func(string, string)) error {
		panic("boom")
	}, ServiceStatus{AppPath: "media"}, func(string, string) {})
	if err == nil || err.Error() != "relay panic: boom" {
		t.Fatalf("panic result=%v", err)
	}
}
