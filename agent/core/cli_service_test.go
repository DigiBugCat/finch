package core

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeServiceManager answers exactly the service-manager commands a platform
// should issue and fails the test on anything else, recording the order.
type fakeServiceManager struct {
	t       *testing.T
	calls   []string
	running bool
	linger  string
	failOn  string
	// bootstrapFailures makes the next N launchctl bootstraps fail the way
	// launchd does while a booted-out job is still being torn down.
	bootstrapFailures int
	// neverStarts makes bootstrap/restart succeed without the serve ever
	// reaching running (finch run crashing on start).
	neverStarts bool
	// onStart is what the started `finch run` does; nil stands in for a serve
	// whose relays all connect (it reports "notes" connected).
	onStart func()
}

// start is the service manager starting `finch run`.
func (m *fakeServiceManager) start(t *testing.T) {
	m.running = !m.neverStarts
	if !m.running {
		return
	}
	if m.onStart != nil {
		m.onStart()
		return
	}
	home, _ := os.UserHomeDir()
	b, _ := json.Marshal(serveReport{PID: 42, Started: time.Now().UnixNano(), Relays: map[string]relayStatus{
		"notes": {State: relayConnected, Upstream: "http://127.0.0.1:8000"},
	}})
	if err := writeCredentialFile(runStatusPath(filepath.Join(home, ".finch")), b); err != nil {
		t.Error(err)
	}
}

func (m *fakeServiceManager) install(t *testing.T, goos string) {
	serviceGOOS = goos
	runServiceCommand = func(name string, args ...string) (string, error) {
		cmd := name + " " + strings.Join(args, " ")
		m.calls = append(m.calls, cmd)
		if m.failOn != "" && cmd == m.failOn {
			return "Failed to connect to bus", fmt.Errorf("exit status 1")
		}
		uid := strconv.Itoa(os.Getuid())
		switch cmd {
		case "launchctl print gui/" + uid + "/" + launchdLabel:
			if m.running {
				return "gui/" + uid + "/com.finchmcp.finch = {\n\tstate = running\n\tpid = 42\n}", nil
			}
			return "Could not find service", fmt.Errorf("exit status 113")
		case "launchctl bootout gui/" + uid + "/" + launchdLabel:
			m.running = false
			return "", nil
		case "launchctl enable gui/" + uid + "/" + launchdLabel:
			return "", nil
		case "launchctl bootstrap gui/" + uid + " " + launchdPlistPath():
			if _, err := os.Stat(launchdPlistPath()); err != nil {
				t.Errorf("bootstrap before the plist was written")
			}
			if m.bootstrapFailures > 0 {
				m.bootstrapFailures--
				return "Bootstrap failed: 5: Input/output error", fmt.Errorf("exit status 5")
			}
			m.start(t)
			return "", nil
		case "systemctl --user is-active finch.service":
			if m.running {
				return "active\n", nil
			}
			return "inactive\n", fmt.Errorf("exit status 3")
		case "systemctl --user daemon-reload", "systemctl --user enable finch.service":
			return "", nil
		case "systemctl --user restart finch.service":
			if _, err := os.Stat(systemdUnitPath()); err != nil {
				t.Errorf("restart before the unit was written")
			}
			m.start(t)
			return "", nil
		case "systemctl --user disable --now finch.service":
			m.running = false
			return "", nil
		case "loginctl show-user " + currentUsername() + " --property=Linger --value":
			return m.linger + "\n", nil
		}
		t.Errorf("unexpected service-manager command: %s", cmd)
		return "", fmt.Errorf("unexpected command")
	}
}

