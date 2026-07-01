// Command finch-tray is a menubar / system-tray front-end for the finch relay.
//
// It's the desktop sibling of `finch run`: one binary that reads a finch.yml
// manifest and supervises a relay per ingress rule, but instead of logging to a
// terminal it lives in the macOS menubar (and the Windows/Linux system tray),
// surfaces each appliance's live state as a menu item, auto-starts the relays on
// launch, and lets you add/remove appliances via native dialogs. The relay logic,
// auth, and finch.yml semantics are identical to the CLI because both drive the
// same agent/core engine (core.RunConfig / core.Add / core.Remove).
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	_ "embed"

	"github.com/digibugcat/finch/agent/core"
	"github.com/getlantern/systray"
)

//go:embed icon.png
var iconPNG []byte

// maxRows bounds the pre-created pool of appliance rows (and Remove sub-items).
// systray can't reorder or delete items after creation, so we allocate a fixed
// pool up-front and Show/Hide slots as the manifest changes — keeping menu order
// stable. Bumped only if someone fronts more than this many services from one box.
const maxRows = 24

var (
	configPath string
	hubFlag    string

	mu        sync.Mutex
	order     []string                     // app_paths, in manifest order
	rowByApp  map[string]*systray.MenuItem // app_path -> its status row
	lastState map[string]string            // app_path -> last relay state
	rows      []*systray.MenuItem          // the fixed status-row pool
	rmItems   []*systray.MenuItem          // the fixed Remove-submenu pool
	rmApp     []string                     // rmItems[i] currently removes rmApp[i]

	cancel   context.CancelFunc // non-nil while relays run
	runWG    sync.WaitGroup
	authItem *systray.MenuItem // the Log in / Log out row
)

func main() {
	flag.StringVar(&configPath, "config", "", "path to finch.yml (default: ~/.finch/finch.yml)")
	flag.StringVar(&hubFlag, "hub", "", "hub/dashboard base URL for the Open-dashboard item")
	flag.Parse()
	if configPath == "" {
		configPath = defaultConfigPath()
	}
	rowByApp = map[string]*systray.MenuItem{}
	lastState = map[string]string{}
	systray.Run(onReady, onExit)
}

// defaultConfigPath is ~/.finch/finch.yml (the installed-app home), creating the
// ~/.finch dir so `finch add` from the tray has somewhere to write.
func defaultConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "finch.yml"
	}
	dir := filepath.Join(home, ".finch")
	_ = os.MkdirAll(dir, 0o700)
	return filepath.Join(dir, "finch.yml")
}

func onReady() {
	// Template icon: a black finch silhouette macOS/Linux recolor to match the
	// menubar (light on dark, dark on light).
	systray.SetTemplateIcon(iconPNG, iconPNG)
	systray.SetTooltip("finch — local services, published")

	header := systray.AddMenuItem("finch", "")
	header.Disable()
	systray.AddSeparator()

	// Fixed pool of status rows (hidden until reloadRows assigns them).
	rows = make([]*systray.MenuItem, maxRows)
	for i := range rows {
		it := systray.AddMenuItem("", "")
		it.Disable()
		it.Hide()
		rows[i] = it
	}
	systray.AddSeparator()

	addItem := systray.AddMenuItem("Add appliance…", "Enroll a local service and publish it")
	rmParent := systray.AddMenuItem("Remove appliance", "Remove a published appliance")
	rmItems = make([]*systray.MenuItem, maxRows)
	rmApp = make([]string, maxRows)
	for i := range rmItems {
		it := rmParent.AddSubMenuItem("", "")
		it.Hide()
		rmItems[i] = it
	}
	systray.AddSeparator()

	openManifest := systray.AddMenuItem("Open manifest", "Open finch.yml in your editor")
	openDash := systray.AddMenuItem("Open dashboard", "Open the finch dashboard in your browser")
	restart := systray.AddMenuItem("Reconnect all", "Stop and restart every relay")
	systray.AddSeparator()
	authItem = systray.AddMenuItem("", "") // "Log in…" / "Log out", set below
	quit := systray.AddMenuItem("Quit", "Stop relays and quit")

	updateAuthItem()
	reloadRows()
	startRelays() // auto-start on launch

	// One click-loop goroutine per interactive item (the systray idiom).
	go clickLoop(addItem, onAdd)
	go clickLoop(openManifest, func() { openPath(configPath) })
	go clickLoop(openDash, func() { openBrowser(dashboardURL()) })
	go clickLoop(restart, func() { stopRelays(); reloadRows(); startRelays() })
	go clickLoop(authItem, onAuth)
	go clickLoop(quit, func() { systray.Quit() })
	for i := range rmItems {
		i := i
		go clickLoop(rmItems[i], func() { onRemoveSlot(i) })
	}
}

