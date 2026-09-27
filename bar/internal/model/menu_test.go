package model_test

import (
	"strings"
	"testing"

	"github.com/DigiBugCat/finch/bar/internal/finch"
	"github.com/DigiBugCat/finch/bar/internal/model"
)

func find(items []model.Item, id string) (model.Item, bool) {
	for _, it := range model.Flatten(items) {
		if it.ID == id {
			return it, true
		}
	}
	return model.Item{}, false
}

func mustFind(t *testing.T, items []model.Item, id string) model.Item {
	t.Helper()
	it, ok := find(items, id)
	if !ok {
		t.Fatalf("no menu item %q in %s", id, model.Shape(items))
	}
	return it
}

func visibleIDs(items []model.Item) []string {
	var ids []string
	for _, it := range items {
		if !it.Separator && !it.Hidden {
			ids = append(ids, it.ID)
		}
	}
	return ids
}

func TestMenuAllConnected(t *testing.T) {
	st := model.Derive(snap(t, "1.8.0/version.json", "1.8.0/status-logged-in.json", "1.8.0/fleet-all-online.json"))
	on := false
	items := model.Build(st, model.UI{LoginItem: &on})

	if got := strings.Join(visibleIDs(items), " "); got != "status detail svc:notes svc:kanban background log update fleet login-item quit" {
		t.Fatalf("top level = %s", got)
	}
	if s := mustFind(t, items, "status"); s.Title != "All connected" || !s.Disabled {
		t.Fatalf("status = %+v", s)
	}
	notes := mustFind(t, items, "svc:notes")
	if notes.Title != "notes — online" || len(notes.Children) == 0 {
		t.Fatalf("notes = %+v", notes)
	}
	cp := mustFind(t, items, "svc:notes:copy")
	if cp.Disabled || cp.Action != (model.Action{Kind: model.ActCopy, Service: "notes", Text: "https://wren.finchmcp.com/notes/mcp"}) {
		t.Fatalf("copy = %+v", cp)
	}
	if tst := mustFind(t, items, "svc:notes:test"); tst.Action != (model.Action{Kind: model.ActTest, Service: "notes"}) {
		t.Fatalf("test = %+v", tst)
	}
	if o := mustFind(t, items, "svc:notes:open"); o.Action.Kind != model.ActOpenURL || o.Action.Text != "https://finchmcp.com/fleet#svc-notes" {
		t.Fatalf("open = %+v", o)
	}
	if tg := mustFind(t, items, "svc:notes:target"); tg.Title != "This machine → http://127.0.0.1:8000" || !tg.Disabled {
		t.Fatalf("target = %+v", tg)
	}
	if bg := mustFind(t, items, "background"); bg.Title != "Stop background service" || bg.Action.Kind != model.ActStopService {
		t.Fatalf("background = %+v", bg)
	}
	if li := mustFind(t, items, "login-item"); !li.Checkbox || li.Checked {
		t.Fatalf("login item = %+v", li)
	}
	if _, ok := find(items, "signin"); ok {
		t.Fatal("a signed-in menu offers Sign in")
	}
}

func TestMenuCopyURLNeedsFinch180(t *testing.T) {
	st := model.Derive(snap(t, "1.7.1/version.json", "1.7.1/status-logged-in.json", "1.7.1/fleet.json"))
	items := model.Build(st, model.UI{})
	cp := mustFind(t, items, "svc:kanban:copy")
	if !cp.Disabled || !strings.Contains(cp.Title, "1.8.0") {
		t.Fatalf("copy on 1.7.1 = %+v", cp)
	}
	if bg := mustFind(t, items, "background"); bg.Title != "Start background service" || bg.Action.Kind != model.ActStartService {
		t.Fatalf("background = %+v", bg)
	}
	if _, ok := find(items, "log"); ok {
		t.Fatal("Open log is offered with no background service installed")
	}
	if _, ok := find(items, "login-item"); ok {
		t.Fatal("login item shown although unsupported (nil)")
	}
}

func TestMenuLoggedOut(t *testing.T) {
	st := model.Derive(snap(t, "1.7.1/version.json", "1.7.1/status-logged-out.json", ""))
	items := model.Build(st, model.UI{})
	if got := strings.Join(visibleIDs(items), " "); got != "status detail signin update fleet quit" {
		t.Fatalf("top level = %s", got)
	}
	if s := mustFind(t, items, "signin"); s.Action.Kind != model.ActSignIn || s.Title != "Sign in…" {
		t.Fatalf("signin = %+v", s)
	}
	busy := model.Build(st, model.UI{Busy: map[string]string{"signin": "Opening sign-in…"}})
	if s := mustFind(t, busy, "signin"); !s.Disabled || s.Title != "Opening sign-in…" {
		t.Fatalf("busy signin = %+v", s)
	}
}

