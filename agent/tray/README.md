# finch-tray — menubar / system-tray app

The desktop sibling of `finch run`. One binary that reads your `finch.yml` and
supervises a relay per ingress rule, living in the **macOS menubar**, the
**Windows system tray**, or the **Linux tray** (AppIndicator/GTK) instead of a
terminal. It drives the same `agent/core` relay engine as the CLI — identical
auth, `finch.yml` semantics, and dial-out behaviour — via `core.RunConfig`.

Menu:

- a row per appliance showing live state (`connecting…` / `live` /
  `reconnecting…` / `error`),
- **Start / Stop relay** — connect or disconnect the whole roost,
- **Open dashboard** — opens the manifest's hub in your browser,
- **Quit**.

When the box is logged in (`finch login`), the tray best-effort self-approves each
appliance, so nothing gets stuck `pending` — same as `finch run`.

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

## Build

`finch-tray` uses [`getlantern/systray`](https://github.com/getlantern/systray),
which needs **CGo + the platform GUI libraries**, so it is built natively per OS
(it is intentionally NOT part of the CGO-free cross-compiled `finch` agent release
matrix in `.goreleaser.yaml`).

```sh
# macOS (needs Xcode command-line tools)
go build -o finch-tray ./tray

# Linux (needs gtk3 + libayatana-appindicator)
#   Debian/Ubuntu: sudo apt install gcc libgtk-3-dev libayatana-appindicator3-dev
CGO_ENABLED=1 go build -o finch-tray ./tray

# Windows (from a Windows host; CGo via mingw, or plain — systray uses win32)
go build -o finch-tray.exe ./tray
```

### macOS `.app`

For a real menubar app (dock-less, launch-at-login capable), wrap the binary in a
minimal `.app` bundle with `LSUIElement=true` in its `Info.plist`. A bundling
script + launch-at-login and CI packaging on native runners are a follow-up
(tracked separately) — the cross-compiled CGO-free `finch` release can't carry a
CGo tray, so tray artifacts need a per-OS build matrix.
