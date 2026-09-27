// Package desktop opens links and files, copies text and shows notifications
// with the tools each desktop already has: open, pbcopy and osascript on
// macOS; xdg-open, wl-copy/xclip/xsel, notify-send and journalctl on Linux.
package desktop

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/DigiBugCat/finch/bar/internal/finch"
)

// Desktop runs the platform's helpers. Run and LookPath are swapped by tests.
type Desktop struct {
	GOOS string
	Home string
	// Env reads an environment variable (WAYLAND_DISPLAY).
	Env func(string) string
	// Run runs a helper with stdin; it returns its combined output.
	Run func(name string, args []string, stdin string) ([]byte, error)
	// LookPath reports whether a helper is installed.
	LookPath func(string) (string, error)
	// CacheDir holds the Linux log snapshot (a private directory, not /tmp).
	CacheDir string
}

// New returns a Desktop for this machine.
func New(goos string) *Desktop {
	home, _ := os.UserHomeDir()
	return &Desktop{
		GOOS: goos,
		Home: home,
		Env:  os.Getenv,
		Run: func(name string, args []string, stdin string) ([]byte, error) {
			cmd := exec.Command(name, args...)
			if stdin != "" {
				cmd.Stdin = strings.NewReader(stdin)
			}
			done := make(chan struct{})
			var out []byte
			var err error
			go func() {
				out, err = cmd.CombinedOutput()
				close(done)
			}()
			select {
			case <-done:
				return out, err
			case <-time.After(30 * time.Second):
				if cmd.Process != nil {
					_ = cmd.Process.Kill()
				}
				<-done
				return out, fmt.Errorf("%s did not finish", name)
			}
		},
		LookPath: exec.LookPath,
		CacheDir: cacheDir(),
	}
}

// ErrUnsafeURL is a link finch-bar will not open.
var ErrUnsafeURL = errors.New("finch-bar only opens https links")

// CheckURL accepts https links, and http only to this machine (a local hub).
// finch-bar opens links finch printed, so it checks them first.
func CheckURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil {
		return fmt.Errorf("%w: %q", ErrUnsafeURL, raw)
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		host := u.Hostname()
		if ip := net.ParseIP(host); host == "localhost" || (ip != nil && ip.IsLoopback()) {
			return nil
		}
	}
	return fmt.Errorf("%w: %q", ErrUnsafeURL, raw)
}

func (d *Desktop) opener() string {
	if d.GOOS == "darwin" {
		return "open"
	}
	return "xdg-open"
}

// OpenURL opens a link in the default browser.
func (d *Desktop) OpenURL(u string) error {
	if err := CheckURL(u); err != nil {
		return err
	}
	if out, err := d.Run(d.opener(), []string{u}, ""); err != nil {
		return helperErr(d.opener(), out, err)
	}
	return nil
}

// OpenFile opens a local file with its default app (Console for a .log on
// macOS).
func (d *Desktop) OpenFile(path string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("not an absolute path: %q", path)
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("no log yet at %s", path)
	}
	if out, err := d.Run(d.opener(), []string{path}, ""); err != nil {
		return helperErr(d.opener(), out, err)
	}
	return nil
}

// Copy puts text on the clipboard.
func (d *Desktop) Copy(text string) error {
	if d.GOOS == "darwin" {
		if out, err := d.Run("pbcopy", nil, text); err != nil {
			return helperErr("pbcopy", out, err)
		}
		return nil
	}
	type helper struct {
		name string
		args []string
	}
	var helpers []helper
	if d.Env("WAYLAND_DISPLAY") != "" {
		helpers = append(helpers, helper{"wl-copy", nil})
	}
	helpers = append(helpers,
		helper{"xclip", []string{"-selection", "clipboard"}},
		helper{"xsel", []string{"--clipboard", "--input"}},
	)
	for _, h := range helpers {
		if _, err := d.LookPath(h.name); err != nil {
			continue
		}
		if out, err := d.Run(h.name, h.args, text); err != nil {
			return helperErr(h.name, out, err)
		}
		return nil
	}
	return errors.New("no clipboard tool found; install wl-clipboard, xclip or xsel")
}

// Notify shows a desktop notification. It is best effort: a desktop without
// a notification tool just shows nothing.
func (d *Desktop) Notify(title, body string) {
	if d.GOOS == "darwin" {
		// The text travels as arguments, never inside the AppleScript source.
		_, _ = d.Run("osascript", []string{
			"-e", "on run argv",
			"-e", "display notification (item 2 of argv) with title (item 1 of argv)",
			"-e", "end run",
			title, body,
		}, "")
		return
	}
	if _, err := d.LookPath("notify-send"); err == nil {
		_, _ = d.Run("notify-send", []string{"--app-name=finch-bar", "--", title, body}, "")
	}
}

// OpenLog shows the background service's log: the file finch reports (or
// launchd's ~/.finch/finch.log), or on Linux a snapshot of the systemd
// journal for finch.service.
func (d *Desktop) OpenLog(s finch.ServiceStatus) error {
	switch {
	case s.Log != "" && filepath.IsAbs(s.Log):
		return d.OpenFile(s.Log)
	case s.Manager == "launchd":
		return d.OpenFile(filepath.Join(d.Home, ".finch", "finch.log"))
	case s.Manager == "systemd":
		out, err := d.Run("journalctl", []string{"--user", "--unit", "finch.service", "--no-pager", "--lines=500"}, "")
		if err != nil {
			return helperErr("journalctl", out, err)
		}
		if err := os.MkdirAll(d.CacheDir, 0o700); err != nil {
			return err
		}
		path := filepath.Join(d.CacheDir, "service.log")
		header := "# journalctl --user --unit finch.service (last 500 lines)\n# Follow it live with: journalctl --user -u finch.service -f\n\n"
		if err := os.WriteFile(path, append([]byte(header), out...), 0o600); err != nil {
			return err
		}
		return d.OpenFile(path)
	}
	return errors.New("finch's background service is not set up on this machine")
}

func cacheDir() string {
	if dir, err := os.UserCacheDir(); err == nil {
		return filepath.Join(dir, "finch-bar")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("finch-bar-%d", os.Getuid()))
}

func helperErr(name string, out []byte, err error) error {
	if msg := strings.TrimSpace(string(out)); msg != "" {
		return fmt.Errorf("%s: %s", name, firstLine(msg))
	}
	return fmt.Errorf("%s: %v", name, err)
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
