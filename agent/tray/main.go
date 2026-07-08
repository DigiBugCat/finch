//go:build tray

// Command finch-tray is a menubar / system-tray front-end for the finch relay.
//
// It's the desktop sibling of `finch run`: one binary that reads a finch.yml
// manifest and supervises a relay per ingress rule, living in the macOS menubar
// (and the Windows/Linux tray). It auto-starts the relays on launch and, like
// Tailscale, shows the fleet grouped into "This box" (the services this box
// publishes, with live relay state) and "Other boxes" (every other box in the
// tenant and what it serves, from the hub). Add/remove services and log in/out
// via native dialogs. Everything runs on the same agent/core engine as the CLI.
package main

import (
	"context"
	"flag"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	_ "embed"

	"github.com/digibugcat/finch/agent/core"
	"github.com/getlantern/systray"
)

//go:embed icon.png
var iconPNG []byte

// Fixed pools: systray can't reorder or delete items after creation, so we
// allocate slots up-front and Show/Hide them as the manifest + fleet change.
const (
	maxRows       = 16 // services this box publishes
	maxBoxes      = 8  // other boxes shown under "Other boxes"
	maxAppsPerBox = 12 // services per other box
	fleetPoll     = 15 * time.Second
)

var (
	configPath string
	hubFlag    string
	localBox   string // this box's name (finch.yml box: or hostname)

	mu        sync.Mutex
	order     []string                     // local app_paths, in manifest order
	rowByApp  map[string]*systray.MenuItem // local app_path -> its "This box" row
	lastState map[string]string            // local app_path -> last relay state
	rows      []*systray.MenuItem          // "This box" row pool
	rmItems   []*systray.MenuItem          // Remove-submenu pool
	rmApp     []string                     // rmItems[i] removes rmApp[i]

	thisParent  *systray.MenuItem
	otherParent *systray.MenuItem
	machParent  []*systray.MenuItem   // "Other boxes" -> per-box submenu parents
	machRows    [][]*systray.MenuItem // machParent[j] -> its service rows
	machRowApp  [][]string            // machRows[j][k] -> the service id it shows

	statusItem    *systray.MenuItem // "Connected" / "Signed out" status line
	accountParent *systray.MenuItem // account row (submenu with Log out) when signed in
	loginItem     *systray.MenuItem // "Log in…" when signed out

	cancel context.CancelFunc // non-nil while relays run
	runWG  sync.WaitGroup
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
	localBox = localBoxName()
	systray.Run(onReady, onExit)
}

func defaultConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "finch.yml"
	}
	dir := filepath.Join(home, ".finch")
	_ = os.MkdirAll(dir, 0o700)
	return filepath.Join(dir, "finch.yml")
}

// localBoxName is the manifest's box:, else the OS hostname — the name
// this box registers under, so we can tell "this box" from the others.
func localBoxName() string {
	if m := readBox(configPath); m != "" {
		return m
	}
	h, _ := os.Hostname()
	return h
}

