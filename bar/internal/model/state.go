// Package model turns what finch reports into what finch-bar shows: a State
// (the one-line status, the icon, the services) and a menu. It is pure — no
// processes, no UI — so every case is unit-tested from recorded finch output.
package model

import (
	"errors"
	"fmt"
	"strings"

	"github.com/DigiBugCat/finch/bar/internal/finch"
	"github.com/DigiBugCat/finch/bar/internal/icons"
)

// Snapshot is one poll of finch: which binary, its version, and the answers
// to `finch status --json` and `finch fleet --json`. A nil pointer means that
// command was not run (or failed; see the matching error).
type Snapshot struct {
	Binary     string
	LocateErr  error
	Version    string
	VersionErr error
	Status     *finch.Status
	StatusErr  error
	Fleet      *finch.Fleet
	FleetErr   error
}

// Kind is the overall situation, most urgent first.
type Kind int

const (
	NoFinch Kind = iota
	TooOld
	FinchError
	LoginPending
	LoggedOut
	HubUnreachable
	ServiceNotInstalled
	ServiceStopped
	FleetError
	NoServices
	SomeOffline
	Connecting
	AllConnected
)

var kindNames = map[Kind]string{
	NoFinch: "no-finch", TooOld: "too-old", FinchError: "finch-error",
	LoginPending: "login-pending", LoggedOut: "logged-out", HubUnreachable: "hub-unreachable",
	ServiceNotInstalled: "service-not-installed", ServiceStopped: "service-stopped",
	FleetError: "fleet-error", NoServices: "no-services", SomeOffline: "some-offline",
	Connecting: "connecting", AllConnected: "all-connected",
}

func (k Kind) String() string {
	if s, ok := kindNames[k]; ok {
		return s
	}
	return fmt.Sprintf("Kind(%d)", int(k))
}

// Background is finch's background service on this machine.
type Background struct {
	Known     bool // finch status answered
	Manager   string
	Installed bool
	Running   bool
}

// ServiceView is one service as the menu shows it.
type ServiceView struct {
	Name    string
	State   string // online | offline | connecting | unknown
	URL     string // public URL; empty before finch 1.8.0
	Local   bool   // served by this machine's finch.yml
	Target  string // the local URL, when Local
	Public  bool   // callers need no finch key
	Offline bool
	Online  bool
}

// State is what finch-bar shows.
type State struct {
	Kind     Kind
	Headline string
	Detail   string
	Icon     icons.State

	HaveFinch    bool   // a usable finch binary (possibly too old)
	FinchVersion string // as finch reported it
	LoggedIn     bool
	Account      string
	Background   Background
	HasLocal     bool // this machine's finch.yml has services
	Services     []ServiceView
}