func writeManifest(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("hub: https://finchmcp.com\nbox: testbox\ningress:\n  - app_path: notes\n    service: http://127.0.0.1:8000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestServiceInstallLaunchd(t *testing.T) {
	home := isolate(t)
	manifest := filepath.Join(home, ".finch", "finch.yml")
	writeManifest(t, manifest)
	m := &fakeServiceManager{t: t}
	m.install(t, "darwin")

	for i := 0; i < 2; i++ { // idempotent: a second install rewrites + reloads
		stdout, stderr, code := finch(t, "service", "install", "--json")
		if code != 0 {
			t.Fatalf("install #%d exit=%d stderr=%q", i+1, code, stderr)
		}
		got := decodeJSONOut(t, stdout)
		plist := filepath.Join(home, "Library", "LaunchAgents", "com.finchmcp.finch.plist")
		if got["installed"] != true || got["running"] != true || got["manager"] != "launchd" || got["unit"] != plist || got["config"] != manifest {
			t.Fatalf("install payload=%v", got)
		}
	}
	plist := mustRead(t, launchdPlistPath())
	for _, want := range []string{
		"<string>com.finchmcp.finch</string>",
		"<string>/opt/finch/bin/finch</string>\n\t\t<string>run</string>\n\t\t<string>--config</string>\n\t\t<string>" + manifest + "</string>",
		"<key>RunAtLoad</key>\n\t<true/>",
		"<key>KeepAlive</key>\n\t<true/>",
		"<string>" + filepath.Join(home, ".finch", "finch.log") + "</string>",
		// Not Background: the serve sits on the path of every relayed call.
		"<key>ProcessType</key>\n\t<string>Standard</string>",
		"<key>FINCH_LOG_FILE</key>\n\t\t<string>" + filepath.Join(home, ".finch", "finch.log") + "</string>",
	} {
		if !strings.Contains(plist, want) {
			t.Fatalf("plist lacks %q:\n%s", want, plist)
		}
	}
	if path, err := exec.LookPath("plutil"); err == nil {
		if out, err := exec.Command(path, "-lint", launchdPlistPath()).CombinedOutput(); err != nil {
			t.Fatalf("plutil rejects the plist: %s", out)
		}
	}

	stdout, _, code := finch(t, "service", "status", "--json")
	if got := decodeJSONOut(t, stdout); code != 0 || got["installed"] != true || got["running"] != true {
		t.Fatalf("status=%v exit=%d", got, code)
	}

	stdout, _, code = finch(t, "service", "uninstall", "--json")
	if got := decodeJSONOut(t, stdout); code != 0 || got["removed"] != true || got["installed"] != false || got["running"] != false {
		t.Fatalf("uninstall=%v exit=%d", got, code)
	}
	stdout, _, code = finch(t, "service", "uninstall", "--json")
	if got := decodeJSONOut(t, stdout); code != 0 || got["removed"] != false {
		t.Fatalf("second uninstall=%v exit=%d", got, code)
	}
}

func TestLaunchdPlistEscapesPaths(t *testing.T) {
	plist := string(launchdPlist("/Apps/a&b/finch", "/x/<y>/finch.yml", "/x/<y>", "/l/o\"g"))
	if strings.Contains(plist, "a&b") || !strings.Contains(plist, "a&amp;b") || !strings.Contains(plist, "&lt;y&gt;") {
		t.Fatalf("plist did not escape paths:\n%s", plist)
	}
	if path, err := exec.LookPath("plutil"); err == nil {
		f := filepath.Join(t.TempDir(), "x.plist")
		if err := os.WriteFile(f, []byte(plist), 0o644); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command(path, "-lint", f).CombinedOutput(); err != nil {
			t.Fatalf("plutil rejects an escaped plist: %s", out)
		}
	}
}

func TestServiceInstallSystemd(t *testing.T) {
	home := isolate(t)
	xdg := filepath.Join(home, "xdg")
	t.Setenv("XDG_CONFIG_HOME", xdg)
	manifest := filepath.Join(home, "proj 1", "finch.yml")
	writeManifest(t, manifest)
	m := &fakeServiceManager{t: t, linger: "no"}
	m.install(t, "linux")

	stdout, stderr, code := finch(t, "service", "install", "--config", manifest, "--json")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	got := decodeJSONOut(t, stdout)
	unitPath := filepath.Join(xdg, "systemd", "user", "finch.service")
	notes, _ := got["notes"].([]any)
	if got["unit"] != unitPath || got["running"] != true || got["linger"] != false || len(notes) != 1 || !strings.Contains(fmt.Sprint(notes[0]), "loginctl enable-linger") {
		t.Fatalf("payload=%v", got)
	}
	wantOrder := []string{"systemctl --user daemon-reload", "systemctl --user enable finch.service", "systemctl --user restart finch.service"}
	var mutations []string
	for _, c := range m.calls {
		if !strings.Contains(c, "is-active") && !strings.HasPrefix(c, "loginctl") {
			mutations = append(mutations, c)
		}
	}
	if strings.Join(mutations, "|") != strings.Join(wantOrder, "|") {
		t.Fatalf("systemctl calls=%v, want %v", mutations, wantOrder)
	}
	unit := mustRead(t, unitPath)
	for _, want := range []string{
		`ExecStart="/opt/finch/bin/finch" "run" "--config" "` + manifest + `"`,
		"WorkingDirectory=" + filepath.Dir(manifest),
		"Restart=always",
		"WantedBy=default.target",
	} {
		if !strings.Contains(unit, want) {
			t.Fatalf("unit lacks %q:\n%s", want, unit)
		}
	}

	// With lingering enabled there is nothing to warn about.
	m.linger = "yes"
	stdout, _, _ = finch(t, "service", "install", "--config", manifest, "--json")
	if got := decodeJSONOut(t, stdout); got["linger"] != true || got["notes"] != nil {
		t.Fatalf("linger payload=%v", got)
	}

	stdout, _, code = finch(t, "service", "uninstall", "--json")
	if got := decodeJSONOut(t, stdout); code != 0 || got["removed"] != true {
		t.Fatalf("uninstall=%v", got)
	}
	if _, err := os.Stat(unitPath); !os.IsNotExist(err) {
		t.Fatal("unit file survived uninstall")
	}
}

func TestSystemdQuote(t *testing.T) {
	for in, want := range map[string]string{
		"/usr/bin/finch":  `"/usr/bin/finch"`,
		`/a b/"q"`:        `"/a b/\"q\""`,
		`/p/100%/$HOME\x`: `"/p/100%%/$$HOME\\x"`,
		"--config":        `"--config"`,
	} {
		if got := systemdQuote(in); got != want {
			t.Errorf("systemdQuote(%q)=%s, want %s", in, got, want)
		}
	}
}

func TestServiceInstallFailures(t *testing.T) {
	t.Run("nothing to serve", func(t *testing.T) {
		isolate(t)
		(&fakeServiceManager{t: t}).install(t, "darwin")
		_, stderr, code := finch(t, "service", "install", "--json")
		env := decodeJSONError(t, stderr)
		if code != 1 || env.Error.Code != "NOT_FOUND" || env.Error.Next != "finch add <name> --service <url>" {
			t.Fatalf("exit=%d env=%+v", code, env)
		}
		if _, err := os.Stat(launchdPlistPath()); !os.IsNotExist(err) {
			t.Fatal("a plist was written with nothing to serve")
		}
	})
	t.Run("no systemd user session", func(t *testing.T) {
		home := isolate(t)
		writeManifest(t, filepath.Join(home, ".finch", "finch.yml"))
		m := &fakeServiceManager{t: t, failOn: "systemctl --user daemon-reload"}
		m.install(t, "linux")
		_, stderr, code := finch(t, "service", "install", "--json")
		if env := decodeJSONError(t, stderr); code != 1 || env.Error.Code != "INTERNAL" || !strings.Contains(env.Error.Message, "daemon-reload") {
			t.Fatalf("exit=%d stderr=%q", code, stderr)
		}
	})
	t.Run("launchd bootstrap retries a transient failure", func(t *testing.T) {
		home := isolate(t)
		writeManifest(t, filepath.Join(home, ".finch", "finch.yml"))
		m := &fakeServiceManager{t: t, bootstrapFailures: 2}
		m.install(t, "darwin")
		stdout, stderr, code := finch(t, "service", "install", "--json")
		if code != 0 || decodeJSONOut(t, stdout)["running"] != true {
			t.Fatalf("exit=%d stderr=%q", code, stderr)
		}
		m.bootstrapFailures = 99
		_, stderr, code = finch(t, "service", "install", "--json")
		if code != 1 || !strings.Contains(decodeJSONError(t, stderr).Error.Message, "Input/output error") {
			t.Fatalf("persistent bootstrap failure: exit=%d stderr=%q", code, stderr)
		}
	})
	t.Run("go run binary", func(t *testing.T) {
		home := isolate(t)
		writeManifest(t, filepath.Join(home, ".finch", "finch.yml"))
		(&fakeServiceManager{t: t}).install(t, "darwin")
		serviceExecutable = func() (string, error) { return "/tmp/go-build123/b001/exe/finch", nil }
		_, stderr, code := finch(t, "service", "install", "--json")
		if code != 1 || decodeJSONError(t, stderr).Error.Code != "INTERNAL" {
			t.Fatalf("exit=%d stderr=%q", code, stderr)
		}
	})
	t.Run("unknown action", func(t *testing.T) {
		isolate(t)
		_, stderr, code := finch(t, "service", "restart", "--json")
		if code != 2 || decodeJSONError(t, stderr).Error.Code != "USAGE" {
			t.Fatalf("exit=%d stderr=%q", code, stderr)
		}
	})
}

// install must not report success for an endpoint that is not serving: the
// unit stays (the manager keeps retrying it) but the command fails.
func TestServiceInstallFailsWhenTheServeNeverRuns(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		t.Run(goos, func(t *testing.T) {
			home := isolate(t)
			writeManifest(t, filepath.Join(home, ".finch", "finch.yml"))
			m := &fakeServiceManager{t: t, neverStarts: true, linger: "yes"}
			m.install(t, goos)
			stdout, stderr, code := finch(t, "service", "install", "--json")
			env := decodeJSONError(t, stderr)
			if code != 1 || stdout != "" || env.Error.Code != "INTERNAL" || env.Error.Next != "finch service status" || !strings.Contains(env.Error.Message, "not running") {
				t.Fatalf("exit=%d stdout=%q env=%+v", code, stdout, env)
			}
			unit := launchdPlistPath()
			if goos == "linux" {
				unit = systemdUnitPath()
			}
			if !fileExists(unit) {
				t.Fatal("the unit was removed; the manager should keep retrying it")
			}
			_, perr, pcode := finch(t, "service", "install")
			if pcode != 1 || !strings.Contains(perr, "not running") {
				t.Fatalf("plain mode: exit=%d stderr=%q", pcode, perr)
			}
		})
	}
}