func onExit() { stopRelays() }

func clickLoop(it *systray.MenuItem, fn func()) {
	for range it.ClickedCh {
		fn()
	}
}

// reloadRows re-reads the manifest and paints the status-row + Remove-submenu
// pools to match its appliances, hiding the unused slots.
func reloadRows() {
	apps := readAppPaths(configPath)
	mu.Lock()
	order = apps
	rowByApp = map[string]*systray.MenuItem{}
	for i, it := range rows {
		if i < len(apps) {
			app := apps[i]
			rowByApp[app] = it
			it.SetTitle(rowTitle(app, lastState[app], ""))
			it.Show()
		} else {
			it.Hide()
		}
	}
	for i, it := range rmItems {
		if i < len(apps) {
			rmApp[i] = apps[i]
			it.SetTitle(apps[i])
			it.Show()
		} else {
			rmApp[i] = ""
			it.Hide()
		}
	}
	mu.Unlock()
	refreshTooltip()
}

// onStatus is core.RunConfig's per-appliance callback (on relay goroutines).
func onStatus(appPath, state, detail string) {
	mu.Lock()
	lastState[appPath] = state
	it := rowByApp[appPath]
	mu.Unlock()
	if it != nil {
		it.SetTitle(rowTitle(appPath, state, detail))
	}
	refreshTooltip()
}

// onAdd runs the add flow: two native prompts (name + port) → core.Add → reload
// + restart. The port is turned into http://127.0.0.1:<port>; a full URL (with
// "://") is also accepted verbatim for non-localhost or https services.
func onAdd() {
	name, ok := askText("finch — add application", "Application name (becomes the URL path):", "")
	if !ok || name == "" {
		return
	}
	portOrURL, ok := askText("finch — add application", "Port (the local port it runs on):", "8000")
	if !ok || portOrURL == "" {
		return
	}
	service := portOrURL
	if !strings.Contains(portOrURL, "://") {
		service = "http://127.0.0.1:" + strings.TrimSpace(portOrURL)
	}
	stopRelays()
	id, url, err := core.Add(configPath, name, service)
	if err != nil {
		alert("finch — couldn't add", err.Error())
	} else {
		msg := "Added " + id
		if url != "" {
			msg += "\n" + url
		}
		alert("finch", msg)
	}
	reloadRows()
	startRelays()
}

// onRemoveSlot removes whatever appliance the given Remove sub-item points at.
func onRemoveSlot(i int) {
	mu.Lock()
	app := ""
	if i < len(rmApp) {
		app = rmApp[i]
	}
	mu.Unlock()
	if app == "" {
		return
	}
	stopRelays()
	if err := core.Remove(configPath, app); err != nil {
		alert("finch — couldn't remove", err.Error())
	}
	mu.Lock()
	delete(lastState, app)
	mu.Unlock()
	reloadRows()
	startRelays()
}

func startRelays() {
	if cancel != nil {
		return // already running
	}
	if len(order) == 0 {
		refreshTooltip()
		return
	}
	ctx, c := context.WithCancel(context.Background())
	cancel = c
	runWG.Add(1)
	go func() {
		defer runWG.Done()
		if err := core.RunConfig(ctx, configPath, onStatus); err != nil {
			mu.Lock()
			// Surface a manifest-level failure on the first row.
			for _, it := range rowByApp {
				it.SetTitle("• relay error — " + truncate(err.Error(), 48))
				break
			}
			mu.Unlock()
		}
	}()
	refreshTooltip()
}