func TestMenuLoginPending(t *testing.T) {
	st := model.Derive(snap(t, "1.7.1/version.json", "1.7.1/status-login-pending.json", ""))
	// Started elsewhere (a terminal): finch-bar doesn't know the link.
	items := model.Build(st, model.UI{})
	if s := mustFind(t, items, "signin"); s.Title != "Sign in again…" {
		t.Fatalf("signin = %+v", s)
	}
	mustFind(t, items, "signin-cancel")
	if c := mustFind(t, items, "signin-code"); !c.Hidden {
		t.Fatal("code shown for a sign-in finch-bar did not start")
	}
	// Started here: show the code and a way back to the page.
	ui := model.UI{SignIn: &model.SignIn{UserCode: "WXYZ-2345", URL: "https://finchmcp.com/cli?code=WXYZ-2345"}}
	items = model.Build(st, ui)
	if c := mustFind(t, items, "signin-code"); c.Hidden || c.Title != "Code: WXYZ-2345" {
		t.Fatalf("code = %+v", c)
	}
	if o := mustFind(t, items, "signin-open"); o.Action != (model.Action{Kind: model.ActOpenURL, Text: ui.SignIn.URL}) {
		t.Fatalf("open = %+v", o)
	}
}

func TestMenuNoFinch(t *testing.T) {
	items := model.Build(model.Derive(model.Snapshot{LocateErr: finch.ErrNotInstalled}), model.UI{})
	cp := mustFind(t, items, "copy-install")
	if cp.Action != (model.Action{Kind: model.ActCopy, Text: "curl -fsSL https://finchmcp.com/install | sh"}) {
		t.Fatalf("copy install = %+v", cp)
	}
	if _, ok := find(items, "update"); ok {
		t.Fatal("offers to update a finch that isn't installed")
	}
}

func TestMenuTooOld(t *testing.T) {
	items := model.Build(model.Derive(snap(t, "1.6.0/version.json", "", "")), model.UI{})
	up := mustFind(t, items, "update")
	if up.Title != "Update finch" || up.Action.Kind != model.ActUpdate {
		t.Fatalf("update = %+v", up)
	}
	mustFind(t, items, "copy-install")
}

func TestMenuBusyAndResults(t *testing.T) {
	st := model.Derive(snap(t, "1.8.0/version.json", "1.8.0/status-logged-in.json", "1.8.0/fleet.json"))
	ui := model.UI{
		Busy:    map[string]string{"test:kanban": "Testing kanban…", "service": "Stopping background service…", "update": "Checking for updates…"},
		Tests:   map[string]model.TestNote{"notes": {OK: true, Text: "Test passed at 12:04: 2 tools"}},
		Message: "finch 1.8.0 is already the latest",
	}
	items := model.Build(st, ui)
	for id, title := range map[string]string{
		"svc:kanban:test":     "Testing kanban…",
		"background":          "Stopping background service…",
		"update":              "Checking for updates…",
		"svc:notes:last-test": "Test passed at 12:04: 2 tools",
		"message":             "finch 1.8.0 is already the latest",
	} {
		it := mustFind(t, items, id)
		if it.Title != title || !it.Disabled || it.Hidden {
			t.Errorf("%s = %+v, want disabled %q", id, it, title)
		}
	}
	if tst := mustFind(t, items, "svc:notes:test"); tst.Disabled {
		t.Error("testing kanban disabled notes' Test")
	}
}

func TestMenuShapeStableAcrossLiveChanges(t *testing.T) {
	// Status changes that keep the same services must update the open menu
	// in place rather than rebuild it.
	all := model.Derive(snap(t, "1.8.0/version.json", "1.8.0/status-logged-in.json", "1.8.0/fleet.json"))
	stopped := model.Derive(snap(t, "1.8.0/version.json", "1.8.0/status-service-stopped.json", "1.8.0/fleet.json"))
	a := model.Build(all, model.UI{})
	b := model.Build(stopped, model.UI{Message: "Background service stopped", Busy: map[string]string{"update": "Checking for updates…"}})
	if model.Shape(a) != model.Shape(b) {
		t.Fatalf("shape changed:\n%s\n%s", model.Shape(a), model.Shape(b))
	}
	// A new service is a new shape.
	fewer := model.Derive(snap(t, "1.8.0/version.json", "1.8.0/status-logged-in.json", "1.8.0/fleet-all-online.json"))
	if model.Shape(model.Build(fewer, model.UI{})) == model.Shape(a) {
		t.Fatal("different services, same shape")
	}
}

func TestMenuNoDoubleSeparators(t *testing.T) {
	for _, st := range []model.State{
		model.Derive(snap(t, "1.8.0/version.json", "1.8.0/status-logged-in.json", "1.8.0/fleet.json")),
		model.Derive(snap(t, "1.7.1/version.json", "1.7.1/status-logged-out.json", "")),
		model.Derive(model.Snapshot{LocateErr: finch.ErrNotInstalled}),
	} {
		items := model.Build(st, model.UI{})
		for i := 1; i < len(items); i++ {
			if items[i].Separator && items[i-1].Separator {
				t.Fatalf("%v: two separators in a row: %s", st.Kind, model.Shape(items))
			}
		}
		if items[len(items)-1].ID != "quit" {
			t.Fatalf("%v: menu does not end with Quit", st.Kind)
		}
	}
}

func TestFleetRowURLEscapes(t *testing.T) {
	if got := model.FleetRowURL("my app"); got != "https://finchmcp.com/fleet#svc-my%20app" {
		t.Fatalf("FleetRowURL = %q", got)
	}
}
