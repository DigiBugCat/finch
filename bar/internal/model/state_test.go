package model_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DigiBugCat/finch/bar/internal/finch"
	"github.com/DigiBugCat/finch/bar/internal/icons"
	"github.com/DigiBugCat/finch/bar/internal/model"
)

// fixture decodes a recorded finch invocation exactly as the client would:
// the payload into v, or the failure as an error.
func fixture(t *testing.T, name string, v any) error {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "finch", name))
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Args   []string `json:"args"`
		Exit   int      `json:"exit"`
		Stdout string   `json:"stdout"`
		Stderr string   `json:"stderr"`
	}
	if err := json.Unmarshal(b, &fx); err != nil {
		t.Fatal(err)
	}
	return finch.Decode(fx.Args, finch.Output{Stdout: []byte(fx.Stdout), Stderr: []byte(fx.Stderr), Exit: fx.Exit}, v)
}

// snap builds a snapshot from fixtures: a version fixture, a status fixture
// and a fleet fixture ("" leaves that command unrun).
func snap(t *testing.T, version, status, fleet string) model.Snapshot {
	t.Helper()
	s := model.Snapshot{Binary: "/usr/local/bin/finch"}
	var v finch.VersionInfo
	if s.VersionErr = fixture(t, version, &v); s.VersionErr == nil {
		s.Version = v.Version
	}
	if status != "" {
		var st finch.Status
		if s.StatusErr = fixture(t, status, &st); s.StatusErr == nil {
			s.Status = &st
		}
	}
	if fleet != "" {
		var fl finch.Fleet
		if s.FleetErr = fixture(t, fleet, &fl); s.FleetErr == nil {
			s.Fleet = &fl
		}
	}
	return s
}

func TestDerive(t *testing.T) {
	for _, tc := range []struct {
		name                     string
		version, status, fleet   string
		kind                     model.Kind
		icon                     icons.State
		headline, detailContains string
	}{
		{name: "1.7.1 logged out", version: "1.7.1/version.json", status: "1.7.1/status-logged-out.json",
			kind: model.LoggedOut, icon: icons.Idle, headline: "Not signed in"},
		{name: "1.7.1 login pending", version: "1.7.1/version.json", status: "1.7.1/status-login-pending.json",
			kind: model.LoginPending, icon: icons.Busy, headline: "Waiting for you to approve sign-in"},
		{name: "1.7.1 hub unreachable", version: "1.7.1/version.json", status: "1.7.1/status-hub-unreachable.json",
			kind: model.HubUnreachable, icon: icons.Alert, headline: "Can't reach finch"},
		// 1.7.1 recording: two local services, no background service, kanban offline.
		{name: "1.7.1 service not installed", version: "1.7.1/version.json", status: "1.7.1/status-logged-in.json", fleet: "1.7.1/fleet.json",
			kind: model.ServiceNotInstalled, icon: icons.Alert, headline: "Background service isn't installed"},
		{name: "1.7.1 fleet needs login", version: "1.7.1/version.json", status: "1.7.1/status-logged-in.json", fleet: "1.7.1/fleet-logged-out.json",
			kind: model.ServiceNotInstalled, icon: icons.Alert},
		{name: "1.8.0 all connected", version: "1.8.0/version.json", status: "1.8.0/status-logged-in.json", fleet: "1.8.0/fleet-all-online.json",
			kind: model.AllConnected, icon: icons.OK, headline: "All connected", detailContains: "2 services online"},
		{name: "1.8.0 some offline", version: "1.8.0/version.json", status: "1.8.0/status-logged-in.json", fleet: "1.8.0/fleet.json",
			kind: model.SomeOffline, icon: icons.Alert, headline: "1 of 3 services offline", detailContains: "kanban"},
		{name: "1.8.0 service stopped", version: "1.8.0/version.json", status: "1.8.0/status-service-stopped.json", fleet: "1.8.0/fleet.json",
			kind: model.ServiceStopped, icon: icons.Alert, headline: "Background service stopped"},
		{name: "1.8.0 not installed but served from a terminal", version: "1.8.0/version.json", status: "1.8.0/status-service-not-installed.json", fleet: "1.8.0/fleet-all-online.json",
			kind: model.AllConnected, icon: icons.OK},
		{name: "1.8.0 no local services", version: "1.8.0/version.json", status: "1.8.0/status-no-local-services.json", fleet: "1.8.0/fleet-all-online.json",
			kind: model.AllConnected, icon: icons.OK},
		{name: "1.8.0 nothing published", version: "1.8.0/version.json", status: "1.8.0/status-no-local-services.json", fleet: "1.8.0/fleet-empty.json",
			kind: model.NoServices, icon: icons.Idle, headline: "No services yet", detailContains: "finch add"},
		{name: "1.8.0 fleet error", version: "1.8.0/version.json", status: "1.8.0/status-no-local-services.json", fleet: "1.8.0/fleet-hub-error.json",
			kind: model.FleetError, icon: icons.Alert, headline: "Couldn't load your services", detailContains: "could not reach the finch hub"},
		{name: "1.6.0 too old", version: "1.6.0/version.json",
			kind: model.TooOld, icon: icons.Alert, headline: "finch 1.6.0 is too old", detailContains: "1.7.0 or later"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := model.Derive(snap(t, tc.version, tc.status, tc.fleet))
			if st.Kind != tc.kind {
				t.Fatalf("kind = %v (%q), want %v", st.Kind, st.Headline, tc.kind)
			}
			if st.Icon != tc.icon {
				t.Errorf("icon = %v, want %v", st.Icon, tc.icon)
			}
			if tc.headline != "" && st.Headline != tc.headline {
				t.Errorf("headline = %q, want %q", st.Headline, tc.headline)
			}
			if !strings.Contains(st.Detail, tc.detailContains) {
				t.Errorf("detail = %q, want it to mention %q", st.Detail, tc.detailContains)
			}
		})
	}
}

