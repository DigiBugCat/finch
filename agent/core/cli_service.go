package core

// `finch service install|uninstall|status`: run `finch run` as a login service
// so a published endpoint survives the terminal closing and the machine
// rebooting — a launchd LaunchAgent on macOS, a systemd --user unit on Linux.
// Both are per-user (no root, no sudo) and restart the serve if it exits.
//
// install is idempotent: it rewrites the unit and reloads it, so running it
// again after `finch add` or a binary move is safe. The unit pins
// `finch run --config <absolute finch.yml>` so the service serves the same
// manifest `finch add` wrote, whatever directory it was run from.

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	launchdLabel    = "com.finchmcp.finch"
	systemdUnitName = "finch.service"
	// legacySystemdUnit is the hand-written unit older docs suggested; `finch
	// update` still restarts it if that is what manages the serve.
	legacySystemdUnit = "finch-tunnel.service"
)

// Swapped by tests: the platform, the service-manager command runner, the
// binary the unit should launch, and the wait between status checks.
var (
	serviceGOOS       = runtime.GOOS
	runServiceCommand = func(name string, args ...string) (string, error) {
		out, err := exec.Command(name, args...).CombinedOutput()
		return string(out), err
	}
	serviceExecutable = os.Executable
	serviceSleep      = time.Sleep
)

type serviceStatus struct {
	Manager   string // "launchd" | "systemd" | "" (unsupported platform)
	Unit      string // plist / unit file path
	Installed bool
	Running   bool
}

func (s serviceStatus) payload() map[string]any {
	return map[string]any{"manager": s.Manager, "unit": s.Unit, "installed": s.Installed, "running": s.Running}
}

func (s serviceStatus) describe() string {
	switch {
	case s.Running:
		return "installed, running"
	case s.Installed:
		return "installed, NOT running — check the log, then `finch service install` again"
	default:
		return "not installed — `finch service install`"
	}
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	return "."
}

func launchdPlistPath() string {
	return filepath.Join(homeDir(), "Library", "LaunchAgents", launchdLabel+".plist")
}

func launchdTarget() string { return "gui/" + strconv.Itoa(os.Getuid()) + "/" + launchdLabel }

func systemdUnitPath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" || !filepath.IsAbs(base) {
		base = filepath.Join(homeDir(), ".config")
	}
	return filepath.Join(base, "systemd", "user", systemdUnitName)
}

func serviceLogPath() string { return filepath.Join(finchHome(), "finch.log") }

// serviceLogEnv names the log file launchd appends `finch run`'s output to.
// The LaunchAgent sets it so the serve can keep that file bounded.
const serviceLogEnv = "FINCH_LOG_FILE"

// maxServiceLogBytes caps finch.log: launchd never rotates StandardOutPath, and
// a crash-looping service (KeepAlive, every ThrottleInterval) appends forever.
const maxServiceLogBytes = 10 << 20

// rotateServiceLog runs as `finch run` starts under the LaunchAgent. When the
// log has grown past max it becomes <log>.1 (replacing the previous one) and a
// fresh log is opened for this process's output, so the file stays bounded at
// about twice max across restarts. It returns the fresh log, or nil when
// nothing was rotated or the fresh log could not be opened.
func rotateServiceLog(path string, max int64) *os.File {
	if path == "" || !filepath.IsAbs(path) {
		return nil
	}
	st, err := os.Lstat(path)
	if err != nil || !st.Mode().IsRegular() || st.Size() <= max {
		return nil
	}
	if err := os.Rename(path, path+".1"); err != nil {
		return nil
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil
	}
	return f
}