// uninstall must not delete the unit (the only handle that stops the serve)
// and report success while the serve is still up. A stop that fails only
// because nothing was loaded is fine.
func TestServiceUninstallKeepsTheUnitWhenStopFails(t *testing.T) {
	uid := strconv.Itoa(os.Getuid())
	for _, tc := range []struct{ goos, stop string }{
		{"darwin", "launchctl bootout gui/" + uid + "/" + launchdLabel},
		{"linux", "systemctl --user disable --now finch.service"},
	} {
		t.Run(tc.goos, func(t *testing.T) {
			home := isolate(t)
			writeManifest(t, filepath.Join(home, ".finch", "finch.yml"))
			m := &fakeServiceManager{t: t, linger: "yes"}
			m.install(t, tc.goos)
			if _, stderr, code := finch(t, "service", "install", "--json"); code != 0 {
				t.Fatalf("install: exit=%d stderr=%q", code, stderr)
			}
			unit := launchdPlistPath()
			if tc.goos == "linux" {
				unit = systemdUnitPath()
			}

			m.failOn = tc.stop // fails and leaves the serve running
			stdout, stderr, code := finch(t, "service", "uninstall", "--json")
			env := decodeJSONError(t, stderr)
			if code != 1 || stdout != "" || env.Error.Code != "INTERNAL" || !strings.Contains(env.Error.Message, "still running") {
				t.Fatalf("exit=%d stdout=%q env=%+v", code, stdout, env)
			}
			if !fileExists(unit) {
				t.Fatal("the unit was removed while finch was still running")
			}

			// Not loaded at all: the stop error is the harmless kind.
			m.running = false
			stdout, stderr, code = finch(t, "service", "uninstall", "--json")
			if got := decodeJSONOut(t, stdout); code != 0 || got["removed"] != true {
				t.Fatalf("exit=%d stdout=%q stderr=%q", code, stdout, stderr)
			}
			if fileExists(unit) {
				t.Fatal("unit survived an uninstall of a stopped service")
			}
		})
	}
}