// Derive computes the State for a snapshot.
func Derive(s Snapshot) State {
	st := State{HaveFinch: s.LocateErr == nil && s.Binary != "", FinchVersion: s.Version}
	if !st.HaveFinch {
		st.Kind, st.Icon = NoFinch, icons.Idle
		st.Headline = "finch isn't installed"
		st.Detail = "finch-bar needs the finch command-line tool."
		return st
	}
	if s.VersionErr != nil || finch.OlderThan(s.Version, finch.MinVersion) {
		var fe *finch.Error
		if s.VersionErr != nil && !errors.As(s.VersionErr, &fe) {
			// finch could not be run at all (or timed out): not an age problem.
			st.Kind, st.Icon = FinchError, icons.Alert
			st.Headline = "finch isn't responding"
			st.Detail = oneLine(s.VersionErr.Error())
			return st
		}
		st.Kind, st.Icon = TooOld, icons.Alert
		if s.Version != "" {
			st.Headline = fmt.Sprintf("finch %s is too old", s.Version)
		} else {
			st.Headline = "This finch is too old"
		}
		st.Detail = fmt.Sprintf("finch-bar needs finch %s or later.", finch.MinVersion)
		return st
	}
	if s.StatusErr != nil || s.Status == nil {
		st.Kind, st.Icon = FinchError, icons.Alert
		st.Headline = "finch isn't responding"
		if s.StatusErr != nil {
			st.Detail = oneLine(s.StatusErr.Error())
		}
		return st
	}

	status := s.Status
	st.LoggedIn = status.LoggedIn() && !status.LoginPending
	st.Account = status.Account
	st.Background = Background{
		Known:     true,
		Manager:   status.Service.Manager,
		Installed: status.Service.Installed,
		Running:   status.Service.Running,
	}
	st.HasLocal = len(status.Ingress) > 0
	st.Services = services(status, s.Fleet)

	switch {
	case status.LoginPending:
		st.Kind, st.Icon = LoginPending, icons.Busy
		st.Headline = "Waiting for you to approve sign-in"
		st.Detail = "Approve it in your browser to finish."
		return st
	case !status.LoggedIn():
		st.Kind, st.Icon = LoggedOut, icons.Idle
		st.Headline = "Not signed in"
		st.Detail = "Sign in to see your services."
		return st
	case status.Unverified():
		st.Kind, st.Icon = HubUnreachable, icons.Alert
		st.Headline = "Can't reach finch"
		st.Detail = "Check your internet connection. finch-bar keeps trying."
		return st
	}

	localOnline := s.Fleet != nil && st.HasLocal
	for _, sv := range st.Services {
		if sv.Local && !sv.Online {
			localOnline = false
		}
	}
	switch {
	case st.HasLocal && st.Background.Manager != "" && !st.Background.Installed && !localOnline:
		st.Kind, st.Icon = ServiceNotInstalled, icons.Alert
		st.Headline = "Background service isn't installed"
		st.Detail = "Start it to keep this machine's services online."
		return st
	case st.HasLocal && st.Background.Installed && !st.Background.Running:
		st.Kind, st.Icon = ServiceStopped, icons.Alert
		st.Headline = "Background service stopped"
		st.Detail = "Start it again, or open the log to see why it stopped."
		return st
	case s.FleetErr != nil || s.Fleet == nil:
		st.Kind, st.Icon = FleetError, icons.Alert
		st.Headline = "Couldn't load your services"
		if s.FleetErr != nil {
			st.Detail = oneLine(s.FleetErr.Error())
		}
		return st
	}

	var offline, connecting []string
	online := 0
	for _, sv := range st.Services {
		switch {
		case sv.Online:
			online++
		case sv.Offline:
			offline = append(offline, sv.Name)
		default:
			connecting = append(connecting, sv.Name)
		}
	}
	total := len(st.Services)
	switch {
	case total == 0:
		st.Kind, st.Icon = NoServices, icons.Idle
		st.Headline = "No services yet"
		st.Detail = "Publish one with: finch add <name> --service <url>"
	case len(offline) > 0:
		st.Kind, st.Icon = SomeOffline, icons.Alert
		if len(offline) == total {
			st.Headline = plural(total, "service", "services") + " offline"
			if total > 1 {
				st.Headline = "All " + st.Headline
			}
		} else {
			st.Headline = fmt.Sprintf("%d of %d services offline", len(offline), total)
		}
		st.Detail = "Offline: " + names(offline)
	case len(connecting) > 0:
		st.Kind, st.Icon = Connecting, icons.Busy
		st.Headline = plural(len(connecting), "service", "services") + " connecting"
		st.Detail = "Waiting for: " + names(connecting)
	default:
		st.Kind, st.Icon = AllConnected, icons.OK
		st.Headline = "All connected"
		st.Detail = plural(online, "service", "services") + " online"
	}
	return st
}

// services lists the account's services (fleet order), marking the ones
// this machine serves, then any local service the fleet does not list.
func services(status *finch.Status, fleet *finch.Fleet) []ServiceView {
	local := map[string]finch.Ingress{}
	for _, in := range status.Ingress {
		local[in.Name] = in
	}
	var out []ServiceView
	seen := map[string]bool{}
	if fleet != nil {
		for _, f := range fleet.Services {
			if f.ID == "" || seen[f.ID] {
				continue
			}
			seen[f.ID] = true
			v := ServiceView{
				Name:    f.ID,
				URL:     f.URL,
				Public:  f.Auth == "public",
				Online:  f.Online(),
				Offline: f.Offline(),
			}
			switch {
			case v.Online:
				v.State = "online"
			case v.Offline:
				v.State = "offline"
			default:
				v.State = "connecting"
			}
			if in, ok := local[f.ID]; ok {
				v.Local, v.Target = true, in.Target
				if v.URL == "" {
					v.URL = in.URL
				}
			}
			out = append(out, v)
		}
	}
	for _, in := range status.Ingress {
		if seen[in.Name] || in.Name == "" {
			continue
		}
		seen[in.Name] = true
		out = append(out, ServiceView{Name: in.Name, State: "unknown", URL: in.URL, Local: true, Target: in.Target})
	}
	return out
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

func names(list []string) string {
	const show = 3
	if len(list) <= show {
		return strings.Join(list, ", ")
	}
	return fmt.Sprintf("%s and %d more", strings.Join(list[:show], ", "), len(list)-show)
}

// oneLine keeps an error readable in a menu item.
func oneLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	const max = 90
	if r := []rune(s); len(r) > max {
		s = string(r[:max-1]) + "…"
	}
	return s
}