// rotateServiceLogAtStart moves this process's Go-level output (os.Stdout,
// os.Stderr, the log package) to a freshly rotated service log. launchd's own
// file descriptors keep pointing at <log>.1 until the next start.
func rotateServiceLogAtStart() {
	path := os.Getenv(serviceLogEnv)
	if f := rotateServiceLog(path, maxServiceLogBytes); f != nil {
		os.Stdout, os.Stderr = f, f
		log.SetOutput(f)
		log.Printf("finch: rotated %s (over %d MiB) to %s.1", path, maxServiceLogBytes>>20, path)
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// currentServiceStatus inspects the installed unit and asks the service
// manager whether it is running. It never fails: an unreachable manager simply
// reads as not running.
func currentServiceStatus() serviceStatus {
	switch serviceGOOS {
	case "darwin":
		s := serviceStatus{Manager: "launchd", Unit: launchdPlistPath()}
		s.Installed = fileExists(s.Unit)
		if out, err := runServiceCommand("launchctl", "print", launchdTarget()); err == nil {
			s.Running = strings.Contains(out, "state = running")
		}
		return s
	case "linux":
		s := serviceStatus{Manager: "systemd", Unit: systemdUnitPath()}
		s.Installed = fileExists(s.Unit)
		out, _ := runServiceCommand("systemctl", "--user", "is-active", systemdUnitName)
		s.Running = strings.TrimSpace(out) == "active"
		return s
	default:
		return serviceStatus{}
	}
}

// serviceStillUp reports whether the service manager still has the finch unit
// loaded or running, after a stop that reported an error. On macOS a loaded job
// counts even between KeepAlive restarts, since launchd would start it again.
func serviceStillUp() bool {
	switch serviceGOOS {
	case "darwin":
		_, err := runServiceCommand("launchctl", "print", launchdTarget())
		return err == nil
	case "linux":
		out, _ := runServiceCommand("systemctl", "--user", "is-active", systemdUnitName)
		switch strings.TrimSpace(out) {
		case "active", "activating", "reloading", "deactivating":
			return true
		}
	}
	return false
}

// managedServeRunning reports whether a service manager runs the serve — the
// `finch service` unit, or the legacy finch-tunnel unit — for `finch update`.
func managedServeRunning() bool {
	if currentServiceStatus().Running {
		return true
	}
	return serviceGOOS == "linux" && legacyTunnelActive()
}

func legacyTunnelActive() bool {
	out, _ := runServiceCommand("systemctl", "--user", "is-active", legacySystemdUnit)
	return strings.TrimSpace(out) == "active"
}

// restartManagedService restarts the managed serve through its manager: the
// old process stops before the new one starts, so the hub never sees two. On
// Linux the installed finch.service is the one restarted (which also starts it
// when it is stopped); the legacy finch-tunnel.service only when finch.service
// is not installed.
func restartManagedService() error {
	var out string
	var err error
	switch {
	case serviceGOOS == "darwin":
		out, err = runServiceCommand("launchctl", "kickstart", "-k", launchdTarget())
	case fileExists(systemdUnitPath()):
		out, err = runServiceCommand("systemctl", "--user", "restart", systemdUnitName)
	default:
		out, err = runServiceCommand("systemctl", "--user", "restart", legacySystemdUnit)
	}
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(out))
	}
	return nil
}

// runService: finch service install|uninstall|status [--config finch.yml] [--json]
func runService(c *cli, args []string) error {
	fs := newFlagSet("service")
	configPath := fs.String("config", "", "finch.yml the service serves (default: the one `finch add` wrote)")
	fs.Bool("json", false, "JSON output")
	pos, err := c.parseArgs(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usageError("usage: finch service install|uninstall|status")
	}
	if serviceGOOS != "darwin" && serviceGOOS != "linux" {
		return newCLIError(codeInternal, "finch run", "finch service supports macOS (launchd) and Linux (systemd); run 'finch run' under your own supervisor")
	}
	switch pos[0] {
	case "install":
		return serviceInstall(c, *configPath)
	case "uninstall":
		if *configPath != "" {
			return usageError("service uninstall takes no --config")
		}
		return serviceUninstall(c)
	case "status":
		if *configPath != "" {
			return usageError("service status takes no --config")
		}
		s := currentServiceStatus()
		if c.json {
			return c.emit(s.payload())
		}
		c.printf("finch service (%s): %s\n  unit: %s\n  log:  %s\n", s.Manager, s.describe(), s.Unit, s.logHint())
		return nil
	default:
		return usageError("usage: finch service install|uninstall|status")
	}
}

func (s serviceStatus) logHint() string {
	if s.Manager == "systemd" {
		return "journalctl --user -u " + systemdUnitName
	}
	return serviceLogPath()
}

// serviceManifest resolves the absolute finch.yml the unit will serve and
// checks it loads, so the service never starts on a manifest `finch run` rejects.
func serviceManifest(configPath string) (string, error) {
	if configPath == "" {
		configPath = findManifest()
	}
	if configPath == "" {
		return "", newCLIError(codeNotFound, "finch add <name> --service <url>", "nothing to serve yet — no finch.yml (./finch.yml, ~/.finch/finch.yml, ~/.config/finch/finch.yml)")
	}
	abs, err := filepath.Abs(expandHome(configPath))
	if err != nil {
		return "", newCLIError(codeInternal, "", "resolving %s: %v", configPath, err)
	}
	hostName, _ := os.Hostname()
	cfg, err := loadConfig(abs, hostName)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", newCLIError(codeNotFound, "finch add <name> --service <url>", "%v", err)
		}
		return "", newCLIError(codeUsage, "", "%v", err)
	}
	if len(cfg.Ingress) == 0 {
		return "", newCLIError(codeNotFound, "finch add <name> --service <url>", "%s has no ingress rules to serve", abs)
	}
	return abs, nil
}