func TestRotateServiceLog(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "finch.log")
	write := func(p, s string) {
		t.Helper()
		if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// Under the cap, unset, or relative: nothing happens.
	write(log, "small\n")
	for _, p := range []string{log, "", "finch.log"} {
		if f := rotateServiceLog(p, 100); f != nil {
			t.Fatalf("rotated %q under the cap", p)
		}
	}
	if mustRead(t, log) != "small\n" || fileExists(log+".1") {
		t.Fatal("an under-cap log was touched")
	}

	// Over the cap: the log becomes .1 (replacing an older .1) and a fresh,
	// appendable log is returned.
	write(log+".1", "older\n")
	write(log, strings.Repeat("x", 101))
	f := rotateServiceLog(log, 100)
	if f == nil {
		t.Fatal("an over-cap log was not rotated")
	}
	defer f.Close()
	if _, err := f.WriteString("fresh\n"); err != nil {
		t.Fatal(err)
	}
	if mustRead(t, log+".1") != strings.Repeat("x", 101) || mustRead(t, log) != "fresh\n" {
		t.Fatalf("after rotation: log=%q .1=%q", mustRead(t, log), mustRead(t, log+".1"))
	}
	if got := fileMode(t, log); got != 0o600 {
		t.Fatalf("fresh log mode=%04o", got)
	}

	// A symlinked log is left alone rather than renamed out from under the link.
	link := filepath.Join(dir, "linked.log")
	if err := os.Symlink(log+".1", link); err != nil {
		t.Fatal(err)
	}
	if f := rotateServiceLog(link, 100); f != nil {
		t.Fatal("rotated a symlink")
	}
}

