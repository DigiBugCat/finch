// Package app is finch-bar's controller: it polls finch, keeps the menu in
// step, and carries out what the menu asks for — always by running finch.
package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/DigiBugCat/finch/bar/internal/finch"
	"github.com/DigiBugCat/finch/bar/internal/model"
)

// Finch is the finch CLI, as finch-bar uses it (*finch.Client).
type Finch interface {
	Version(ctx context.Context) (finch.VersionInfo, error)
	Status(ctx context.Context) (finch.Status, error)
	Fleet(ctx context.Context) (finch.Fleet, error)
	ServiceStatus(ctx context.Context) (finch.ServiceStatus, error)
	ServiceInstall(ctx context.Context) (finch.ServiceChange, error)
	ServiceUninstall(ctx context.Context) (finch.ServiceChange, error)
	Test(ctx context.Context, name string) (finch.TestResult, error)
	LoginStart(ctx context.Context) (finch.LoginStart, error)
	LoginPoll(ctx context.Context) (finch.LoginPoll, error)
	LoginCancel(ctx context.Context) (finch.LoginCancel, error)
	Update(ctx context.Context) (finch.UpdateResult, error)
	UpdateLegacy(ctx context.Context) error
}

// Desktop is the handful of things finch-bar asks of the desktop.
type Desktop interface {
	OpenURL(u string) error
	Copy(text string) error
	Notify(title, body string)
	// OpenLog shows the background service's log.
	OpenLog(s finch.ServiceStatus) error
}

// LoginItem starts finch-bar at login (a LaunchAgent or an XDG autostart entry).
type LoginItem interface {
	Installed() bool
	Install() error
	Uninstall() error
}

// Config wires the controller to the outside world. Tests swap every piece.
type Config struct {
	// Locate finds the finch binary; it runs on every poll so installing
	// finch while finch-bar runs is noticed.
	Locate func() (string, error)
	// NewFinch returns the client for a binary.
	NewFinch func(bin string) Finch
	// Stat reports the binary's modification time, to notice an update.
	Stat      func(bin string) (time.Time, error)
	Desktop   Desktop
	LoginItem LoginItem // nil when not supported
	// Render shows a state and its menu.
	Render func(model.State, []model.Item)
	Quit   func()
	Now    func() time.Time
	// Sleep waits d or until ctx ends (the sign-in poll's pause).
	Sleep func(ctx context.Context, d time.Duration) error
}

// messageTTL is how long an action's outcome stays in the menu.
const messageTTL = 2 * time.Minute

// App is the running controller.
type App struct {
	cfg Config

	mu        sync.Mutex
	state     model.State
	ui        model.UI
	messageAt time.Time
	failures  int
	lastPoll  time.Time
	// version cache: re-read `finch version` only when the binary changes.
	verBin  string
	verMod  time.Time
	version string
	verErr  error

	pollMu   sync.Mutex // one poll at a time
	renderMu sync.Mutex // renders in order
	signIn   context.CancelFunc
	trigger  chan struct{}
	jobs     sync.WaitGroup
}