func serviceBinary() (string, error) {
	bin, err := serviceExecutable()
	if err != nil {
		return "", newCLIError(codeInternal, "", "cannot locate the finch binary: %v", err)
	}
	if !filepath.IsAbs(bin) {
		if bin, err = filepath.Abs(bin); err != nil {
			return "", newCLIError(codeInternal, "", "cannot locate the finch binary: %v", err)
		}
	}
	if strings.Contains(bin, string(filepath.Separator)+"go-build") {
		return "", newCLIError(codeInternal, "curl -fsSL https://finchmcp.com/install | sh", "this finch is a temporary 'go run' build; install finch before installing the service")
	}
	return bin, nil
}

func serviceInstall(c *cli, configPath string) error {
	manifest, err := serviceManifest(configPath)
	if err != nil {
		return err
	}
	bin, err := serviceBinary()
	if err != nil {
		return err
	}
	for _, p := range []string{bin, manifest} {
		if strings.ContainsAny(p, "\n\r\x00") {
			return newCLIError(codeUsage, "", "path %q cannot be written into a service unit", p)
		}
	}
	before := currentServiceStatus()
	notes := []string{}
	// A foreground `finch run` holds the box's serve lock; the service would
	// only crash-loop behind it until it stops, so say so.
	if !before.Running {
		hostName, _ := os.Hostname()
		if cfg, err := loadConfig(manifest, hostName); err == nil {
			if release, ok := lockState(filepath.Join(cfg.CredentialsDir, "finch-run")); ok {
				release()
			} else {
				notes = append(notes, "another 'finch run' is serving this box in the foreground; stop it (Ctrl-C) and the service takes over")
			}
		}
	}
	if err := os.MkdirAll(finchHome(), 0o700); err != nil {
		return newCLIError(codeInternal, "", "creating %s: %v", finchHome(), err)
	}
	workDir := filepath.Dir(manifest)
	var unitPath string
	var unit []byte
	switch serviceGOOS {
	case "darwin":
		unitPath, unit = launchdPlistPath(), launchdPlist(bin, manifest, workDir, serviceLogPath())
	default:
		unitPath, unit = systemdUnitPath(), systemdUnit(bin, manifest, workDir)
	}
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		return newCLIError(codeInternal, "", "creating %s: %v", filepath.Dir(unitPath), err)
	}
	if err := atomicWriteFile(unitPath, unit, 0o644); err != nil {
		return newCLIError(codeInternal, "", "writing %s: %v", unitPath, err)
	}

	// The serve the manager starts below writes its relay status after this
	// instant; an older status file (a previous run's) is ignored.
	installStart := time.Now()
	linger := true
	switch serviceGOOS {
	case "darwin":
		// bootout first so a re-install picks up the rewritten plist; it fails
		// harmlessly when nothing is loaded.
		_, _ = runServiceCommand("launchctl", "bootout", launchdTarget())
		_, _ = runServiceCommand("launchctl", "enable", launchdTarget())
		// launchd tears a booted-out job down asynchronously, so an immediate
		// bootstrap of the same label can fail transiently (error 5/37): retry.
		domain := "gui/" + strconv.Itoa(os.Getuid())
		var out string
		var err error
		for attempt := 0; attempt < 5; attempt++ {
			if out, err = runServiceCommand("launchctl", "bootstrap", domain, unitPath); err == nil {
				break
			}
			serviceSleep(500 * time.Millisecond)
		}
		if err != nil {
			return newCLIError(codeInternal, "finch service status", "launchctl bootstrap failed: %v: %s", err, strings.TrimSpace(out))
		}
	default:
		for _, cmd := range [][]string{
			{"--user", "daemon-reload"},
			{"--user", "enable", systemdUnitName},
			{"--user", "restart", systemdUnitName},
		} {
			if out, err := runServiceCommand("systemctl", cmd...); err != nil {
				return newCLIError(codeInternal, "finch run", "systemctl %s failed: %v: %s (no systemd user session? run 'finch run' under your own supervisor)", strings.Join(cmd, " "), err, strings.TrimSpace(out))
			}
		}
		linger = lingerEnabled()
		if !linger {
			notes = append(notes, "on a headless box, run 'sudo loginctl enable-linger "+currentUsername()+"' so finch keeps running after you log out and starts at boot")
		}
	}

	s := currentServiceStatus()
	for i := 0; i < 10 && !s.Running; i++ {
		serviceSleep(300 * time.Millisecond)
		s = currentServiceStatus()
	}
	if !s.Running {
		// The manager accepted the unit but `finch run` never came up (a
		// missing credential, a foreground serve holding the lock, a crash on
		// start). The unit stays installed, since the manager keeps retrying
		// it, but install did not deliver a running endpoint, so it fails.
		msg := fmt.Sprintf("installed %s, but 'finch run' is not running; check the log (%s)", s.Unit, s.logHint())
		if len(notes) > 0 {
			msg += "; " + strings.Join(notes, "; ")
		}
		return newCLIError(codeInternal, "finch service status", "%s", msg)
	}
	// A live process is not a live endpoint: a relay whose credential is
	// missing or rejected keeps `finch run` up while it waits for `finch add`.
	// Wait for the serve's own report that every relay is connected.
	relays, problem := waitForRelays(manifest, installStart)
	if problem != nil {
		problem.Message = fmt.Sprintf("installed %s and 'finch run' is running, but %s; check the log (%s)", s.Unit, problem.Message, s.logHint())
		if len(notes) > 0 {
			problem.Message += "; " + strings.Join(notes, "; ")
		}
		return problem
	}
	if c.json {
		p := s.payload()
		p["relays"] = relays
		p["config"] = manifest
		p["binary"] = bin
		p["log"] = s.logHint()
		if s.Manager == "systemd" {
			p["linger"] = linger
		}
		if len(notes) > 0 {
			p["notes"] = notes
		}
		return c.emit(p)
	}
	c.printf("finch: installed %s (%s) — serves %s\n", s.Unit, s.Manager, manifest)
	c.printf("       %s\n       log: %s\n", s.describe(), s.logHint())
	for _, n := range notes {
		c.printf("       note: %s\n", n)
	}
	return nil
}

