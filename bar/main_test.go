package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/DigiBugCat/finch/bar/internal/fakefinch"
)

func TestMain(m *testing.M) {
	fakefinch.MaybeRun()
	os.Exit(m.Run())
}

func runMain(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := run(args, &out, &errb)
	return code, out.String(), errb.String()
}

func TestVersionFlag(t *testing.T) {
	code, out, _ := runMain(t, "--version")
	if code != 0 || !strings.HasPrefix(out, "finch-bar dev (") {
		t.Fatalf("--version = %d %q", code, out)
	}
}

func TestBadUsage(t *testing.T) {
	for _, args := range [][]string{{"--nope"}, {"extra"}, {"--install-login-item", "--uninstall-login-item"}} {
		if code, _, errOut := runMain(t, args...); code != 2 || errOut == "" {
			t.Errorf("%q: exit %d, stderr %q", args, code, errOut)
		}
	}
	code, out, _ := runMain(t, "-h")
	if code != 0 || !strings.Contains(out, "--install-login-item") {
		t.Fatalf("-h = %d %q", code, out)
	}
}

func TestPrintAgainstFakeFinch(t *testing.T) {
	f := fakefinch.Install(t, "1.7", map[string][]string{
		"version": {"1.8.0/version.json"},
		"status":  {"1.8.0/status-logged-in.json"},
		"fleet":   {"1.8.0/fleet.json"},
	})
	t.Setenv("HOME", t.TempDir())
	code, out, errOut := runMain(t, "--print", "--finch", f.Path)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	for _, want := range []string{"1 of 3 services offline", "Offline: kanban", "notes — online ▸", "Copy URL", "Stop background service", "Quit finch-bar"} {
		if !strings.Contains(out, want) {
			t.Errorf("--print lacks %q:\n%s", want, out)
		}
	}
	if len(f.Calls()) != 3 {
		t.Fatalf("finch calls = %q", f.Calls())
	}
}

func TestPrintWithoutFinch(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", t.TempDir())
	t.Setenv("FINCH_BAR_FINCH", "")
	code, out, _ := runMain(t, "--print")
	if code != 0 || !strings.Contains(out, "finch isn't installed") || !strings.Contains(out, "Copy install command") {
		// /usr/local/bin/finch or /opt/homebrew/bin/finch on this machine
		// would be found by the fallback; only fail when neither exists.
		for _, p := range []string{"/usr/local/bin/finch", "/opt/homebrew/bin/finch"} {
			if _, err := os.Stat(p); err == nil {
				t.Skipf("%s exists on this machine", p)
			}
		}
		t.Fatalf("--print without finch = %d:\n%s", code, out)
	}
}

func TestLoginItemFlags(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("no login item on " + runtime.GOOS)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "cfg"))
	code, out, errOut := runMain(t, "--install-login-item")
	if code != 0 {
		t.Fatalf("install: %d %s", code, errOut)
	}
	want := filepath.Join(home, "Library", "LaunchAgents", "com.finchmcp.finch-bar.plist")
	if runtime.GOOS == "linux" {
		want = filepath.Join(home, "cfg", "autostart", "finch-bar.desktop")
	}
	if _, err := os.Stat(want); err != nil || !strings.Contains(out, want) {
		t.Fatalf("login item not at %s (%v): %s", want, err, out)
	}
	if code, _, errOut := runMain(t, "--uninstall-login-item"); code != 0 {
		t.Fatalf("uninstall: %d %s", code, errOut)
	}
	if _, err := os.Stat(want); !os.IsNotExist(err) {
		t.Fatalf("login item still there: %v", err)
	}
}
