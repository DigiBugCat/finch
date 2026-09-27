package app_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigiBugCat/finch/bar/internal/app"
	"github.com/DigiBugCat/finch/bar/internal/desktop"
	"github.com/DigiBugCat/finch/bar/internal/fakefinch"
	"github.com/DigiBugCat/finch/bar/internal/finch"
	"github.com/DigiBugCat/finch/bar/internal/model"
)

func TestMain(m *testing.M) {
	fakefinch.MaybeRun()
	os.Exit(m.Run())
}

// fakeDesktop records what finch-bar asked of the desktop. Like the real one
// it refuses links that are not https.
type fakeDesktop struct {
	mu       sync.Mutex
	opened   []string
	copied   []string
	notified []string
	logs     []finch.ServiceStatus
	copyErr  error
}

func (d *fakeDesktop) OpenURL(u string) error {
	if err := desktop.CheckURL(u); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.opened = append(d.opened, u)
	return nil
}

func (d *fakeDesktop) Copy(text string) error {
	if text == "" {
		return errors.New("fake desktop: nothing to copy")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.copyErr != nil {
		return d.copyErr
	}
	d.copied = append(d.copied, text)
	return nil
}

func (d *fakeDesktop) Notify(title, body string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.notified = append(d.notified, title+": "+body)
}

func (d *fakeDesktop) OpenLog(s finch.ServiceStatus) error {
	if s.Manager == "" {
		return errors.New("fake desktop: no service manager")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.logs = append(d.logs, s)
	return nil
}

type fakeLoginItem struct{ on bool }

func (l *fakeLoginItem) Installed() bool  { return l.on }
func (l *fakeLoginItem) Install() error   { l.on = true; return nil }
func (l *fakeLoginItem) Uninstall() error { l.on = false; return nil }

type harness struct {
	app     *app.App
	fake    *fakefinch.Fake
	desk    *fakeDesktop
	renders int
	sleeps  []time.Duration
	mu      sync.Mutex
}

func newHarness(t *testing.T, grammar string, responses map[string][]string) *harness {
	t.Helper()
	h := &harness{desk: &fakeDesktop{}}
	if responses != nil {
		h.fake = fakefinch.Install(t, grammar, responses)
	}
	h.app = app.New(app.Config{
		Locate: func() (string, error) {
			if h.fake == nil {
				return "", finch.ErrNotInstalled
			}
			return h.fake.Path, nil
		},
		NewFinch: func(bin string) app.Finch { return finch.New(bin) },
		Stat:     func(string) (time.Time, error) { return time.Unix(1, 0), nil },
		Desktop:  h.desk,
		Render: func(model.State, []model.Item) {
			h.mu.Lock()
			h.renders++
			h.mu.Unlock()
		},
		Now: func() time.Time { return time.Date(2026, 9, 27, 12, 4, 0, 0, time.UTC) },
		Sleep: func(ctx context.Context, d time.Duration) error {
			h.mu.Lock()
			h.sleeps = append(h.sleeps, d)
			h.mu.Unlock()
			return ctx.Err()
		},
		LoginItem: &fakeLoginItem{},
	})
	return h
}

func (h *harness) keys() []string {
	var keys []string
	for _, c := range h.fake.Calls() {
		keys = append(keys, fakefinch.Key(c))
	}
	return keys
}

func (h *harness) item(t *testing.T, id string) model.Item {
	t.Helper()
	for _, it := range model.Flatten(h.app.Menu()) {
		if it.ID == id {
			return it
		}
	}
	t.Fatalf("no menu item %q", id)
	return model.Item{}
}

var signedIn = map[string][]string{
	"version": {"1.8.0/version.json"},
	"status":  {"1.8.0/status-logged-in.json"},
	"fleet":   {"1.8.0/fleet-all-online.json"},
}

func with(base map[string][]string, extra map[string][]string) map[string][]string {
	out := map[string][]string{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func TestPollRunsVersionOnceThenStatusAndFleet(t *testing.T) {
	h := newHarness(t, "1.7", signedIn)
	ctx := context.Background()
	h.app.Poll(ctx)
	h.app.Poll(ctx)
	if st := h.app.State(); st.Kind != model.AllConnected {
		t.Fatalf("state = %v %q", st.Kind, st.Headline)
	}
	want := []string{"version", "status", "fleet", "status", "fleet"}
	if got := h.keys(); !slices.Equal(got, want) {
		t.Fatalf("finch calls = %q, want %q", got, want)
	}
	if h.renders != 2 {
		t.Fatalf("renders = %d", h.renders)
	}
}

func TestPollSkipsFleetWhenSignedOut(t *testing.T) {
	h := newHarness(t, "1.7", map[string][]string{
		"version": {"1.7.1/version.json"},
		"status":  {"1.7.1/status-logged-out.json"},
	})
	h.app.Poll(context.Background())
	if got := h.keys(); !slices.Equal(got, []string{"version", "status"}) {
		t.Fatalf("finch calls = %q", got)
	}
	if h.app.State().Kind != model.LoggedOut {
		t.Fatalf("state = %v", h.app.State().Kind)
	}
}

func TestPollOldFinchStopsAtVersion(t *testing.T) {
	h := newHarness(t, "1.6", map[string][]string{"version": {"1.6.0/version.json"}})
	h.app.Poll(context.Background())
	if got := h.keys(); !slices.Equal(got, []string{"version"}) {
		t.Fatalf("finch calls = %q (must not run commands 1.6 lacks)", got)
	}
	if h.app.State().Kind != model.TooOld {
		t.Fatalf("state = %v", h.app.State().Kind)
	}
}

func TestPollWithoutFinch(t *testing.T) {
	h := newHarness(t, "", nil)
	h.app.Poll(context.Background())
	if h.app.State().Kind != model.NoFinch {
		t.Fatalf("state = %v", h.app.State().Kind)
	}
	h.app.Do(context.Background(), h.item(t, "copy-install").Action)
	if len(h.desk.copied) != 1 || h.desk.copied[0] != finch.InstallCommand {
		t.Fatalf("copied = %q", h.desk.copied)
	}
	if m := h.item(t, "message"); m.Title != "Copied the install command" {
		t.Fatalf("message = %q", m.Title)
	}
}

func TestSignIn(t *testing.T) {
	h := newHarness(t, "1.7", map[string][]string{
		"version":       {"1.7.1/version.json"},
		"status":        {"1.7.1/status-logged-out.json"},
		"login --start": {"1.7.1/login-start.json"},
		"login --poll":  {"1.7.1/login-poll-pending.json", "1.7.1/login-poll-pending.json", "1.7.1/login-poll-approved.json"},
	})
	ctx := context.Background()
	h.app.Poll(ctx)
	h.app.Do(ctx, h.item(t, "signin").Action)
	h.app.Wait()

	if !slices.Equal(h.desk.opened, []string{"https://finchmcp.com/cli?code=WXYZ-2345"}) {
		t.Fatalf("opened = %q", h.desk.opened)
	}
	want := []string{"version", "status", "login --start", "login --poll", "login --poll", "login --poll"}
	if got := h.keys(); !slices.Equal(got, want) {
		t.Fatalf("finch calls = %q, want %q", got, want)
	}
	for _, d := range h.sleeps {
		if d != 3*time.Second {
			t.Fatalf("polled every %v, want finch's interval (3s)", d)
		}
	}
	if m := h.item(t, "message"); m.Title != "Signed in as you@example.com" {
		t.Fatalf("message = %q", m.Title)
	}
	if !slices.Contains(h.desk.notified, "finch: signed in: Signed in as you@example.com.") {
		t.Fatalf("notified = %q", h.desk.notified)
	}
}

func TestSignInExpires(t *testing.T) {
	h := newHarness(t, "1.7", map[string][]string{
		"version":       {"1.8.0/version.json"},
		"status":        {"1.8.0/status-logged-out.json"},
		"login --start": {"1.8.0/login-start.json"},
		"login --poll":  {"1.8.0/login-poll-pending.json", "1.8.0/login-poll-expired.json"},
	})
	ctx := context.Background()
	h.app.Poll(ctx)
	h.app.Do(ctx, model.Action{Kind: model.ActSignIn})
	h.app.Wait()
	if m := h.item(t, "message"); !strings.Contains(m.Title, "expired") {
		t.Fatalf("message = %q", m.Title)
	}
}

func TestSignInOnOldFinchFailsPlainly(t *testing.T) {
	h := newHarness(t, "1.6", map[string][]string{"version": {"1.6.0/version.json"}})
	h.app.Do(context.Background(), model.Action{Kind: model.ActSignIn})
	h.app.Wait()
	if m := h.item(t, "message"); !strings.HasPrefix(m.Title, "Couldn't start sign-in") {
		t.Fatalf("message = %q", m.Title)
	}
	if len(h.desk.opened) != 0 {
		t.Fatal("opened a browser without a sign-in link")
	}
}

func TestTestAction(t *testing.T) {
	h := newHarness(t, "1.7", with(signedIn, map[string][]string{
		"test notes":  {"1.8.0/test-ok.json", "1.8.0/test-handshake-rejected.json"},
		"test kanban": {"1.7.1/test-offline.json"},
	}))
	ctx := context.Background()
	h.app.Poll(ctx)

	h.app.Do(ctx, h.item(t, "svc:notes:test").Action)
	h.app.Wait()
	if n := h.item(t, "svc:notes:last-test"); n.Title != "Test passed at 12:04: 2 tools" {
		t.Fatalf("note = %q", n.Title)
	}
	h.app.Do(ctx, h.item(t, "svc:notes:test").Action)
	h.app.Wait()
	if n := h.item(t, "svc:notes:last-test"); !strings.Contains(n.Title, "rejected the MCP handshake") {
		t.Fatalf("note = %q", n.Title)
	}
	h.app.Do(ctx, h.item(t, "svc:kanban:test").Action)
	h.app.Wait()
	last := h.desk.notified[len(h.desk.notified)-1]
	if !strings.HasPrefix(last, "kanban: test failed: ") || !strings.Contains(last, "(next: finch service status)") {
		t.Fatalf("notification = %q", last)
	}
}

func TestStartServiceWithNothingToServe(t *testing.T) {
	h := newHarness(t, "1.7", with(signedIn, map[string][]string{
		"status":          {"1.8.0/status-service-not-installed.json"},
		"fleet":           {"1.8.0/fleet.json"},
		"service install": {"1.8.0/service-install-nothing.json"},
	}))
	ctx := context.Background()
	h.app.Poll(ctx)
	bg := h.item(t, "background")
	if bg.Action.Kind != model.ActStartService {
		t.Fatalf("background = %+v", bg)
	}
	h.app.Do(ctx, bg.Action)
	h.app.Wait()
	if m := h.item(t, "message"); !strings.HasPrefix(m.Title, "Couldn't start the background service: nothing to serve yet") {
		t.Fatalf("message = %q", m.Title)
	}
	if bg := h.item(t, "background"); bg.Disabled {
		t.Fatal("background item still busy after the job ended")
	}
	if !strings.Contains(strings.Join(h.desk.notified, "\n"), "next: finch add <name> --service <url>") {
		t.Fatalf("notified = %q", h.desk.notified)
	}
}

func TestStopService(t *testing.T) {
	h := newHarness(t, "1.7", with(signedIn, map[string][]string{
		"service uninstall": {"1.8.0/service-uninstall.json"},
		"service status":    {"1.8.0/service-status.json"},
	}))
	ctx := context.Background()
	h.app.Poll(ctx)
	h.app.Do(ctx, h.item(t, "background").Action)
	h.app.Wait()
	if m := h.item(t, "message"); m.Title != "Background service stopped" {
		t.Fatalf("message = %q", m.Title)
	}
	h.app.Do(ctx, h.item(t, "log").Action)
	h.app.Wait()
	if len(h.desk.logs) != 1 || h.desk.logs[0].Manager != "launchd" {
		t.Fatalf("logs = %+v", h.desk.logs)
	}
	calls := h.keys()
	if !slices.Contains(calls, "service uninstall") || !slices.Contains(calls, "service status") {
		t.Fatalf("finch calls = %q", calls)
	}
}

func TestUpdateCurrentAndRereadVersion(t *testing.T) {
	h := newHarness(t, "1.7", with(signedIn, map[string][]string{"update": {"1.8.0/update-current.json"}}))
	ctx := context.Background()
	h.app.Poll(ctx)
	h.app.Do(ctx, h.item(t, "update").Action)
	h.app.Wait()
	if m := h.item(t, "message"); m.Title != "finch 1.8.0 is already the latest" {
		t.Fatalf("message = %q", m.Title)
	}
	h.app.Poll(ctx)
	want := []string{"version", "status", "fleet", "update", "version", "status", "fleet"}
	if got := h.keys(); !slices.Equal(got, want) {
		t.Fatalf("finch calls = %q, want %q", got, want)
	}
}

func TestUpdateOldFinchUsesPlainUpdate(t *testing.T) {
	h := newHarness(t, "1.6", map[string][]string{
		"version": {"1.6.0/version.json"},
		"update":  {"1.6.0/update.json"},
	})
	ctx := context.Background()
	h.app.Poll(ctx)
	h.app.Do(ctx, h.item(t, "update").Action)
	h.app.Wait()
	calls := h.fake.Calls()
	if len(calls) != 2 || !slices.Equal(calls[1], []string{"update"}) {
		t.Fatalf("finch calls = %q, want a plain `finch update`", calls)
	}
	if m := h.item(t, "message"); m.Title != "Updated finch" {
		t.Fatalf("message = %q", m.Title)
	}
}

func TestCopyURLAndOpenFleetRow(t *testing.T) {
	h := newHarness(t, "1.7", signedIn)
	ctx := context.Background()
	h.app.Poll(ctx)
	h.app.Do(ctx, h.item(t, "svc:kanban:copy").Action)
	h.app.Do(ctx, h.item(t, "svc:kanban:open").Action)
	if !slices.Equal(h.desk.copied, []string{"https://wren.finchmcp.com/kanban/"}) {
		t.Fatalf("copied = %q", h.desk.copied)
	}
	if !slices.Equal(h.desk.opened, []string{"https://finchmcp.com/fleet#kanban"}) {
		t.Fatalf("opened = %q", h.desk.opened)
	}
	if m := h.item(t, "message"); m.Title != "Copied kanban's URL" {
		t.Fatalf("message = %q", m.Title)
	}
}

func TestCopyFailureShowsTheText(t *testing.T) {
	h := newHarness(t, "1.7", signedIn)
	h.desk.copyErr = errors.New("no clipboard tool found; install wl-clipboard, xclip or xsel")
	ctx := context.Background()
	h.app.Poll(ctx)
	h.app.Do(ctx, h.item(t, "svc:notes:copy").Action)
	if m := h.item(t, "message"); !strings.Contains(m.Title, "xclip") {
		t.Fatalf("message = %q", m.Title)
	}
	if len(h.desk.notified) == 0 || !strings.Contains(h.desk.notified[0], "https://wren.finchmcp.com/notes/mcp") {
		t.Fatalf("notified = %q (the URL should still reach the user)", h.desk.notified)
	}
}

func TestOpenURLRefusesUnsafeLinks(t *testing.T) {
	h := newHarness(t, "1.7", signedIn)
	h.app.Poll(context.Background())
	h.app.Do(context.Background(), model.Action{Kind: model.ActOpenURL, Text: "file:///etc/passwd"})
	if len(h.desk.opened) != 0 {
		t.Fatal("opened a file: URL")
	}
	if m := h.item(t, "message"); !strings.HasPrefix(m.Title, "Couldn't open the browser") {
		t.Fatalf("message = %q", m.Title)
	}
}

func TestToggleLoginItem(t *testing.T) {
	h := newHarness(t, "1.7", signedIn)
	h.app.Poll(context.Background())
	if li := h.item(t, "login-item"); li.Checked {
		t.Fatal("login item starts checked")
	}
	h.app.Do(context.Background(), model.Action{Kind: model.ActToggleLoginItem})
	if li := h.item(t, "login-item"); !li.Checked {
		t.Fatal("login item not checked after enabling")
	}
	if m := h.item(t, "message"); m.Title != "finch-bar will open when you log in" {
		t.Fatalf("message = %q", m.Title)
	}
}

func TestFailuresBackOff(t *testing.T) {
	h := newHarness(t, "1.7", with(signedIn, map[string][]string{"fleet": {
		"1.8.0/fleet-hub-error.json", "1.8.0/fleet-hub-error.json", "1.8.0/fleet-hub-error.json", "1.8.0/fleet-all-online.json",
	}}))
	for i := 0; i < 3; i++ {
		h.app.Poll(context.Background())
	}
	if h.app.State().Kind != model.FleetError {
		t.Fatalf("state = %v", h.app.State().Kind)
	}
	if got := h.app.NextPoll(); got != 80*time.Second {
		t.Fatalf("after 3 failures the next poll is in %v, want 80s", got)
	}
	h.app.Poll(context.Background())
	if got := h.app.NextPoll(); got != app.PollInterval {
		t.Fatalf("after recovering the next poll is in %v, want %v", got, app.PollInterval)
	}
}

func TestNextDelay(t *testing.T) {
	for failures, want := range map[int]time.Duration{
		0: 10 * time.Second, 1: 20 * time.Second, 2: 40 * time.Second,
		4: 160 * time.Second, 5: 5 * time.Minute, 50: 5 * time.Minute,
	} {
		if got := app.NextDelay(failures); got != want {
			t.Errorf("NextDelay(%d) = %v, want %v", failures, got, want)
		}
	}
}

func TestRunRefreshesOnDemand(t *testing.T) {
	h := newHarness(t, "1.7", signedIn)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { h.app.Run(ctx); close(done) }()
	waitFor(t, func() bool { return countKey(h, "status") >= 1 })
	h.app.Refresh()
	waitFor(t, func() bool { return countKey(h, "status") >= 2 })
	cancel()
	<-done
}

func countKey(h *harness, key string) int {
	n := 0
	for _, k := range h.keys() {
		if k == key {
			n++
		}
	}
	return n
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal(fmt.Errorf("timed out"))
		}
		time.Sleep(10 * time.Millisecond)
	}
}