// relayReadyPolls × relayReadyInterval bounds how long install waits for the
// new serve's relays to connect (about 20s).
const (
	relayReadyPolls    = 40
	relayReadyInterval = 500 * time.Millisecond
)

// waitForRelays waits until the `finch run` started after since reports every
// ingress rule of manifest connected (run_status.go), and returns their
// states. A credential error fails at once, naming the `finch add` that fixes
// it; otherwise it gives up after about 20s, naming what is not connected.
func waitForRelays(manifest string, since time.Time) (map[string]relayStatus, *cliError) {
	hostName, _ := os.Hostname()
	cfg, err := loadConfig(manifest, hostName)
	if err != nil {
		return nil, newCLIError(codeInternal, "finch service status", "%s no longer loads: %v", manifest, err)
	}
	path := runStatusPath(cfg.CredentialsDir)
	var st *serveReport
	for i := 0; ; i++ {
		if st = readRunStatus(path); st != nil && st.Started < since.UnixNano() {
			st = nil // an earlier run's report
		}
		if st != nil {
			up := true
			for _, ing := range cfg.Ingress {
				r := st.Relays[ing.AppPath]
				if r.State == relayCredentialError {
					return nil, newCLIError(codeInternal, "finch add "+ing.AppPath+" --service "+ing.Service,
						"%s is not connected: %s", ing.AppPath, r.Error)
				}
				up = up && r.State == relayConnected
			}
			if up {
				return st.Relays, nil
			}
		}
		if i >= relayReadyPolls {
			break
		}
		serviceSleep(relayReadyInterval)
	}
	wait := (relayReadyPolls * relayReadyInterval).String()
	if st == nil {
		return nil, newCLIError(codeInternal, "finch service status", "it has not reported its relays within %s (%s)", wait, path)
	}
	var down []string
	for _, ing := range cfg.Ingress {
		r := st.Relays[ing.AppPath]
		if r.State == relayConnected {
			continue
		}
		d := ing.AppPath + " (" + r.State
		if r.State == "" {
			d = ing.AppPath + " (not reported"
		}
		if r.Error != "" {
			d += ": " + r.Error
		}
		down = append(down, d+")")
	}
	return nil, newCLIError(codeInternal, "finch service status", "not connected after %s: %s", wait, strings.Join(down, ", "))
}