func onReady() {
	systray.SetTemplateIcon(iconPNG, iconPNG)
	systray.SetTooltip("finch — local services, published")

	// Header + status + account row (Tailscale-style top block).
	header := systray.AddMenuItem("finch", "")
	header.Disable()
	statusItem = systray.AddMenuItem("Connected", "")
	statusItem.Disable()
	systray.AddSeparator()
	accountParent = systray.AddMenuItem("", "Your finch account")
	logoutItem := accountParent.AddSubMenuItem("Log out", "Sign out of this box")
	loginItem = systray.AddMenuItem("Log in…", "Sign in to your finch tenant")
	systray.AddSeparator()

	// "This box" — the services this box publishes, with live relay state.
	thisParent = systray.AddMenuItem("This box", "Services this box publishes")
	rows = make([]*systray.MenuItem, maxRows)
	for i := range rows {
		it := thisParent.AddSubMenuItem("", "Open this service in the dashboard")
		it.Hide()
		rows[i] = it
	}

	// "Other boxes" — every other box in the tenant, from the hub (read-only).
	otherParent = systray.AddMenuItem("Other boxes", "Other boxes in your tenant")
	machParent = make([]*systray.MenuItem, maxBoxes)
	machRows = make([][]*systray.MenuItem, maxBoxes)
	machRowApp = make([][]string, maxBoxes)
	for j := range machParent {
		p := otherParent.AddSubMenuItem("", "")
		p.Hide()
		machParent[j] = p
		machRows[j] = make([]*systray.MenuItem, maxAppsPerBox)
		machRowApp[j] = make([]string, maxAppsPerBox)
		for k := range machRows[j] {
			it := p.AddSubMenuItem("", "Open this service in the dashboard")
			it.Hide()
			machRows[j][k] = it
		}
	}
	systray.AddSeparator()

	addItem := systray.AddMenuItem("Add application…", "Enroll a local service and publish it")
	rmParent := systray.AddMenuItem("Remove application", "Remove a published service")
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
	systray.AddSeparator()
	quit := systray.AddMenuItem("Quit", "Stop relays and quit")

	updateAccount()
	reloadRows()
	startRelays()
	updateStatus()
	go refreshFleet() // first paint of "Other boxes"
	go fleetTicker()  // keep it fresh

	go clickLoop(accountParent, func() {}) // parent is just a container for Log out
	go clickLoop(logoutItem, onLogout)
	go clickLoop(loginItem, onLogin)
	go clickLoop(addItem, onAdd)
	go clickLoop(openManifest, func() { openPath(configPath) })
	go clickLoop(openDash, func() { openBrowser(dashboardURL()) })
	go clickLoop(quit, func() { systray.Quit() })
	for i := range rmItems {
		i := i
		go clickLoop(rmItems[i], func() { onRemoveSlot(i) })
	}
	// Clicking a service opens its dashboard page.
	for i := range rows {
		i := i
		go clickLoop(rows[i], func() { onLocalRowClick(i) })
	}
	for j := range machRows {
		j := j
		for k := range machRows[j] {
			k := k
			go clickLoop(machRows[j][k], func() { onOtherRowClick(j, k) })
		}
	}
}

// onLocalRowClick opens the dashboard for the service in "This box" slot i.
func onLocalRowClick(i int) {
	mu.Lock()
	app := ""
	if i < len(order) {
		app = order[i]
	}
	mu.Unlock()
	if app != "" {
		openBrowser(dashboardAppURL(app))
	}
}

// onOtherRowClick opens the dashboard for the service in "Other boxes" slot.
func onOtherRowClick(j, k int) {
	mu.Lock()
	app := ""
	if j < len(machRowApp) && k < len(machRowApp[j]) {
		app = machRowApp[j][k]
	}
	mu.Unlock()
	if app != "" {
		openBrowser(dashboardAppURL(app))
	}
}

func onExit() { stopRelays() }

func clickLoop(it *systray.MenuItem, fn func()) {
	for range it.ClickedCh {
		fn()
	}
}

func fleetTicker() {
	for {
		time.Sleep(fleetPoll)
		refreshFleet()
	}
}

// reloadRows repaints the "This box" pool from the manifest.
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
	n := len(apps)
	mu.Unlock()
	if thisParent != nil {
		thisParent.SetTitle(fmt.Sprintf("This box (%d)", n))
	}
	refreshTooltip()
}

// refreshFleet repaints "Other boxes" from the hub: every box that isn't this
// one, each a submenu of the services it serves. Best-effort — a login/network
// error just leaves a hint on the parent.
func refreshFleet() {
	nodes, err := core.FleetNodes()
	if err != nil {
		if otherParent != nil {
			otherParent.SetTitle("Other boxes — (log in)")
			mu.Lock()
			for _, p := range machParent {
				p.Hide()
			}
			mu.Unlock()
		}
		return
	}
	// Group services by box, excluding this box.
	type fleetApp struct{ id, label string }
	byBox := map[string][]fleetApp{}
	for _, n := range nodes {
		if n.Box == localBox {
			continue
		}
		byBox[n.Box] = append(byBox[n.Box], fleetApp{n.Service, n.Service + " — " + prettyState(n.State)})
	}
	names := make([]string, 0, len(byBox))
	for name := range byBox {
		names = append(names, name)
	}
	sort.Strings(names)

	mu.Lock()
	for j, p := range machParent {
		if j < len(names) {
			name := names[j]
			apps := byBox[name]
			p.SetTitle(fmt.Sprintf("%s (%d)", name, len(apps)))
			p.Show()
			for k, row := range machRows[j] {
				if k < len(apps) {
					row.SetTitle("• " + apps[k].label)
					machRowApp[j][k] = apps[k].id
					row.Show()
				} else {
					machRowApp[j][k] = ""
					row.Hide()
				}
			}
		} else {
			p.Hide()
			for k := range machRowApp[j] {
				machRowApp[j][k] = ""
			}
		}
	}
	count := len(names)
	mu.Unlock()
	if otherParent != nil {
		otherParent.SetTitle(fmt.Sprintf("Other boxes (%d)", count))
	}
}

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

