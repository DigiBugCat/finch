package finch_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/DigiBugCat/finch/bar/internal/fakefinch"
	"github.com/DigiBugCat/finch/bar/internal/finch"
)

func TestMain(m *testing.M) {
	fakefinch.MaybeRun()
	os.Exit(m.Run())
}

func wantCalls(t *testing.T, f *fakefinch.Fake, want ...[]string) {
	t.Helper()
	got := f.Calls()
	if len(got) != len(want) {
		t.Fatalf("finch was run %d times %q, want %q", len(got), got, want)
	}
	for i := range want {
		if !slices.Equal(got[i], want[i]) {
			t.Fatalf("call %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestStatusRecorded171(t *testing.T) {
	f := fakefinch.Install(t, "1.7", map[string][]string{"status": {"1.7.1/status-logged-in.json"}})
	s, err := finch.New(f.Path).Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	wantCalls(t, f, []string{"status", "--json"})
	if !s.LoggedIn() || s.LoginPending || s.Unverified() {
		t.Fatalf("login = %v pending %v unverified %v, want signed in", s.LoggedIn(), s.LoginPending, s.Unverified())
	}
	if s.Account != "you@example.com" || s.Version != "1.7.1" {
		t.Fatalf("account %q version %q", s.Account, s.Version)
	}
	if len(s.Ingress) != 2 || s.Ingress[0].Name != "notes" || s.Ingress[0].Target != "http://127.0.0.1:8000" || s.Ingress[0].URL != "" {
		t.Fatalf("ingress = %+v", s.Ingress)
	}
	if s.Service.Manager != "launchd" || s.Service.Installed || s.Service.Running {
		t.Fatalf("service = %+v", s.Service)
	}
}

func TestStatusLoggedInFieldNames(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		want    bool
	}{
		{"1.7.1/status-logged-out.json", false}, // only "loggedIn"
		{"1.7.1/status-logged-in.json", true},
		{"1.8.0/status-logged-in.json", true}, // "logged_in" and "loggedIn"
		{"1.8.0/status-logged-out.json", false},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			f := fakefinch.Install(t, "1.7", map[string][]string{"status": {tc.fixture}})
			s, err := finch.New(f.Path).Status(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if s.LoggedIn() != tc.want {
				t.Fatalf("LoggedIn() = %v, want %v", s.LoggedIn(), tc.want)
			}
		})
	}
}

func TestStatusPrefersSnakeCase(t *testing.T) {
	yes, no := true, false
	s := finch.Status{LoggedInSnake: &no, LoggedInCamel: &yes}
	if s.LoggedIn() {
		t.Fatal("logged_in=false must win over loggedIn=true")
	}
}

func TestStatusURLs180(t *testing.T) {
	f := fakefinch.Install(t, "1.7", map[string][]string{"status": {"1.8.0/status-logged-in.json"}})
	s, err := finch.New(f.Path).Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Ingress[0].URL; got != "https://wren.finchmcp.com/notes/mcp" {
		t.Fatalf("ingress url = %q", got)
	}
}

func TestFleet(t *testing.T) {
	f := fakefinch.Install(t, "1.7", map[string][]string{"fleet": {"1.7.1/fleet.json"}})
	fl, err := finch.New(f.Path).Fleet(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	wantCalls(t, f, []string{"fleet", "--json"})
	if len(fl.Services) != 2 {
		t.Fatalf("services = %+v", fl.Services)
	}
	notes, kanban := fl.Services[0], fl.Services[1]
	if notes.ID != "notes" || !notes.Online() || notes.Offline() || notes.URL != "" {
		t.Fatalf("notes = %+v", notes)
	}
	if kanban.ID != "kanban" || kanban.Online() || !kanban.Offline() || kanban.Auth != "public" {
		t.Fatalf("kanban = %+v", kanban)
	}
}

func TestNotLoggedInEnvelope(t *testing.T) {
	f := fakefinch.Install(t, "1.7", map[string][]string{"fleet": {"1.7.1/fleet-logged-out.json"}})
	_, err := finch.New(f.Path).Fleet(context.Background())
	var fe *finch.Error
	if !errors.As(err, &fe) {
		t.Fatalf("err = %v, want *finch.Error", err)
	}
	if fe.Exit != finch.ExitNotLoggedIn || fe.Code != finch.CodeNotLoggedIn || fe.Next != "finch login --start" || fe.Message != "not logged in" {
		t.Fatalf("error = %+v", fe)
	}
}

func TestTest(t *testing.T) {
	f := fakefinch.Install(t, "1.7", map[string][]string{
		"test notes":  {"1.7.1/test-ok.json"},
		"test kanban": {"1.7.1/test-offline.json"},
	})
	c := finch.New(f.Path)
	res, err := c.Test(context.Background(), "notes")
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || len(res.Tools) != 2 || res.Tools[0].Name != "search" {
		t.Fatalf("result = %+v", res)
	}
	_, err = c.Test(context.Background(), "kanban")
	var fe *finch.Error
	if !errors.As(err, &fe) || fe.Code != finch.CodeUpstream || !strings.Contains(fe.Message, "did not answer") {
		t.Fatalf("err = %v", err)
	}
	wantCalls(t, f, []string{"test", "notes", "--json"}, []string{"test", "kanban", "--json"})
}

func TestTestRefusesAFlagAsAName(t *testing.T) {
	f := fakefinch.Install(t, "1.7", map[string][]string{})
	for _, name := range []string{"--hub=https://evil.example", "-x", "", "a b", "notes/..", strings.Repeat("a", 64), "trailing-"} {
		if _, err := finch.New(f.Path).Test(context.Background(), name); err == nil {
			t.Errorf("Test(%q) ran", name)
		}
	}
	wantCalls(t, f)
	for _, name := range []string{"notes", "my-app", "a.b_c", "N0tes"} {
		if !finch.ValidServiceName(name) {
			t.Errorf("ValidServiceName(%q) = false", name)
		}
	}
}

func TestLoginFlow(t *testing.T) {
	f := fakefinch.Install(t, "1.7", map[string][]string{
		"login --start":  {"1.7.1/login-start.json"},
		"login --poll":   {"1.7.1/login-poll-pending.json", "1.7.1/login-poll-approved.json"},
		"login --cancel": {"1.8.0/login-cancel.json"},
	})
	c := finch.New(f.Path)
	ctx := context.Background()
	start, err := c.LoginStart(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if start.UserCode != "WXYZ-2345" || start.VerificationURIComplete != "https://finchmcp.com/cli?code=WXYZ-2345" || start.Interval != 3 || start.ExpiresIn != 600 {
		t.Fatalf("start = %+v", start)
	}
	// Exit 10 carries a payload, not an error.
	p, err := c.LoginPoll(ctx)
	if err != nil || p.Status != "pending" {
		t.Fatalf("poll = %+v, %v", p, err)
	}
	p, err = c.LoginPoll(ctx)
	if err != nil || p.Status != "approved" || p.Account != "you@example.com" {
		t.Fatalf("poll = %+v, %v", p, err)
	}
	cancel, err := c.LoginCancel(ctx)
	if err != nil || !cancel.Cancelled {
		t.Fatalf("cancel = %+v, %v", cancel, err)
	}
	wantCalls(t, f,
		[]string{"login", "--start", "--json"},
		[]string{"login", "--poll", "--json"},
		[]string{"login", "--poll", "--json"},
		[]string{"login", "--cancel", "--json"})
}

func TestLoginPollExpired(t *testing.T) {
	f := fakefinch.Install(t, "1.7", map[string][]string{"login --poll": {"1.8.0/login-poll-expired.json"}})
	p, err := finch.New(f.Path).LoginPoll(context.Background())
	if err != nil || p.Status != "expired" {
		t.Fatalf("poll = %+v, %v", p, err)
	}
}

func TestServiceCommands(t *testing.T) {
	f := fakefinch.Install(t, "1.7", map[string][]string{
		"service status":    {"1.7.1/service-status.json"},
		"service install":   {"1.8.0/service-install-nothing.json", "1.8.0/service-install.json"},
		"service uninstall": {"1.8.0/service-uninstall.json"},
	})
	c := finch.New(f.Path)
	ctx := context.Background()
	s, err := c.ServiceStatus(ctx)
	if err != nil || s.Manager != "launchd" || s.Installed {
		t.Fatalf("status = %+v, %v", s, err)
	}
	_, err = c.ServiceInstall(ctx)
	var fe *finch.Error
	if !errors.As(err, &fe) || fe.Code != finch.CodeNotFound || fe.Next != "finch add <name> --service <url>" {
		t.Fatalf("install with nothing to serve: %v", err)
	}
	ch, err := c.ServiceInstall(ctx)
	if err != nil || !ch.Installed || !ch.Running || ch.Log != "/Users/you/.finch/finch.log" {
		t.Fatalf("install = %+v, %v", ch, err)
	}
	ch, err = c.ServiceUninstall(ctx)
	if err != nil || ch.Installed || !ch.Removed {
		t.Fatalf("uninstall = %+v, %v", ch, err)
	}
	wantCalls(t, f,
		[]string{"service", "status", "--json"},
		[]string{"service", "install", "--json"},
		[]string{"service", "install", "--json"},
		[]string{"service", "uninstall", "--json"})
}

func TestUpdate(t *testing.T) {
	f := fakefinch.Install(t, "1.7", map[string][]string{"update": {"1.8.0/update-current.json", "1.8.0/update-installed.json"}})
	c := finch.New(f.Path)
	u, err := c.Update(context.Background())
	if err != nil || u.Updated || u.Version != "1.8.0" {
		t.Fatalf("update = %+v, %v", u, err)
	}
	u, err = c.Update(context.Background())
	if err != nil || !u.Updated || u.Restart != "service" {
		t.Fatalf("update = %+v, %v", u, err)
	}
	wantCalls(t, f, []string{"update", "--json"}, []string{"update", "--json"})
}

func TestOldFinch(t *testing.T) {
	f := fakefinch.Install(t, "1.6", map[string][]string{
		"version": {"1.6.0/version.json"},
		"update":  {"1.6.0/update.json"},
	})
	c := finch.New(f.Path)
	v, err := c.Version(context.Background())
	if err != nil || v.Version != "1.6.0" || !finch.OlderThan(v.Version, finch.MinVersion) {
		t.Fatalf("version = %+v, %v", v, err)
	}
	// A finch without login --start answers with a usage error.
	_, err = c.LoginStart(context.Background())
	var fe *finch.Error
	if !errors.As(err, &fe) || fe.Exit != finch.ExitUsage {
		t.Fatalf("login --start on 1.6 = %v, want a usage error", err)
	}
	if err := c.UpdateLegacy(context.Background()); err != nil {
		t.Fatal(err)
	}
	wantCalls(t, f, []string{"version", "--json"}, []string{"login", "--start", "--json"}, []string{"update"})
}

func TestDecodeRejectsNonContractOutput(t *testing.T) {
	args := []string{"status", "--json"}
	for name, out := range map[string]finch.Output{
		"usage text":        {Stdout: []byte("Usage of finch status:\n  -json\n")},
		"no schema_version": {Stdout: []byte(`{"loggedIn":true}` + "\n")},
		"schema 2":          {Stdout: []byte(`{"schema_version":2}` + "\n")},
		"empty":             {},
	} {
		t.Run(name, func(t *testing.T) {
			var s finch.Status
			if err := finch.Decode(args, out, &s); err == nil {
				t.Fatal("decoded output that is not the --json contract")
			}
		})
	}
}

func TestDecodeErrorWithoutEnvelope(t *testing.T) {
	err := finch.Decode([]string{"status", "--json"}, finch.Output{Exit: 2, Stderr: []byte("flag provided but not defined: -json\nUsage of status:\n")}, nil)
	var fe *finch.Error
	if !errors.As(err, &fe) || fe.Code != finch.CodeUsage || fe.Message != "flag provided but not defined: -json" {
		t.Fatalf("err = %+v", err)
	}
}

func TestVersionCompare(t *testing.T) {
	for _, tc := range []struct {
		v, min string
		older  bool
	}{
		{"1.6.0", "1.7.0", true},
		{"1.7.0", "1.7.0", false},
		{"1.7.1", "1.7.0", false},
		{"v1.10.0", "1.7.0", false},
		{"0.9.9", "1.7.0", true},
		{"1.7.0-rc.1", "1.7.0", false},
		{"dev", "1.7.0", false},
	} {
		if got := finch.OlderThan(tc.v, tc.min); got != tc.older {
			t.Errorf("OlderThan(%q, %q) = %v", tc.v, tc.min, got)
		}
	}
}

func TestLocate(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "bin", "finch")
	must(t, os.MkdirAll(filepath.Dir(exe), 0o755))
	must(t, os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755))
	plain := filepath.Join(dir, "plain", "finch")
	must(t, os.MkdirAll(filepath.Dir(plain), 0o755))
	must(t, os.WriteFile(plain, []byte("not executable"), 0o644))
	home := filepath.Join(dir, "home")
	local := filepath.Join(home, ".local", "bin", "finch")
	must(t, os.MkdirAll(filepath.Dir(local), 0o755))
	must(t, os.WriteFile(local, []byte("#!/bin/sh\n"), 0o755))

	if got, err := finch.Locate("", filepath.Dir(plain)+string(os.PathListSeparator)+filepath.Dir(exe), home); err != nil || got != exe {
		t.Fatalf("PATH lookup = %q, %v; want %q (skipping the non-executable one)", got, err, exe)
	}
	if got, err := finch.Locate("", "relative/bin", home); err != nil || got != local {
		t.Fatalf("fallback = %q, %v; want ~/.local/bin/finch", got, err)
	}
	if got, err := finch.Locate(exe, "", ""); err != nil || got != exe {
		t.Fatalf("override = %q, %v", got, err)
	}
	if _, err := finch.Locate(plain, "", ""); !errors.Is(err, finch.ErrNotInstalled) {
		t.Fatalf("non-executable override: %v", err)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
