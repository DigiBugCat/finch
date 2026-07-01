// Command finch-tray is a menubar / system-tray front-end for the finch relay.
//
// It's the desktop sibling of `finch run`: one binary that reads a finch.yml
// manifest and supervises a relay per ingress rule, but instead of logging to a
// terminal it lives in the macOS menubar (and the Windows/Linux system tray) and
// surfaces each appliance's live state as a menu item. Start/stop the whole roost
// from the menu; the relay logic, auth, and finch.yml semantics are identical to
// the CLI because both drive the same agent/core engine (core.RunConfig).
//
// One binary, three platforms: getlantern/systray abstracts the tray, and the
// relay engine is pure Go. Build per-OS with the normal `go build` (macOS/Linux
// need CGo + the platform GUI libs; see README).
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"sync"

	_ "embed"

	"github.com/digibugcat/finch/agent/core"
	"github.com/getlantern/systray"
)

//go:embed icon.png
var iconPNG []byte

var (
	configPath string // resolved finch.yml path
	hubURL     string // dashboard/hub base, for the "Open dashboard" item

	mu        sync.Mutex               // guards the maps below (status arrives on relay goroutines)
	items     map[string]*systray.MenuItem // app_path -> its menu row
	lastState map[string]string            // app_path -> last state, for the summary title

	cancel context.CancelFunc // non-nil while relays are running
	runWG  sync.WaitGroup
)

func main() {
	flag.StringVar(&configPath, "config", "", "path to finch.yml (default: ./finch.yml, else ~/.finch/finch.yml)")
	flag.StringVar(&hubURL, "hub", "", "hub/dashboard base URL for the Open-dashboard menu item")
	flag.Parse()

	if configPath == "" {
		configPath = discoverConfig()
	}
	items = map[string]*systray.MenuItem{}
	lastState = map[string]string{}

	systray.Run(onReady, onExit)
}

// discoverConfig mirrors the CLI's finch.yml lookup: prefer one in the working
// directory, then fall back to ~/.finch/finch.yml.
func discoverConfig() string {
	if _, err := os.Stat("finch.yml"); err == nil {
		return "finch.yml"
	}
	if home, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(home, ".finch", "finch.yml")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "finch.yml" // report the miss against the conventional name
}

func onReady() {
	systray.SetIcon(iconPNG)
	systray.SetTitle("") // icon-only in the menubar; title is noisy on macOS
	systray.SetTooltip("finch — local services, published")

	header := systray.AddMenuItem("finch", "")
	header.Disable()
	cfgItem := systray.AddMenuItem("manifest: "+configPath, configPath)
	cfgItem.Disable()
	systray.AddSeparator()

	// One row per appliance in the manifest, created up-front so the menu has
	// shape before the first relay connects. A bad/missing manifest leaves just
	// the controls, with the error surfaced on the toggle row.
	appErr := ""
	for _, app := range readAppPaths(configPath) {
		it := systray.AddMenuItem("• "+app+" — idle", app)
		it.Disable()
		items[app] = it
	}
	if len(items) == 0 {
		appErr = "no appliances in " + configPath
	}
	systray.AddSeparator()

	toggle := systray.AddMenuItem("Start relay", "Connect every appliance in the manifest")
	if appErr != "" {
		toggle.SetTitle(appErr)
		toggle.Disable()
	}
	openDash := systray.AddMenuItem("Open dashboard", "Open the finch dashboard in your browser")
	quit := systray.AddMenuItem("Quit", "Stop relays and quit")

	go func() {
		for {
			select {
			case <-toggle.ClickedCh:
				if cancel == nil {
					startRelays(toggle)
				} else {
					stopRelays(toggle)
				}
			case <-openDash.ClickedCh:
				openBrowser(dashboardURL())
			case <-quit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}

func onExit() {
	stopRelays(nil)
}

// startRelays launches core.RunConfig in the background, streaming per-appliance
// status into the menu rows. The toggle flips to a Stop control.
func startRelays(toggle *systray.MenuItem) {
	ctx, c := context.WithCancel(context.Background())
	cancel = c
	toggle.SetTitle("Stop relay")
	setSummary("connecting…")

	runWG.Add(1)
	go func() {
		defer runWG.Done()
		err := core.RunConfig(ctx, configPath, onStatus)
		if err != nil {
			setSummary("error: " + err.Error())
		}
	}()
}

// stopRelays cancels the run and waits for the relays to wind down. Safe to call
// with a nil toggle (from onExit) and when nothing is running.
func stopRelays(toggle *systray.MenuItem) {
	if cancel != nil {
		cancel()
		cancel = nil
		runWG.Wait()
	}
	if toggle != nil {
		toggle.SetTitle("Start relay")
	}
	mu.Lock()
	for app, it := range items {
		it.SetTitle("• " + app + " — idle")
		lastState[app] = "idle"
	}
	mu.Unlock()
	systray.SetTooltip("finch — stopped")
}

// onStatus is core.RunConfig's per-appliance callback (invoked on relay
// goroutines). It updates that appliance's menu row and the tray tooltip summary.
func onStatus(appPath, state, detail string) {
	mu.Lock()
	lastState[appPath] = state
	it := items[appPath]
	mu.Unlock()
	title := "• " + appPath + " — " + prettyState(state)
	if detail != "" && (state == "reconnecting" || state == "error" || state == "warn") {
		title += " (" + truncate(detail, 40) + ")"
	}
	if it != nil {
		it.SetTitle(title)
	}
	setSummary("")
}

// setSummary refreshes the tooltip with a live count of connected appliances, or
// a one-off message when non-empty.
func setSummary(msg string) {
	if msg != "" {
		systray.SetTooltip("finch — " + msg)
		return
	}
	mu.Lock()
	live, total := 0, len(items)
	for _, s := range lastState {
		if s == "connected" || s == "live" {
			live++
		}
	}
	mu.Unlock()
	systray.SetTooltip(fmt.Sprintf("finch — %d/%d appliances live", live, total))
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

// dashboardURL prefers the -hub flag, then the manifest's hub, then prod.
func dashboardURL() string {
	if hubURL != "" {
		return hubURL
	}
	if h := readHub(configPath); h != "" {
		return h
	}
	return "https://finchmcp.com"
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

// sortedAppPaths is a small helper kept for a stable menu order in readAppPaths.
func sortedAppPaths(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