// New returns a controller. Call Run to start polling.
func New(cfg Config) *App {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Sleep == nil {
		cfg.Sleep = func(ctx context.Context, d time.Duration) error {
			t := time.NewTimer(d)
			defer t.Stop()
			select {
			case <-t.C:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	if cfg.Stat == nil {
		cfg.Stat = func(bin string) (time.Time, error) {
			st, err := os.Stat(bin)
			if err != nil {
				return time.Time{}, err
			}
			return st.ModTime(), nil
		}
	}
	a := &App{cfg: cfg, trigger: make(chan struct{}, 1)}
	a.ui.Busy = map[string]string{}
	a.ui.Tests = map[string]model.TestNote{}
	if cfg.LoginItem != nil {
		on := cfg.LoginItem.Installed()
		a.ui.LoginItem = &on
	}
	return a
}

// State returns the last derived state (for tests and --print).
func (a *App) State() model.State {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state
}

// Menu returns the current menu.
func (a *App) Menu() []model.Item {
	a.mu.Lock()
	defer a.mu.Unlock()
	return model.Build(a.state, a.uiCopy())
}

// NextPoll is how long Run waits before the next poll, given the failures
// so far.
func (a *App) NextPoll() time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	return NextDelay(a.failures)
}

// Refresh asks the poll loop to poll now (opening the menu calls this).
func (a *App) Refresh() {
	select {
	case a.trigger <- struct{}{}:
	default:
	}
}

// Wait blocks until every action started by Do has finished (tests).
func (a *App) Wait() { a.jobs.Wait() }

// Run polls until ctx ends: every PollInterval, sooner when Refresh is
// called, later after failures.
func (a *App) Run(ctx context.Context) {
	for {
		a.Poll(ctx)
		t := time.NewTimer(a.NextPoll())
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		case <-a.trigger:
			t.Stop()
			a.mu.Lock()
			since := a.cfg.Now().Sub(a.lastPoll)
			a.mu.Unlock()
			if since < MinRefreshGap {
				if err := a.cfg.Sleep(ctx, MinRefreshGap-since); err != nil {
					return
				}
			}
		}
	}
}

// Poll runs finch once (version when the binary changed, status, and fleet
// when signed in) and renders the result.
func (a *App) Poll(ctx context.Context) {
	a.pollMu.Lock()
	defer a.pollMu.Unlock()

	snap := model.Snapshot{}
	bin, err := a.cfg.Locate()
	snap.Binary, snap.LocateErr = bin, err
	if err == nil {
		f := a.cfg.NewFinch(bin)
		snap.Version, snap.VersionErr = a.finchVersion(ctx, f, bin)
		if snap.VersionErr == nil && !finch.OlderThan(snap.Version, finch.MinVersion) {
			if st, err := f.Status(ctx); err != nil {
				snap.StatusErr = err
			} else {
				snap.Status = &st
				if st.LoggedIn() && !st.LoginPending && !st.Unverified() {
					if fl, err := f.Fleet(ctx); err != nil {
						snap.FleetErr = err
					} else {
						snap.Fleet = &fl
					}
				}
			}
		}
	}
	state := model.Derive(snap)

	a.mu.Lock()
	a.state = state
	a.lastPoll = a.cfg.Now()
	switch state.Kind {
	case model.FinchError, model.HubUnreachable, model.FleetError:
		a.failures++
	default:
		a.failures = 0
	}
	if a.ui.Message != "" && a.cfg.Now().Sub(a.messageAt) > messageTTL {
		a.ui.Message = ""
	}
	// A sign-in finch-bar started is over once finch no longer reports it
	// pending (approved, cancelled or replaced from a terminal).
	if a.ui.SignIn != nil && state.Kind != model.LoginPending && a.ui.Busy["signin"] == "" && a.signIn == nil {
		a.ui.SignIn = nil
	}
	a.mu.Unlock()
	a.render()
}

// finchVersion runs `finch --version --json` when the binary is new or
// changed. The answer is kept until then, including "too old": asking an old
// finch again on every poll would only get the same answer. A finch that
// could not be run, or timed out, is asked again on the next poll.
func (a *App) finchVersion(ctx context.Context, f Finch, bin string) (string, error) {
	mod, _ := a.cfg.Stat(bin)
	a.mu.Lock()
	if bin == a.verBin && mod.Equal(a.verMod) && (a.verErr == nil || finch.TooOld(a.verErr)) {
		v, err := a.version, a.verErr
		a.mu.Unlock()
		return v, err
	}
	a.mu.Unlock()
	info, err := f.Version(ctx)
	a.mu.Lock()
	a.verBin, a.verMod, a.version, a.verErr = bin, mod, info.Version, err
	a.mu.Unlock()
	return info.Version, err
}

func (a *App) uiCopy() model.UI {
	ui := a.ui
	ui.Busy = make(map[string]string, len(a.ui.Busy))
	for k, v := range a.ui.Busy {
		ui.Busy[k] = v
	}
	ui.Tests = make(map[string]model.TestNote, len(a.ui.Tests))
	for k, v := range a.ui.Tests {
		ui.Tests[k] = v
	}
	if a.ui.SignIn != nil {
		s := *a.ui.SignIn
		ui.SignIn = &s
	}
	if a.ui.LoginItem != nil {
		b := *a.ui.LoginItem
		ui.LoginItem = &b
	}
	return ui
}

func (a *App) render() {
	a.renderMu.Lock()
	defer a.renderMu.Unlock()
	a.mu.Lock()
	state := a.state
	items := model.Build(state, a.uiCopy())
	a.mu.Unlock()
	if a.cfg.Render != nil {
		a.cfg.Render(state, items)
	}
}

// update changes the UI state under the lock, then renders.
func (a *App) update(f func(ui *model.UI)) {
	a.mu.Lock()
	f(&a.ui)
	if a.ui.Message != "" {
		a.messageAt = a.cfg.Now()
	}
	a.mu.Unlock()
	a.render()
}

// startJob marks key busy with label, unless it already is.
func (a *App) startJob(key, label string) bool {
	a.mu.Lock()
	if _, busy := a.ui.Busy[key]; busy {
		a.mu.Unlock()
		return false
	}
	a.ui.Busy[key] = label
	a.mu.Unlock()
	a.render()
	return true
}

func (a *App) endJob(key, message string) {
	a.update(func(ui *model.UI) {
		delete(ui.Busy, key)
		if message != "" {
			ui.Message = message
		}
	})
}

func (a *App) client() (Finch, error) {
	bin, err := a.cfg.Locate()
	if err != nil {
		return nil, err
	}
	return a.cfg.NewFinch(bin), nil
}

// Do carries out a menu action. Anything that runs finch runs in the
// background, so the menu never freezes.
func (a *App) Do(ctx context.Context, act model.Action) {
	switch act.Kind {
	case model.ActNone:
	case model.ActQuit:
		a.mu.Lock()
		cancel := a.signIn
		a.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		if a.cfg.Quit != nil {
			a.cfg.Quit()
		}
	case model.ActRefresh:
		a.Refresh()
	case model.ActOpenURL:
		if err := a.cfg.Desktop.OpenURL(act.Text); err != nil {
			a.update(func(ui *model.UI) { ui.Message = "Couldn't open the browser: " + short(err) })
		}
	case model.ActCopy:
		what := "the URL"
		if act.What != "" {
			what = act.What
		} else if act.Service != "" {
			what = act.Service + "'s URL"
		} else if act.Text == finch.InstallCommand {
			what = "the install command"
		}
		if err := a.cfg.Desktop.Copy(act.Text); err != nil {
			a.update(func(ui *model.UI) { ui.Message = "Couldn't copy: " + short(err) })
			a.cfg.Desktop.Notify("finch", act.Text)
			return
		}
		a.update(func(ui *model.UI) { ui.Message = "Copied " + what })
	case model.ActToggleLoginItem:
		a.toggleLoginItem()
	default:
		a.jobs.Add(1)
		go func() {
			defer a.jobs.Done()
			a.run(ctx, act)
		}()
	}
}

func (a *App) run(ctx context.Context, act model.Action) {
	switch act.Kind {
	case model.ActTest:
		a.test(ctx, act.Service)
	case model.ActStartService:
		a.service(ctx, true)
	case model.ActStopService:
		a.service(ctx, false)
	case model.ActOpenLog:
		a.openLog(ctx)
	case model.ActSignIn:
		a.startSignIn(ctx)
	case model.ActCancelSignIn:
		a.cancelSignIn(ctx)
	case model.ActUpdate:
		a.updateFinch(ctx)
	}
}

func (a *App) test(ctx context.Context, name string) {
	key := "test:" + name
	if !a.startJob(key, "Testing "+name+"…") {
		return
	}
	f, err := a.client()
	var res finch.TestResult
	if err == nil {
		res, err = f.Test(ctx, name)
	}
	at := a.cfg.Now()
	note := model.TestNote{At: at}
	if err != nil {
		note.Text = fmt.Sprintf("Test failed at %s: %s", at.Format("15:04"), short(err))
		a.cfg.Desktop.Notify(name+": test failed", errText(err))
	} else {
		note.OK = true
		note.Text = fmt.Sprintf("Test passed at %s: %s", at.Format("15:04"), plural(len(res.Tools), "tool", "tools"))
		a.cfg.Desktop.Notify(name+": test passed", fmt.Sprintf("%s answered with %s.", name, plural(len(res.Tools), "tool", "tools")))
	}
	a.mu.Lock()
	a.ui.Tests[name] = note
	a.mu.Unlock()
	a.endJob(key, "")
}

func (a *App) service(ctx context.Context, start bool) {
	label := "Stopping background service…"
	if start {
		label = "Starting background service…"
	}
	if !a.startJob("service", label) {
		return
	}
	f, err := a.client()
	if err == nil {
		if start {
			_, err = f.ServiceInstall(ctx)
		} else {
			_, err = f.ServiceUninstall(ctx)
		}
	}
	msg := "Background service stopped"
	switch {
	case err != nil && start:
		msg = "Couldn't start the background service: " + short(err)
		a.cfg.Desktop.Notify("finch: background service didn't start", errText(err))
	case err != nil:
		msg = "Couldn't stop the background service: " + short(err)
		a.cfg.Desktop.Notify("finch: background service didn't stop", errText(err))
	case start:
		msg = "Background service started"
	}
	a.endJob("service", msg)
	a.Refresh()
}

func (a *App) openLog(ctx context.Context) {
	f, err := a.client()
	var s finch.ServiceStatus
	if err == nil {
		s, err = f.ServiceStatus(ctx)
	}
	if err == nil {
		err = a.cfg.Desktop.OpenLog(s)
	}
	if err != nil {
		a.update(func(ui *model.UI) { ui.Message = "Couldn't open the log: " + short(err) })
	}
}

// signInPoll bounds the wait between `finch login --poll` calls.
const (
	minSignInPoll = 2 * time.Second
	maxSignInPoll = 10 * time.Second
)

func (a *App) startSignIn(ctx context.Context) {
	if !a.startJob("signin", "Opening sign-in…") {
		return
	}
	a.mu.Lock()
	if a.signIn != nil {
		a.signIn() // a new sign-in replaces the one being polled
		a.signIn = nil
	}
	a.mu.Unlock()
	f, err := a.client()
	var start finch.LoginStart
	if err == nil {
		start, err = f.LoginStart(ctx)
	}
	if err != nil {
		a.endJob("signin", "Couldn't start sign-in: "+short(err))
		return
	}
	pollCtx, cancel := context.WithTimeout(ctx, time.Duration(max(start.ExpiresIn, 60))*time.Second)
	a.mu.Lock()
	a.signIn = cancel
	a.ui.SignIn = &model.SignIn{UserCode: start.UserCode, URL: start.VerificationURIComplete}
	a.mu.Unlock()
	openErr := a.cfg.Desktop.OpenURL(start.VerificationURIComplete)
	msg := ""
	if openErr != nil {
		msg = "Open " + start.VerificationURIComplete + " to sign in"
	}
	a.endJob("signin", msg)
	a.Refresh()

	interval := min(max(time.Duration(start.Interval)*time.Second, minSignInPoll), maxSignInPoll)
	outcome := a.pollSignIn(pollCtx, f, interval)
	cancel()
	a.mu.Lock()
	mine := a.ui.SignIn != nil && a.ui.SignIn.UserCode == start.UserCode
	if mine {
		a.ui.SignIn = nil
		a.signIn = nil
	}
	a.mu.Unlock()
	if !mine {
		return // replaced or cancelled
	}
	if outcome != "" {
		a.update(func(ui *model.UI) { ui.Message = outcome })
	}
	a.Refresh()
}

// pollSignIn runs `finch login --poll` until the sign-in resolves; it returns
// the message to show ("" when cancelled).
func (a *App) pollSignIn(ctx context.Context, f Finch, interval time.Duration) string {
	for {
		if err := a.cfg.Sleep(ctx, interval); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return "Sign-in expired. Choose Sign in to try again."
			}
			return ""
		}
		res, err := f.LoginPoll(ctx)
		var fe *finch.Error
		switch {
		case err == nil && res.Status == "approved":
			who := res.Account
			if who == "" {
				who = "your finch account"
			}
			a.cfg.Desktop.Notify("finch: signed in", "Signed in as "+who+".")
			return "Signed in as " + who
		case err == nil && res.Status == "pending":
			continue
		case err == nil && res.Status == "expired":
			return "Sign-in expired. Choose Sign in to try again."
		case errors.As(err, &fe) && fe.Code == finch.CodeNotFound:
			return "" // finished or cancelled elsewhere (a terminal)
		case errors.As(err, &fe) && fe.Code == finch.CodeUpstream:
			continue // a network blip; keep polling until it expires
		case ctx.Err() != nil:
			return ""
		case err != nil:
			return "Sign-in failed: " + short(err)
		default:
			return fmt.Sprintf("Sign-in failed: finch reported %q", res.Status)
		}
	}
}

