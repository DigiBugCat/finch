package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/DigiBugCat/finch/bar/internal/finch"
)

type call struct {
	name  string
	args  []string
	stdin string
}

// fake returns a Desktop whose helpers are recorded, never run. installed
// lists the helpers LookPath finds; Run refuses any helper not in it (the
// platform's built-ins open/pbcopy/osascript/xdg-open/journalctl count as
// installed).
func fake(t *testing.T, goos string, installed ...string) (*Desktop, *[]call) {
	t.Helper()
	var calls []call
	builtin := []string{"open", "pbcopy", "osascript", "xdg-open", "journalctl"}
	d := &Desktop{
		GOOS:     goos,
		Home:     t.TempDir(),
		Env:      func(string) string { return "" },
		CacheDir: filepath.Join(t.TempDir(), "cache"),
		LookPath: func(name string) (string, error) {
			if slices.Contains(installed, name) {
				return "/usr/bin/" + name, nil
			}
			return "", errors.New("not found")
		},
		Run: func(name string, args []string, stdin string) ([]byte, error) {
			if !slices.Contains(installed, name) && !slices.Contains(builtin, name) {
				t.Fatalf("ran %s, which is not installed", name)
			}
			calls = append(calls, call{name, args, stdin})
			if name == "journalctl" {
				return []byte("Sep 27 finch[1]: relay open -> http://127.0.0.1:8000\n"), nil
			}
			return nil, nil
		},
	}
	return d, &calls
}

func TestCheckURL(t *testing.T) {
	for _, ok := range []string{
		"https://finchmcp.com/cli?code=WXYZ-2345",
		"https://finchmcp.com/fleet#svc-notes",
		"http://127.0.0.1:8787/cli",
		"http://localhost:8787/cli",
	} {
		if err := CheckURL(ok); err != nil {
			t.Errorf("CheckURL(%q) = %v", ok, err)
		}
	}
	for _, bad := range []string{
		"file:///etc/passwd",
		"javascript:alert(1)",
		"http://example.com/",
		"https://user:pw@finchmcp.com/",
		"-a Calculator",
		"",
		"/Applications/Calculator.app",
	} {
		if err := CheckURL(bad); !errors.Is(err, ErrUnsafeURL) {
			t.Errorf("CheckURL(%q) = %v, want ErrUnsafeURL", bad, err)
		}
	}
}

func TestOpenURL(t *testing.T) {
	for goos, opener := range map[string]string{"darwin": "open", "linux": "xdg-open"} {
		d, calls := fake(t, goos)
		if err := d.OpenURL("https://finchmcp.com/fleet"); err != nil {
			t.Fatal(err)
		}
		if err := d.OpenURL("file:///etc/passwd"); err == nil {
			t.Fatal("opened a file: URL")
		}
		if len(*calls) != 1 || (*calls)[0].name != opener || !slices.Equal((*calls)[0].args, []string{"https://finchmcp.com/fleet"}) {
			t.Fatalf("%s calls = %+v", goos, *calls)
		}
	}
}

func TestCopyDarwin(t *testing.T) {
	d, calls := fake(t, "darwin")
	if err := d.Copy("https://wren.finchmcp.com/notes/mcp"); err != nil {
		t.Fatal(err)
	}
	if c := (*calls)[0]; c.name != "pbcopy" || c.stdin != "https://wren.finchmcp.com/notes/mcp" || len(c.args) != 0 {
		t.Fatalf("call = %+v", c)
	}
}