func TestDeriveNoFinch(t *testing.T) {
	st := model.Derive(model.Snapshot{LocateErr: finch.ErrNotInstalled})
	if st.Kind != model.NoFinch || st.HaveFinch || st.Icon != icons.Idle || st.Headline != "finch isn't installed" {
		t.Fatalf("state = %+v", st)
	}
}

func TestDeriveFinchNotRunning(t *testing.T) {
	// finch exists but could not run (killed by a timeout): not "too old".
	st := model.Derive(model.Snapshot{Binary: "/bin/finch", VersionErr: errors.New("finch version --json did not finish: context deadline exceeded")})
	if st.Kind != model.FinchError || st.Headline != "finch isn't responding" {
		t.Fatalf("state = %+v", st)
	}
	st = model.Derive(model.Snapshot{Binary: "/bin/finch", Version: "1.8.0", StatusErr: &finch.Error{Exit: 1, Code: "INTERNAL", Message: "reading ~/.finch/cli.json: permission denied"}})
	if st.Kind != model.FinchError || !strings.Contains(st.Detail, "permission denied") {
		t.Fatalf("state = %+v", st)
	}
}

func TestDeriveUnparseableVersionIsTooOldOnlyWhenFinchSaysSo(t *testing.T) {
	// A finch whose `version --json` fails with a usage error predates --json.
	st := model.Derive(model.Snapshot{Binary: "/bin/finch", VersionErr: &finch.Error{Exit: 2, Code: finch.CodeUsage, Message: "flag provided but not defined: -json"}})
	if st.Kind != model.TooOld || st.Headline != "This finch is too old" {
		t.Fatalf("state = %+v", st)
	}
	// Recorded from finch 1.5.10: `--version --json` fails at flag parsing.
	st = model.Derive(snap(t, "1.5.10/version.json", "", ""))
	if st.Kind != model.TooOld || st.Headline != "This finch is too old" || !strings.Contains(st.Detail, "1.7.0 or later") {
		t.Fatalf("1.5.10: state = %+v", st)
	}
	// A finch that answers without the --json contract (exit 0, nothing on
	// stdout) is too old too, not "not responding".
	st = model.Derive(model.Snapshot{Binary: "/bin/finch", VersionErr: fmt.Errorf("finch --version --json: %w: unexpected output \"\"", finch.ErrNoContract)})
	if st.Kind != model.TooOld {
		t.Fatalf("no contract: state = %+v", st)
	}
	// A dev build is trusted.
	st = model.Derive(model.Snapshot{Binary: "/bin/finch", Version: "dev", StatusErr: errors.New("x")})
	if st.Kind == model.TooOld {
		t.Fatal("a dev build was called too old")
	}
}