// onAdd: two native prompts (name + port) → core.Add → reload + restart.
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
	go refreshFleet()
}

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
	go refreshFleet()
}

func startRelays() {
	if cancel != nil {
		return
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
	switch {
	case total == 0:
		systray.SetTooltip("finch — no services (Add application…)")
	case !running:
		systray.SetTooltip("finch — stopped")
	default:
		systray.SetTooltip(fmt.Sprintf("finch — %d/%d live on this box", live, total))
	}
	updateStatus()
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
	case "connected", "live", "online", "chirping", "in_use":
		return "live"
	case "connecting":
		return "connecting…"
	case "reconnecting":
		return "reconnecting…"
	case "enrolled":
		return "enrolled"
	case "invited":
		return "invited"
	case "offline":
		return "offline"
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

// updateAccount paints the account row (its host, with a Log out submenu) or the
// "Log in…" item, depending on whether a credential is saved.
func updateAccount() {
	if accountParent == nil || loginItem == nil {
		return
	}
	if hub, email, in := core.LoginInfo(); in {
		label := email
		if label == "" {
			label = hostOf(hub) // pre-email login: fall back to the hub host
		}
		accountParent.SetTitle(label)
		accountParent.SetTooltip("Signed in to " + hub)
		accountParent.Show()
		loginItem.Hide()
	} else {
		accountParent.Hide()
		loginItem.Show()
	}
}

// updateStatus paints the header status line (Tailscale's "Connected"): signed-in
// state first, then how many local services are live. "Connected" whenever you
// hold a credential — 0 local apps is normal, not a disconnection.
func updateStatus() {
	if statusItem == nil {
		return
	}
	_, _, in := core.LoginInfo()
	mu.Lock()
	live, total := 0, len(order)
	for _, s := range lastState {
		if s == "connected" || s == "live" {
			live++
		}
	}
	running := cancel != nil
	mu.Unlock()
	switch {
	case !in:
		statusItem.SetTitle("Signed out")
	case total == 0:
		statusItem.SetTitle("Connected · no applications here")
	case running && live == total:
		statusItem.SetTitle("Connected")
	case running:
		statusItem.SetTitle(fmt.Sprintf("Connecting… (%d/%d)", live, total))
	default:
		statusItem.SetTitle("Connected · idle")
	}
}

// onLogout drops the CLI token (already-enrolled services keep working).
func onLogout() {
	if err := core.Logout(); err != nil {
		alert("finch — logout failed", err.Error())
		return
	}
	updateAccount()
	go refreshFleet()
	alert("finch", "Logged out.")
}

// onLogin runs the browser device-login flow (code shown in a native dialog).
func onLogin() {
	go func() {
		err := core.Login(loginHub(), func(uri, code string) {
			openBrowser(uri)
			alert("finch — approve login", "Your browser is opening the approval page.\n\nEnter this code:\n\n    "+code)
		})
		if err != nil {
			alert("finch — login failed", err.Error())
			return
		}
		updateAccount()
		stopRelays()
		reloadRows()
		startRelays()
		updateStatus()
		refreshFleet()
		alert("finch", "Logged in.")
	}()
}

// hostOf strips the scheme from a hub URL for a compact account label.
func hostOf(hub string) string {
	h := hub
	if i := strings.Index(h, "://"); i >= 0 {
		h = h[i+3:]
	}
	return strings.TrimRight(h, "/")
}

// loginHub is the WORKER hub the device-login talks to (manifest hub, else prod).
func loginHub() string {
	if h := readHub(configPath); h != "" {
		return h
	}
	return "https://finchmcp.com"
}

// dashboardURL is the WEB dashboard page: the -hub flag (web origin) or the
// manifest hub, with /dashboard appended.
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

// dashboardAppURL deep-links to one service's detail view in the dashboard.
func dashboardAppURL(id string) string {
	return dashboardURL() + "?service=" + url.QueryEscape(id)
}

func openBrowser(url string) {
	var name string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		name, args = "open", []string{url}
	case "windows":
		name, args = "rundll32", []string{"url.dll,FileProtocolHandler", url}
	default:
		name, args = "xdg-open", []string{url}
	}
	_ = exec.Command(name, args...).Start()
}

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
