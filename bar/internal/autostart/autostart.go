// Package autostart opens finch-bar when you log in: a LaunchAgent on macOS
// (~/Library/LaunchAgents/com.finchmcp.finch-bar.plist) and an XDG autostart
// entry on Linux (~/.config/autostart/finch-bar.desktop).
//
// Installing only writes the file; it takes effect at the next login, so it
// never starts a second finch-bar next to the one you are running.
package autostart

import (
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Label is the LaunchAgent label (and the app's bundle identifier).
const Label = "com.finchmcp.finch-bar"

// ErrUnsupported is returned on platforms without a login item.
var ErrUnsupported = errors.New("starting at login is supported on macOS and Linux")

// LoginItem is the login item for one executable.
type LoginItem struct {
	GOOS string
	Home string
	// ConfigHome is $XDG_CONFIG_HOME (Linux); empty means ~/.config.
	ConfigHome string
	// Exe is the absolute path of the finch-bar binary to start.
	Exe string
}

// Supported reports whether this platform has a login item.
func (l LoginItem) Supported() bool { return l.GOOS == "darwin" || l.GOOS == "linux" }

// Path is where the login item lives.
func (l LoginItem) Path() (string, error) {
	switch l.GOOS {
	case "darwin":
		return filepath.Join(l.Home, "Library", "LaunchAgents", Label+".plist"), nil
	case "linux":
		base := l.ConfigHome
		if base == "" || !filepath.IsAbs(base) {
			base = filepath.Join(l.Home, ".config")
		}
		return filepath.Join(base, "autostart", "finch-bar.desktop"), nil
	}
	return "", ErrUnsupported
}

// Content renders the login item file.
func (l LoginItem) Content() (string, error) {
	if !filepath.IsAbs(l.Exe) {
		return "", fmt.Errorf("finch-bar's path %q is not absolute", l.Exe)
	}
	if strings.ContainsAny(l.Exe, "\n\r\x00") {
		return "", fmt.Errorf("finch-bar's path %q contains a line break", l.Exe)
	}
	switch l.GOOS {
	case "darwin":
		if strings.Contains(l.Exe, "/AppTranslocation/") {
			return "", errors.New("macOS is running finch-bar from a temporary copy; move finch-bar.app to your Applications folder, open it from there, and try again")
		}
		return plist(l.Exe), nil
	case "linux":
		return desktopEntry(l.Exe), nil
	}
	return "", ErrUnsupported
}

// Installed reports whether the login item exists.
func (l LoginItem) Installed() bool {
	p, err := l.Path()
	if err != nil {
		return false
	}
	_, err = os.Lstat(p)
	return err == nil
}

// Install writes the login item, replacing an older one.
func (l LoginItem) Install() error {
	p, err := l.Path()
	if err != nil {
		return err
	}
	content, err := l.Content()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".finch-bar-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}

// Uninstall removes the login item; removing one that is not there is fine.
func (l LoginItem) Uninstall() error {
	p, err := l.Path()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func xmlEscape(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func plist(exe string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by finch-bar ("Open finch-bar at login"). finch-bar removes it when you turn that off. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>` + Label + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>` + xmlEscape(exe) + `</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
</dict>
</plist>
`
}

// desktopExec quotes a path for a .desktop Exec key: inside double quotes,
// backslash-escape " ` $ and \, and double % (a field code otherwise).
func desktopExec(exe string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", `$`, `\$`)
	quoted := `"` + r.Replace(exe) + `"`
	// The desktop file format then unescapes backslashes once more.
	quoted = strings.ReplaceAll(quoted, `\`, `\\`)
	return strings.ReplaceAll(quoted, "%", "%%")
}

func desktopEntry(exe string) string {
	icon := "finch-bar"
	if p := filepath.Join(filepath.Dir(exe), "finch-bar.png"); fileExists(p) {
		icon = p
	}
	return `[Desktop Entry]
Type=Application
Name=finch-bar
Comment=finch in your menu bar
Exec=` + desktopExec(exe) + `
Icon=` + strings.ReplaceAll(icon, "\n", "") + `
Terminal=false
X-GNOME-Autostart-enabled=true
`
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}
