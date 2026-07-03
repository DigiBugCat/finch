# finch-tray — menubar / system-tray app

The desktop sibling of `finch run`. One binary that reads your `finch.yml` and
supervises a relay per ingress rule, living in the **macOS menubar**, the
**Windows system tray**, or the **Linux tray** (AppIndicator/GTK) instead of a
terminal. It drives the same `agent/core` relay engine as the CLI — identical
auth, `finch.yml` semantics, and dial-out behaviour — via `core.RunConfig`.

Menu (Tailscale-style fleet view):

- **This machine — `<name>` (N) ▸** — the appliances this box publishes (from
  `finch.yml`) with live relay state (`connecting…` / `live` / `reconnecting…` /
  `error`),
- **Other machines (M) ▸** — every other box in your tenant (from the hub), each a
  submenu of the appliances it serves + their state (read-only),
- **Add application… ▸** — native dialog (name + port) → enrolls and publishes it
  (`core.Add`), then reloads and reconnects,
- **Remove application ▸** — submenu of this box's appliances; pick one to release
  it (`core.Remove`) and drop its ingress rule,
- **Open manifest** — opens `finch.yml` in your editor,
- **Open dashboard** — opens the `/dashboard` route in your browser,
- **Reconnect all** — stop and restart every relay,
- **Log in… / Log out** — browser device-auth (`core.Login`, code shown in a
  dialog) / drop the CLI token (`core.Logout`),
- **Quit**.

Relays **auto-start on launch**, and "Other machines" refreshes every 15s. When the
box is logged in (`finch login`), the tray best-effort self-approves each appliance,
so nothing gets stuck `pending` — same as `finch run`. It reads `~/.finch/finch.yml`
by default.

## Run

```sh
finch-tray                       # uses ./finch.yml, else ~/.finch/finch.yml
finch-tray -config /path/finch.yml
finch-tray -hub https://finch-staging.pantainos.workers.dev   # dashboard link + approve host
```

Prereq: log in and declare at least one appliance first —

```sh
finch login --hub <hub>
finch add myapp --service http://127.0.0.1:8000
finch-tray
```

## Install (macOS)

Build a dockless `Finch.app`, install it to `~/Applications`, and register a
LaunchAgent so it starts at login:

```sh
sh agent/tray/scripts/install-macos.sh
# bake a dashboard hub (else it reads hub: from finch.yml):
FINCH_HUB=https://finch-staging.pantainos.workers.dev sh agent/tray/scripts/install-macos.sh
```

Uninstall:

```sh
launchctl bootout gui/$(id -u)/com.finchmcp.tray
rm -rf ~/Applications/Finch.app ~/Library/LaunchAgents/com.finchmcp.tray.plist
```

Logs land in `~/.finch/tray.log`.

## Install (Linux)

Installs to `~/.local/bin`, adds a `.desktop` launcher, and autostarts at login:

```sh
# prereqs (system tray needs a GUI toolkit + CGo):
#   Debian/Ubuntu: sudo apt install gcc libgtk-3-dev libayatana-appindicator3-dev
sh agent/tray/scripts/install-linux.sh
FINCH_HUB=https://finch-staging.pantainos.workers.dev sh agent/tray/scripts/install-linux.sh
```

## Install (Windows)

Installs to `%LOCALAPPDATA%\Finch` with Start-menu + Startup (login) shortcuts:

```powershell
powershell -ExecutionPolicy Bypass -File agent\tray\scripts\install-windows.ps1
$env:FINCH_HUB="https://…"; powershell -ExecutionPolicy Bypass -File agent\tray\scripts\install-windows.ps1
```

(Windows needs no CGo — systray uses win32 directly.)

## Build

`finch-tray` uses [`getlantern/systray`](https://github.com/getlantern/systray),
which needs **CGo + the platform GUI libraries**, so it is built natively per OS
(it is intentionally NOT part of the CGO-free cross-compiled `finch` agent release
matrix in `.goreleaser.yaml`).

```sh
# macOS (needs Xcode command-line tools)
go build -tags tray -o finch-tray ./tray

# Linux (needs gtk3 + libayatana-appindicator)
#   Debian/Ubuntu: sudo apt install gcc libgtk-3-dev libayatana-appindicator3-dev
CGO_ENABLED=1 go build -tags tray -o finch-tray ./tray

# Windows (from a Windows host; CGo via mingw, or plain — systray uses win32)
go build -tags tray -o finch-tray.exe ./tray
```

### macOS `.app`

For a real menubar app (dock-less, launch-at-login capable), wrap the binary in a
minimal `.app` bundle with `LSUIElement=true` in its `Info.plist`. A bundling
script + launch-at-login and CI packaging on native runners are a follow-up
(tracked separately) — the cross-compiled CGO-free `finch` release can't carry a
CGo tray, so tray artifacts need a per-OS build matrix.