// `finch update` restarts the installed finch.service even when it is stopped
// at that moment (--restart=service, or it stopped mid-update); the legacy
// finch-tunnel.service only when finch.service is not installed.
func TestRestartManagedServicePicksTheInstalledUnit(t *testing.T) {
	home := isolate(t)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg"))
	var calls []string
	serviceGOOS = "linux"
	runServiceCommand = func(name string, args ...string) (string, error) {
		cmd := name + " " + strings.Join(args, " ")
		calls = append(calls, cmd)
		if strings.Contains(cmd, "is-active") {
			return "inactive\n", fmt.Errorf("exit status 3")
		}
		return "", nil
	}
	if err := restartManagedService(); err != nil {
		t.Fatal(err)
	}
	if got := calls[len(calls)-1]; got != "systemctl --user restart finch-tunnel.service" {
		t.Fatalf("no finch.service installed: restarted %q, want the legacy unit", got)
	}

	if err := os.MkdirAll(filepath.Dir(systemdUnitPath()), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(systemdUnitPath(), systemdUnit("/opt/finch/bin/finch", "/x/finch.yml", "/x"), 0o644); err != nil {
		t.Fatal(err)
	}
	calls = nil
	if err := restartManagedService(); err != nil {
		t.Fatal(err)
	}
	if got := calls[len(calls)-1]; got != "systemctl --user restart finch.service" {
		t.Fatalf("finch.service installed but inactive: restarted %q, want finch.service", got)
	}
}

func TestResolveUpdateRestartModeUsesManagedService(t *testing.T) {
	isolate(t)
	m := &fakeServiceManager{t: t, running: true}
	m.install(t, "darwin")
	if !managedServeRunning() {
		t.Fatal("a running LaunchAgent must count as a managed serve")
	}
	if mode, _ := resolveUpdateRestartMode("auto", managedServeRunning(), false); mode != "service" {
		t.Fatalf("mode=%s, want service", mode)
	}
}

// serveAgainst makes the fake service manager start a real config serve (the
// relays `finch run` runs) against the fake hub, and waits for real between
// readiness checks (40 × 50ms), so install sees the serve's own report.
func serveAgainst(t *testing.T, m *fakeServiceManager, manifest string) {
	t.Helper()
	serviceSleep = func(time.Duration) { time.Sleep(50 * time.Millisecond) }
	ctx, cancel := context.WithCancel(context.Background())
	var done chan struct{}
	m.onStart = func() {
		hostName, _ := os.Hostname()
		cfg, err := loadConfig(manifest, hostName)
		if err != nil {
			t.Error(err)
			return
		}
		done = make(chan struct{})
		go func() {
			defer close(done)
			_ = serveConfig(ctx, cfg)
		}()
	}
	t.Cleanup(func() {
		cancel()
		if done != nil {
			<-done
		}
	})
}

func writeHubManifest(t *testing.T, path, hub string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("hub: "+hub+"\nbox: testbox\ningress:\n  - app_path: notes\n    service: http://127.0.0.1:8000\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// A live `finch run` is not a live endpoint: install waits for the serve to
// report every relay connected, and fails (keeping the unit) when a relay's
// credential is rejected or the relay never connects.
func TestServiceInstallWaitsForTheRelays(t *testing.T) {
	setup := func(t *testing.T, refreshToken string) (*fakeHub, *fakeServiceManager, string) {
		home := isolate(t)
		h := newFakeHub(t)
		h.set(func(h *fakeHub) { h.services["notes"] = "key" })
		manifest := filepath.Join(home, ".finch", "finch.yml")
		writeHubManifest(t, manifest, h.url())
		if err := saveState(filepath.Join(home, ".finch", "notes.json"), &agentState{Hub: h.url(), RefreshToken: refreshToken}); err != nil {
			t.Fatal(err)
		}
		m := &fakeServiceManager{t: t, linger: "yes"}
		m.install(t, "darwin")
		serveAgainst(t, m, manifest)
		return h, m, home
	}

	t.Run("connected", func(t *testing.T) {
		setup(t, "rt_notes")
		stdout, stderr, code := finch(t, "service", "install", "--json")
		if code != 0 {
			t.Fatalf("exit=%d stderr=%q", code, stderr)
		}
		got := decodeJSONOut(t, stdout)
		relays, _ := got["relays"].(map[string]any)
		notes, _ := relays["notes"].(map[string]any)
		if got["running"] != true || notes["state"] != "connected" || len(relays) != 1 {
			t.Fatalf("payload=%v", got)
		}
	})

	t.Run("credential rejected", func(t *testing.T) {
		_, _, home := setup(t, "rt_revoked")
		stdout, stderr, code := finch(t, "service", "install", "--json")
		env := decodeJSONError(t, stderr)
		if code != 1 || stdout != "" || env.Error.Code != "INTERNAL" || env.Error.Next != "finch add notes --service http://127.0.0.1:8000" ||
			!strings.Contains(env.Error.Message, "notes is not connected: saved credential rejected: hub returned HTTP 403") {
			t.Fatalf("exit=%d env=%+v", code, env)
		}
		if !fileExists(launchdPlistPath()) {
			t.Fatal("the unit was removed; it should stay installed")
		}
		if !fileExists(runStatusPath(filepath.Join(home, ".finch"))) {
			t.Fatal("the serve's status file is missing")
		}
	})

	t.Run("relay never connects", func(t *testing.T) {
		h, _, _ := setup(t, "rt_notes")
		h.set(func(h *fakeHub) { h.relayDown = true })
		_, stderr, code := finch(t, "service", "install", "--json")
		env := decodeJSONError(t, stderr)
		if code != 1 || env.Error.Code != "INTERNAL" || env.Error.Next != "finch service status" ||
			!strings.Contains(env.Error.Message, "not connected after 20s: notes (reconnecting: Finch relay dial failed (HTTP 502))") {
			t.Fatalf("exit=%d env=%+v", code, env)
		}
		if !fileExists(launchdPlistPath()) {
			t.Fatal("the unit was removed; it should stay installed")
		}
	})

	t.Run("an earlier run's report is ignored", func(t *testing.T) {
		home := isolate(t)
		writeManifest(t, filepath.Join(home, ".finch", "finch.yml"))
		b, _ := json.Marshal(serveReport{PID: 7, Started: time.Now().Add(-time.Hour).UnixNano(), Relays: map[string]relayStatus{"notes": {State: relayConnected}}})
		if err := writeCredentialFile(runStatusPath(filepath.Join(home, ".finch")), b); err != nil {
			t.Fatal(err)
		}
		m := &fakeServiceManager{t: t}
		m.install(t, "darwin")
		m.onStart = func() {} // running, but never reports
		_, stderr, code := finch(t, "service", "install", "--json")
		if env := decodeJSONError(t, stderr); code != 1 || !strings.Contains(env.Error.Message, "has not reported its relays") {
			t.Fatalf("exit=%d env=%+v", code, env)
		}
	})
}

// The serve removes its status file on a clean shutdown.
func TestServeConfigRemovesItsStatusOnShutdown(t *testing.T) {
	isolate(t)
	h := newFakeHub(t)
	h.set(func(h *fakeHub) { h.services["notes"] = "key" })
	dir := t.TempDir()
	cfg := &config{Hub: h.url(), Box: "testbox", CredentialsDir: dir, Ingress: []ingress{{AppPath: "notes", Service: "http://127.0.0.1:8000"}}}
	if err := saveState(cfg.statePathFor("notes"), &agentState{Hub: h.url(), RefreshToken: "rt_notes"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serveConfig(ctx, cfg) }()
	path := runStatusPath(dir)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if st := readRunStatus(path); st != nil && st.Relays["notes"].State == relayConnected {
			if st.PID != os.Getpid() || st.Relays["notes"].Upstream != "http://127.0.0.1:8000" {
				t.Fatalf("status=%+v", st)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the relay never reported connected: %+v", readRunStatus(path))
		}
		time.Sleep(20 * time.Millisecond)
	}
	if m := fileMode(t, path); m != 0o600 {
		t.Fatalf("status file mode=%04o", m)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if fileExists(path) {
		t.Fatal("the status file outlived the serve")
	}
}
