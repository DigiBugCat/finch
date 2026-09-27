package model

import (
	"fmt"
	"net/url"
	"time"

	"github.com/DigiBugCat/finch/bar/internal/finch"
)

// Links finch-bar opens.
const (
	FleetURL   = "https://finchmcp.com/fleet"
	InstallURL = "https://finchmcp.com/docs"
	MenuBarURL = "https://finchmcp.com/docs/menu-bar"
)

// FleetRowURL is a service's card on the fleet page, which gives each card's
// heading the id "svc-<name>" (web/components/fleet/FleetView.tsx).
func FleetRowURL(name string) string {
	return FleetURL + "#svc-" + url.PathEscape(name)
}

// ActionKind is what clicking a menu item does.
type ActionKind int

const (
	ActNone            ActionKind = iota
	ActCopy                       // copy Action.Text to the clipboard
	ActOpenURL                    // open Action.Text in the browser
	ActTest                       // finch test <Service>
	ActStartService               // finch service install
	ActStopService                // finch service uninstall
	ActOpenLog                    // open the background service's log
	ActSignIn                     // finch login --start, open the link, poll
	ActCancelSignIn               // finch login --cancel
	ActUpdate                     // finch update
	ActToggleLoginItem            // start finch-bar at login, or stop
	ActRefresh                    // poll now
	ActQuit
)

// Action is a menu item's effect.
type Action struct {
	Kind    ActionKind
	Service string
	Text    string
	// What names the copied text in the confirmation ("the approve command");
	// ActCopy only. Empty: the service's URL, or the install command.
	What string
}

// Item is one menu entry. A Separator ignores everything else; an item with
// Children is a submenu.
type Item struct {
	ID        string
	Title     string
	Tooltip   string
	Disabled  bool
	Checkbox  bool
	Checked   bool
	Separator bool
	// Hidden items keep their place (and the menu's shape) while invisible,
	// so a line that comes and goes does not force a rebuild.
	Hidden   bool
	Action   Action
	Children []Item
}

// SignIn is a sign-in finch-bar started (so it knows the link and code).
type SignIn struct {
	UserCode string
	URL      string
}

// TestNote is the last `finch test` result for a service.
type TestNote struct {
	OK   bool
	Text string
	At   time.Time
}

// UI is finch-bar's own transient state: what it is doing and what it last
// did. It never comes from finch.
type UI struct {
	SignIn *SignIn
	// Busy maps a job to its progress label: "service", "update", "signin",
	// or "test:<name>".
	Busy map[string]string
	// Tests holds the last test result per service.
	Tests map[string]TestNote
	// Message is the outcome of the last action, shown under the status.
	Message string
	// LoginItem is whether finch-bar starts at login (nil: not supported).
	LoginItem *bool
}

func sep(id string) Item { return Item{ID: id, Separator: true} }

func info(id, title string) Item { return Item{ID: id, Title: title, Disabled: true} }

// optional is an info line that is hidden while it has nothing to say.
func optional(id, title string) Item {
	it := info(id, title)
	it.Hidden = title == ""
	return it
}