func (a *App) cancelSignIn(ctx context.Context) {
	a.mu.Lock()
	if a.signIn != nil {
		a.signIn()
		a.signIn = nil
	}
	a.ui.SignIn = nil
	a.mu.Unlock()
	f, err := a.client()
	if err == nil {
		_, err = f.LoginCancel(ctx)
	}
	msg := "Sign-in cancelled"
	if err != nil {
		msg = "Couldn't cancel sign-in: " + short(err)
	}
	a.update(func(ui *model.UI) { ui.Message = msg })
	a.Refresh()
}

func (a *App) updateFinch(ctx context.Context) {
	if !a.startJob("update", "Checking for updates…") {
		return
	}
	a.mu.Lock()
	legacy := a.state.Kind == model.TooOld
	a.mu.Unlock()
	f, err := a.client()
	msg := ""
	if err == nil && legacy {
		if err = f.UpdateLegacy(ctx); err == nil {
			msg = "Updated finch"
		}
	} else if err == nil {
		var res finch.UpdateResult
		if res, err = f.Update(ctx); err == nil {
			switch {
			case !res.Updated && res.Version != "":
				msg = fmt.Sprintf("finch %s is already the latest", res.Version)
			case !res.Updated:
				msg = "finch is already the latest"
			case res.Restart == "service":
				msg = "Updated finch and restarted the background service"
			default:
				msg = "Updated finch"
			}
		}
	}
	if err != nil {
		msg = "Couldn't update finch: " + short(err)
	}
	a.cfg.Desktop.Notify("finch", msg)
	a.mu.Lock()
	a.verBin = "" // read the version again
	a.mu.Unlock()
	a.endJob("update", msg)
	a.Refresh()
}

func (a *App) toggleLoginItem() {
	li := a.cfg.LoginItem
	if li == nil {
		return
	}
	var err error
	on := li.Installed()
	if on {
		err = li.Uninstall()
	} else {
		err = li.Install()
	}
	now := li.Installed()
	a.update(func(ui *model.UI) {
		ui.LoginItem = &now
		switch {
		case err != nil:
			ui.Message = "Couldn't change the login item: " + short(err)
		case now:
			ui.Message = "finch-bar will open when you log in"
		default:
			ui.Message = "finch-bar won't open at login"
		}
	})
}

// errText is the full message of an error, preferring finch's own words and
// its suggested next command.
func errText(err error) string {
	var fe *finch.Error
	if errors.As(err, &fe) {
		if fe.Next != "" {
			return fe.Message + " (next: " + fe.Next + ")"
		}
		return fe.Message
	}
	return err.Error()
}

// short keeps an error to one readable menu line.
func short(err error) string {
	s := strings.TrimSpace(errText(err))
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if r := []rune(s); len(r) > 80 {
		s = string(r[:79]) + "…"
	}
	return s
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}