func serviceUninstall(c *cli) error {
	var unitPath, stop string
	var out string
	var err error
	switch serviceGOOS {
	case "darwin":
		unitPath, stop = launchdPlistPath(), "launchctl bootout"
		out, err = runServiceCommand("launchctl", "bootout", launchdTarget())
	default:
		unitPath, stop = systemdUnitPath(), "systemctl --user disable --now"
		out, err = runServiceCommand("systemctl", "--user", "disable", "--now", systemdUnitName)
	}
	// Stopping fails harmlessly when nothing is loaded. Any other failure
	// leaves the serve up, and the unit is what stops it, so keep the unit and
	// fail unless the manager confirms the serve is gone.
	if err != nil && serviceStillUp() {
		return newCLIError(codeInternal, "finch service uninstall", "%s failed (%v: %s); finch is still running, so %s was kept", stop, err, strings.TrimSpace(out), unitPath)
	}
	removed := false
	if err := os.Remove(unitPath); err == nil {
		removed = true
	} else if !os.IsNotExist(err) {
		return newCLIError(codeInternal, "", "removing %s: %v", unitPath, err)
	}
	if serviceGOOS == "linux" && removed {
		_, _ = runServiceCommand("systemctl", "--user", "daemon-reload")
	}
	s := currentServiceStatus()
	if c.json {
		p := s.payload()
		p["removed"] = removed
		return c.emit(p)
	}
	if removed {
		c.printf("finch: removed %s — the service is stopped\n", unitPath)
	} else {
		c.printf("finch: no finch service was installed\n")
	}
	return nil
}

func currentUsername() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	if u := os.Getenv("USER"); u != "" {
		return u
	}
	return "$USER"
}

// lingerEnabled reports whether systemd keeps this user's services running
// without a login session. Unknown reads as false so the note is shown.
func lingerEnabled() bool {
	out, err := runServiceCommand("loginctl", "show-user", currentUsername(), "--property=Linger", "--value")
	return err == nil && strings.TrimSpace(out) == "yes"
}

func xmlText(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// launchdPlist renders the LaunchAgent: start at login, restart on exit.
func launchdPlist(bin, manifest, workDir, logPath string) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Managed by 'finch service install'; remove with 'finch service uninstall'. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + launchdLabel + `</string>
	<key>ProgramArguments</key>
	<array>
`)
	for _, a := range []string{bin, "run", "--config", manifest} {
		b.WriteString("\t\t<string>" + xmlText(a) + "</string>\n")
	}
	b.WriteString(`	</array>
	<key>WorkingDirectory</key>
	<string>` + xmlText(workDir) + `</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ProcessType</key>
	<string>Standard</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>` + serviceLogEnv + `</key>
		<string>` + xmlText(logPath) + `</string>
	</dict>
	<key>StandardOutPath</key>
	<string>` + xmlText(logPath) + `</string>
	<key>StandardErrorPath</key>
	<string>` + xmlText(logPath) + `</string>
</dict>
</plist>
`)
	return []byte(b.String())
}

// systemdQuote quotes one ExecStart word: C-style escapes inside double
// quotes, and %/$ doubled so systemd does not expand specifiers or variables.
func systemdQuote(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`, `$`, `$$`)
	return `"` + r.Replace(s) + `"`
}

// systemdUnit renders the user unit: start with the user manager, restart on exit.
func systemdUnit(bin, manifest, workDir string) []byte {
	words := []string{}
	for _, a := range []string{bin, "run", "--config", manifest} {
		words = append(words, systemdQuote(a))
	}
	return []byte(`# Managed by 'finch service install'; remove with 'finch service uninstall'.
[Unit]
Description=finch: publish local services through the finch hub

[Service]
ExecStart=` + strings.Join(words, " ") + `
WorkingDirectory=` + strings.ReplaceAll(workDir, "%", "%%") + `
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`)
}

// atomicWriteFile writes via a temp file + rename so a reader (launchd,
// systemd, an editor) never sees a torn file.
//
// A symlinked path (a dotfile manager's ~/.cursor/mcp.json → ~/dotfiles/…) is
// written through: the rename lands on the link's target, so the link survives.
func atomicWriteFile(path string, b []byte, mode os.FileMode) error {
	if st, err := os.Lstat(path); err == nil && st.Mode()&os.ModeSymlink != 0 {
		target, err := filepath.EvalSymlinks(path)
		if err != nil {
			return fmt.Errorf("%s is a symlink whose target cannot be resolved: %w", path, err)
		}
		path = target
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}