func TestServicesMergeFleetAndLocal(t *testing.T) {
	st := model.Derive(snap(t, "1.8.0/version.json", "1.8.0/status-logged-in.json", "1.8.0/fleet.json"))
	byName := map[string]model.ServiceView{}
	var order []string
	for _, s := range st.Services {
		byName[s.Name] = s
		order = append(order, s.Name)
	}
	if strings.Join(order, ",") != "notes,kanban,wiki" {
		t.Fatalf("order = %v, want fleet order", order)
	}
	notes := byName["notes"]
	if !notes.Local || notes.Target != "http://127.0.0.1:8000" || notes.URL != "https://wren.finchmcp.com/notes/mcp" || notes.State != "online" {
		t.Fatalf("notes = %+v", notes)
	}
	if k := byName["kanban"]; !k.Offline || k.State != "offline" || !k.Public {
		t.Fatalf("kanban = %+v", k)
	}
	if w := byName["wiki"]; w.Local {
		t.Fatalf("wiki is not served by this machine: %+v", w)
	}
}

func TestServicesLocalOnlyWhenFleetUnavailable(t *testing.T) {
	st := model.Derive(snap(t, "1.8.0/version.json", "1.8.0/status-hub-unreachable.json", ""))
	if len(st.Services) != 2 || st.Services[0].State != "unknown" || !st.Services[0].Local {
		t.Fatalf("services = %+v", st.Services)
	}
}

func TestHeadlineCounts(t *testing.T) {
	yes := true
	status := &finch.Status{LoggedInSnake: &yes, Version: "1.8.0"}
	for _, tc := range []struct {
		states []string
		want   string
	}{
		{[]string{"offline"}, "1 service offline"},
		{[]string{"offline", "offline"}, "All 2 services offline"},
		{[]string{"online", "offline", "offline", "offline", "offline"}, "4 of 5 services offline"},
		// "pending": a machine waits for `finch approve`; it never resolves on
		// its own, so it is not "connecting".
		{[]string{"online", "pending"}, "b is waiting for approval"},
		{[]string{"pending", "pending"}, "2 services waiting for approval"},
		{[]string{"pending", "offline"}, "1 of 2 services offline"},
		// "invited": added, but no machine has joined. Unknown states read
		// as offline too, like the fleet page.
		{[]string{"online", "invited"}, "1 of 2 services offline"},
		{[]string{"online", "some-future-state"}, "1 of 2 services offline"},
		{[]string{"online", "in_use"}, "All connected"},
		{[]string{"online"}, "All connected"},
	} {
		fl := &finch.Fleet{}
		for i, s := range tc.states {
			fl.Services = append(fl.Services, finch.FleetService{ID: string(rune('a' + i)), State: s})
		}
		st := model.Derive(model.Snapshot{Binary: "/bin/finch", Version: "1.8.0", Status: status, Fleet: fl})
		if st.Headline != tc.want {
			t.Errorf("%v: headline = %q, want %q", tc.states, st.Headline, tc.want)
		}
	}
}

func TestWaitingForApproval(t *testing.T) {
	yes := true
	fl := &finch.Fleet{Services: []finch.FleetService{{ID: "notes", State: "online"}, {ID: "kanban", State: "pending"}}}
	st := model.Derive(model.Snapshot{Binary: "/bin/finch", Version: "1.8.0", Status: &finch.Status{LoggedInSnake: &yes}, Fleet: fl})
	if st.Kind != model.AwaitingApproval || st.Icon != icons.Alert || st.Detail != "Approve it with: finch approve kanban" {
		t.Fatalf("state = %+v", st)
	}
	if sv := st.Services[1]; !sv.Waiting || sv.Offline || sv.State != "waiting for approval" {
		t.Fatalf("service = %+v", sv)
	}
	items := model.Build(st, model.UI{})
	approve := mustFind(t, items, "svc:kanban:approve")
	if approve.Hidden || approve.Action.Kind != model.ActCopy || approve.Action.Text != "finch approve kanban" {
		t.Fatalf("approve item = %+v", approve)
	}
	if !mustFind(t, items, "svc:notes:approve").Hidden {
		t.Fatal("an online service offers the approve command")
	}
}

func TestDetailListsAtMostThreeNames(t *testing.T) {
	yes := true
	fl := &finch.Fleet{}
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		fl.Services = append(fl.Services, finch.FleetService{ID: id, State: "offline"})
	}
	st := model.Derive(model.Snapshot{Binary: "/bin/finch", Version: "1.8.0", Status: &finch.Status{LoggedInSnake: &yes}, Fleet: fl})
	if st.Detail != "Offline: a, b, c and 2 more" {
		t.Fatalf("detail = %q", st.Detail)
	}
}