func stopRelays() {
	if cancel == nil {
		return
	}
	cancel()
	cancel = nil
	runWG.Wait()
	mu.Lock()
	for app, it := range rowByApp {
		lastState[app] = "idle"
		it.SetTitle(rowTitle(app, "idle", ""))
	}
	mu.Unlock()
}

func refreshTooltip() {
	mu.Lock()
	live, total := 0, len(order)
	for _, s := range lastState {
		if s == "connected" || s == "live" {
			live++
		}
	}
	running := cancel != nil
	mu.Unlock()
	if total == 0 {
		systray.SetTooltip("finch — no appliances (Add appliance…)")
		return
	}
	if !running {
		systray.SetTooltip("finch — stopped")
		return
	}
	systray.SetTooltip(fmt.Sprintf("finch — %d/%d appliances live", live, total))
}

func rowTitle(app, state, detail string) string {
	t := "• " + app + " — " + prettyState(state)
	if detail != "" && (state == "reconnecting" || state == "error" || state == "warn") {
		t += " (" + truncate(detail, 36) + ")"
	}
	return t
}

func prettyState(s string) string {
	switch s {
	case "connected", "live":
		return "live"
	case "connecting":
		return "connecting…"
	case "reconnecting":
		return "reconnecting…"
	case "enrolled":
		return "enrolled"
	case "error":
		return "error"
	case "warn":
		return "warning"
	case "", "idle":
		return "idle"
	default:
		return s
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

// updateAuthItem paints the Log in / Log out row from the current credential.
func updateAuthItem() {
	if authItem == nil {
		return
	}
	if hub, in := core.LoginInfo(); in {
		authItem.SetTitle("Log out")
		authItem.SetTooltip("Signed in to " + hub)
	} else {
		authItem.SetTitle("Log in…")
		authItem.SetTooltip("Sign in to your finch tenant")
	}
}

// onAuth logs out (drops the CLI token) or runs the browser device-login flow,
// showing the short code in a dialog and opening the approval page.
func onAuth() {
	if _, in := core.LoginInfo(); in {
		if err := core.Logout(); err != nil {
			alert("finch — logout failed", err.Error())
			return
		}
		updateAuthItem()
		alert("finch", "Logged out.")
		return
	}
	go func() {
		err := core.Login(loginHub(), func(uri, code string) {
			openBrowser(uri)
			alert("finch — approve login", "Your browser is opening the approval page.\n\nEnter this code:\n\n    "+code)
		})
		if err != nil {
			alert("finch — login failed", err.Error())
			return
		}
		updateAuthItem()
		stopRelays()
		reloadRows()
		startRelays()
		alert("finch", "Logged in.")
	}()
}

// loginHub is the WORKER hub the device-login talks to — the manifest's hub:,
// falling back to prod. (Distinct from the web dashboard URL below.)
func loginHub() string {
	if h := readHub(configPath); h != "" {
		return h
	}
	return "https://finchmcp.com"
}

// dashboardURL is the WEB dashboard page: the -hub flag (baked at install as the
// web origin) or the manifest hub, with the /dashboard route appended.
func dashboardURL() string {
	base := hubFlag
	if base == "" {
		base = readHub(configPath)
	}
	if base == "" {
		base = "https://finchmcp.com"
	}
	return strings.TrimRight(base, "/") + "/dashboard"
}

// openPath opens a local file with the OS default handler (finch.yml in an editor).
func openPath(p string) {
	var name string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		name, args = "open", []string{p}
	case "windows":
		name, args = "cmd", []string{"/c", "start", "", p}
	default:
		name, args = "xdg-open", []string{p}
	}
	_ = exec.Command(name, args...).Start()
}

func openBrowser(url string) {
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		cmd, args = "open", []string{url}
	case "windows":
		cmd, args = "rundll32", []string{"url.dll,FileProtocolHandler", url}
	default:
		cmd, args = "xdg-open", []string{url}
	}
	_ = exec.Command(cmd, args...).Start()
}
