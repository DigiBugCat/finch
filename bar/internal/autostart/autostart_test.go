package autostart

import (
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLaunchAgent(t *testing.T) {
	home := t.TempDir()
	l := LoginItem{GOOS: "darwin", Home: home, Exe: "/Applications/finch-bar.app/Contents/MacOS/finch-bar"}
	path, err := l.Path()
	if err != nil || path != filepath.Join(home, "Library", "LaunchAgents", "com.finchmcp.finch-bar.plist") {
		t.Fatalf("path = %q, %v", path, err)
	}
	if l.Installed() {
		t.Fatal("installed before Install")
	}
	if err := l.Install(); err != nil {
		t.Fatal(err)
	}
	if !l.Installed() {
		t.Fatal("not installed after Install")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"<string>com.finchmcp.finch-bar</string>",
		"<string>/Applications/finch-bar.app/Contents/MacOS/finch-bar</string>",
		"<key>RunAtLoad</key>\n\t<true/>",
		"<key>KeepAlive</key>\n\t<false/>",
	} {
		if !strings.Contains(string(b), want) {
			t.Errorf("plist lacks %q:\n%s", want, b)
		}
	}
	wellFormed(t, b)
	if err := l.Install(); err != nil { // idempotent
		t.Fatal(err)
	}
	if err := l.Uninstall(); err != nil {
		t.Fatal(err)
	}
	if l.Installed() {
		t.Fatal("installed after Uninstall")
	}
	if err := l.Uninstall(); err != nil { // idempotent
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(path)); len(entries) != 0 {
		t.Fatalf("left files behind: %v", entries)
	}
}

func TestLaunchAgentEscapesThePath(t *testing.T) {
	l := LoginItem{GOOS: "darwin", Home: t.TempDir(), Exe: "/Users/a&b/<Apps>/finch-bar.app/Contents/MacOS/finch-bar"}
	c, err := l.Content()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(c, "/Users/a&amp;b/&lt;Apps&gt;/") {
		t.Fatalf("path not escaped:\n%s", c)
	}
	wellFormed(t, []byte(c))
}

func TestLaunchAgentRefusesTranslocatedCopy(t *testing.T) {
	l := LoginItem{GOOS: "darwin", Home: t.TempDir(), Exe: "/private/var/folders/xy/T/AppTranslocation/1234/d/finch-bar.app/Contents/MacOS/finch-bar"}
	if err := l.Install(); err == nil || !strings.Contains(err.Error(), "Applications folder") {
		t.Fatalf("Install = %v", err)
	}
	if l.Installed() {
		t.Fatal("wrote a login item for a temporary copy")
	}
}

func TestXDGAutostart(t *testing.T) {
	home := t.TempDir()
	l := LoginItem{GOOS: "linux", Home: home, Exe: "/home/you/.local/bin/finch-bar"}
	path, _ := l.Path()
	if path != filepath.Join(home, ".config", "autostart", "finch-bar.desktop") {
		t.Fatalf("path = %q", path)
	}
	l.ConfigHome = filepath.Join(home, "cfg")
	path, _ = l.Path()
	if path != filepath.Join(home, "cfg", "autostart", "finch-bar.desktop") {
		t.Fatalf("XDG_CONFIG_HOME path = %q", path)
	}
	l.ConfigHome = "relative/cfg" // ignored, as the spec says
	path, _ = l.Path()
	if path != filepath.Join(home, ".config", "autostart", "finch-bar.desktop") {
		t.Fatalf("relative XDG_CONFIG_HOME path = %q", path)
	}
	if err := l.Install(); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	for _, want := range []string{"[Desktop Entry]\n", "Type=Application\n", `Exec="/home/you/.local/bin/finch-bar"` + "\n", "X-GNOME-Autostart-enabled=true\n", "Icon=finch-bar\n"} {
		if !strings.Contains(string(b), want) {
			t.Errorf("desktop entry lacks %q:\n%s", want, b)
		}
	}
	if err := l.Uninstall(); err != nil || l.Installed() {
		t.Fatalf("uninstall: %v", err)
	}
}

func TestDesktopExecQuoting(t *testing.T) {
	for exe, want := range map[string]string{
		"/opt/finch bar/finch-bar": `"/opt/finch bar/finch-bar"`,
		`/opt/$HOME/finch-bar`:     `"/opt/\\$HOME/finch-bar"`,
		`/opt/a"b/finch-bar`:       `"/opt/a\\"b/finch-bar"`,
		`/opt/a\b/finch-bar`:       `"/opt/a\\\\b/finch-bar"`,
		"/opt/100%/finch-bar":      `"/opt/100%%/finch-bar"`,
	} {
		if got := desktopExec(exe); got != want {
			t.Errorf("desktopExec(%q) = %s, want %s", exe, got, want)
		}
	}
}

func TestRejectsBadPaths(t *testing.T) {
	for _, exe := range []string{"finch-bar", "", "/opt/a\nX-Evil=1/finch-bar"} {
		for _, goos := range []string{"darwin", "linux"} {
			l := LoginItem{GOOS: goos, Home: t.TempDir(), Exe: exe}
			if err := l.Install(); err == nil {
				t.Errorf("%s: installed a login item for %q", goos, exe)
			}
		}
	}
	l := LoginItem{GOOS: "windows", Home: t.TempDir(), Exe: `C:\finch-bar.exe`}
	if l.Supported() || !errors.Is(l.Install(), ErrUnsupported) {
		t.Fatal("windows claims a login item")
	}
}

func wellFormed(t *testing.T, b []byte) {
	t.Helper()
	dec := xml.NewDecoder(strings.NewReader(string(b)))
	dec.Strict = true
	for {
		_, err := dec.Token()
		if err == io.EOF {
			return
		}
		if err != nil {
			t.Fatalf("plist is not well-formed XML: %v", err)
		}
	}
}