// Build lays out the menu for a state.
func Build(st State, ui UI) []Item {
	busy := func(key string) (string, bool) {
		label, ok := ui.Busy[key]
		return label, ok
	}
	code := ""
	if ui.SignIn != nil && st.Kind == LoginPending {
		code = "Code: " + ui.SignIn.UserCode
	}
	items := []Item{
		info("status", st.Headline),
		optional("detail", st.Detail),
		optional("signin-code", code),
		optional("message", ui.Message),
		sep("sep-top"),
	}

	switch st.Kind {
	case NoFinch:
		items = append(items,
			Item{ID: "copy-install", Title: "Copy install command", Tooltip: finch.InstallCommand,
				Action: Action{Kind: ActCopy, Text: finch.InstallCommand}},
			Item{ID: "install-guide", Title: "Open install guide", Action: Action{Kind: ActOpenURL, Text: InstallURL}},
		)
	case TooOld:
		items = append(items, updateItem(ui, "Update finch"),
			Item{ID: "copy-install", Title: "Copy install command", Tooltip: finch.InstallCommand,
				Action: Action{Kind: ActCopy, Text: finch.InstallCommand}})
	case LoggedOut:
		items = append(items, signInItem(ui, "Sign in…"))
	case LoginPending:
		if ui.SignIn != nil {
			items = append(items, Item{ID: "signin-open", Title: "Open sign-in page", Tooltip: ui.SignIn.URL,
				Action: Action{Kind: ActOpenURL, Text: ui.SignIn.URL}})
		} else {
			items = append(items, signInItem(ui, "Sign in again…"))
		}
		items = append(items, Item{ID: "signin-cancel", Title: "Cancel sign-in", Action: Action{Kind: ActCancelSignIn}})
	}

	// section starts a group, unless the menu already ends in a separator.
	section := func(id string) {
		if !items[len(items)-1].Separator {
			items = append(items, sep(id))
		}
	}

	if st.LoggedIn && len(st.Services) > 0 {
		section("sep-services")
		for _, sv := range st.Services {
			items = append(items, serviceMenu(sv, ui, busy))
		}
	}

	// The background service matters once this machine serves something.
	bg := st.Background
	if bg.Known && bg.Manager != "" && (st.HasLocal || bg.Installed) {
		section("sep-background")
		if label, ok := busy("service"); ok {
			items = append(items, Item{ID: "background", Title: label, Disabled: true})
		} else if bg.Installed && bg.Running {
			items = append(items, Item{ID: "background", Title: "Stop background service",
				Tooltip: "Stops finch on this machine; its services go offline",
				Action:  Action{Kind: ActStopService}})
		} else {
			items = append(items, Item{ID: "background", Title: "Start background service",
				Tooltip: "Keeps this machine's services online after you close the terminal",
				Action:  Action{Kind: ActStartService}})
		}
		if bg.Installed {
			items = append(items, Item{ID: "log", Title: "Open log", Action: Action{Kind: ActOpenLog}})
		}
	}

	section("sep-finch")
	if st.HaveFinch && st.Kind != TooOld {
		items = append(items, updateItem(ui, "Check for updates"))
	}
	items = append(items, Item{ID: "fleet", Title: "Open fleet page", Action: Action{Kind: ActOpenURL, Text: FleetURL}})

	items = append(items, sep("sep-app"))
	if ui.LoginItem != nil {
		items = append(items, Item{ID: "login-item", Title: "Open finch-bar at login", Checkbox: true,
			Checked: *ui.LoginItem, Action: Action{Kind: ActToggleLoginItem}})
	}
	items = append(items, Item{ID: "quit", Title: "Quit finch-bar", Action: Action{Kind: ActQuit}})
	return items
}

func updateItem(ui UI, title string) Item {
	if label, ok := ui.Busy["update"]; ok {
		return Item{ID: "update", Title: label, Disabled: true}
	}
	return Item{ID: "update", Title: title, Action: Action{Kind: ActUpdate}}
}

func signInItem(ui UI, title string) Item {
	if label, ok := ui.Busy["signin"]; ok {
		return Item{ID: "signin", Title: label, Disabled: true}
	}
	return Item{ID: "signin", Title: title, Tooltip: "Opens finchmcp.com in your browser",
		Action: Action{Kind: ActSignIn}}
}

func serviceMenu(sv ServiceView, ui UI, busy func(string) (string, bool)) Item {
	id := "svc:" + sv.Name
	title := fmt.Sprintf("%s — %s", sv.Name, sv.State)
	var kids []Item
	if sv.Local {
		kids = append(kids, info(id+":target", "This machine → "+sv.Target))
	}
	if sv.URL != "" {
		kids = append(kids, Item{ID: id + ":copy", Title: "Copy URL", Tooltip: sv.URL,
			Action: Action{Kind: ActCopy, Service: sv.Name, Text: sv.URL}})
	} else {
		kids = append(kids, Item{ID: id + ":copy", Title: "Copy URL (needs finch 1.8.0)", Disabled: true,
			Tooltip: "Update finch to see each service's URL here"})
	}
	// Always present (hidden unless waiting), so approving the service
	// changes the menu in place.
	approve := "finch approve " + sv.Name
	kids = append(kids, Item{ID: id + ":approve", Title: "Copy approve command", Tooltip: approve, Hidden: !sv.Waiting,
		Action: Action{Kind: ActCopy, Service: sv.Name, Text: approve, What: "the approve command"}})
	if label, ok := busy("test:" + sv.Name); ok {
		kids = append(kids, Item{ID: id + ":test", Title: label, Disabled: true})
	} else {
		kids = append(kids, Item{ID: id + ":test", Title: "Test",
			Tooltip: "Runs finch test " + sv.Name, Action: Action{Kind: ActTest, Service: sv.Name}})
	}
	if note, ok := ui.Tests[sv.Name]; ok {
		kids = append(kids, info(id+":last-test", note.Text))
	}
	kids = append(kids, Item{ID: id + ":open", Title: "Open in fleet page",
		Action: Action{Kind: ActOpenURL, Service: sv.Name, Text: FleetRowURL(sv.Name)}})
	return Item{ID: id, Title: title, Children: kids}
}