func TestCopyLinuxPicksAnInstalledTool(t *testing.T) {
	d, calls := fake(t, "linux", "xsel")
	if err := d.Copy("x"); err != nil {
		t.Fatal(err)
	}
	if c := (*calls)[0]; c.name != "xsel" || !slices.Equal(c.args, []string{"--clipboard", "--input"}) {
		t.Fatalf("call = %+v", c)
	}

	d, calls = fake(t, "linux", "wl-copy", "xclip")
	d.Env = func(k string) string {
		if k == "WAYLAND_DISPLAY" {
			return "wayland-0"
		}
		return ""
	}
	if err := d.Copy("x"); err != nil {
		t.Fatal(err)
	}
	if c := (*calls)[0]; c.name != "wl-copy" {
		t.Fatalf("on Wayland used %s", c.name)
	}

	d, _ = fake(t, "linux")
	if err := d.Copy("x"); err == nil || !strings.Contains(err.Error(), "xclip") {
		t.Fatalf("no clipboard tool: %v", err)
	}
}

func TestNotifyKeepsTextOutOfTheScript(t *testing.T) {
	d, calls := fake(t, "darwin")
	evil := `" & do shell script "touch /tmp/pwned" & "`
	d.Notify("finch", evil)
	c := (*calls)[0]
	if c.name != "osascript" {
		t.Fatalf("call = %+v", c)
	}
	for i := 0; i+1 < len(c.args); i++ {
		if c.args[i] == "-e" && strings.Contains(c.args[i+1], "touch") {
			t.Fatalf("notification text reached the script: %q", c.args)
		}
	}
	if c.args[len(c.args)-1] != evil {
		t.Fatalf("text not passed as an argument: %q", c.args)
	}

	d, calls = fake(t, "linux")
	d.Notify("finch", "hi")
	if len(*calls) != 0 {
		t.Fatal("ran notify-send although it is not installed")
	}
	d, calls = fake(t, "linux", "notify-send")
	d.Notify("finch", "-hi")
	if c := (*calls)[0]; !slices.Equal(c.args, []string{"--app-name=finch-bar", "--", "finch", "-hi"}) {
		t.Fatalf("notify-send args = %q", c.args)
	}
}

func TestOpenLog(t *testing.T) {
	d, calls := fake(t, "darwin")
	log := filepath.Join(d.Home, ".finch", "finch.log")
	if err := d.OpenLog(finch.ServiceStatus{Manager: "launchd"}); err == nil || !strings.Contains(err.Error(), "no log yet") {
		t.Fatalf("missing log: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(log), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(log, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.OpenLog(finch.ServiceStatus{Manager: "launchd"}); err != nil {
		t.Fatal(err)
	}
	if c := (*calls)[0]; c.name != "open" || !slices.Equal(c.args, []string{log}) {
		t.Fatalf("call = %+v", c)
	}
	// finch's own "log" field wins.
	other := filepath.Join(d.Home, "other.log")
	if err := os.WriteFile(other, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.OpenLog(finch.ServiceStatus{Manager: "launchd", Log: other}); err != nil {
		t.Fatal(err)
	}
	if c := (*calls)[1]; !slices.Equal(c.args, []string{other}) {
		t.Fatalf("call = %+v", c)
	}
	if err := d.OpenLog(finch.ServiceStatus{}); err == nil {
		t.Fatal("opened a log with no background service")
	}
}

func TestOpenLogSystemd(t *testing.T) {
	d, calls := fake(t, "linux")
	if err := d.OpenLog(finch.ServiceStatus{Manager: "systemd"}); err != nil {
		t.Fatal(err)
	}
	if c := (*calls)[0]; c.name != "journalctl" || !slices.Equal(c.args, []string{"--user", "--unit", "finch.service", "--no-pager", "--lines=500"}) {
		t.Fatalf("journalctl call = %+v", c)
	}
	snapshot := filepath.Join(d.CacheDir, "service.log")
	b, err := os.ReadFile(snapshot)
	if err != nil || !strings.Contains(string(b), "relay open") {
		t.Fatalf("snapshot = %q, %v", b, err)
	}
	if c := (*calls)[1]; c.name != "xdg-open" || !slices.Equal(c.args, []string{snapshot}) {
		t.Fatalf("open call = %+v", c)
	}
}
