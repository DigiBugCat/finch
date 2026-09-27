# finch-bar

A menu bar companion for the finch CLI, for macOS and Linux. It shows whether
your services are online and lets you copy a URL, test a service, sign in,
start or stop the background service, open its log and update finch.

It holds **no finch logic of its own**. Everything comes from running the
`finch` binary with `--json` and reading the documented payloads, so it can
never disagree with the CLI or do something the CLI can't. It reads no finch
files and keeps no credentials. User docs: https://finchmcp.com/docs/menu-bar

This is a separate Go module so the CLI's `agent/go.mod` stays minimal.

## Layout

| Path | What it is |
| --- | --- |
| `main.go` | flags, the single-instance lock, and systray start-up |
| `internal/finch` | runs finch and decodes its `--json` contract (1.7.x and 1.8.0) |
| `internal/model` | pure: finch output → status line, icon state and menu |
| `internal/app` | the controller: polling with backoff, and each menu action |
| `internal/tray` | draws the menu with `fyne.io/systray` (the only UI code) |
| `internal/desktop` | open a link or file, copy, notify (`open`/`pbcopy`/`osascript`, `xdg-open`/`wl-copy`/`xclip`/`notify-send`) |
| `internal/autostart` | the login item: a LaunchAgent or an XDG autostart entry |
| `internal/icons`, `internal/iconspec`, `internal/svgicon`, `assets/` | tray icons, generated from `assets/finch.svg` |
| `internal/fakefinch`, `testdata/finch` | a strict fake `finch` for tests, answering from recorded output |
| `packaging/`, `scripts/` | the `.app` bundle, the Linux tarball, signing and notarization |

## Develop

```sh
go test -race ./...
go run . --print                 # what the menu would show, as text
go run .                         # the real menu bar item
go run . --finch /path/to/finch  # against another finch build
```

The tray icons are committed PNGs generated from `assets/finch.svg` (the
Indigo Wash finch). After changing the SVG or `internal/iconspec`, run
`go generate ./internal/icons`; `TestCommittedIconsMatchSVG` fails until you do.

## Build a release locally

```sh
scripts/build-macos.sh 1.8.0 dist        # dist/finch-bar.app (universal, unsigned)
scripts/sign-macos.sh dist               # signs + notarizes with the env below, or ad-hoc
scripts/package-linux.sh 1.8.0 amd64 dist
```

The release workflow runs these on every `v*` tag after the finch release is
published. Signing needs these repository secrets (without them the release
still ships `finch-bar-darwin-universal-unsigned.zip` and warns):

- `MACOS_CERT_P12_BASE64`: a Developer ID Application certificate with its
  private key, exported as .p12 and base64-encoded
- `MACOS_CERT_PASSWORD`: the .p12's password
- `APPLE_API_KEY_P8_BASE64`: an App Store Connect API key (.p8), base64-encoded
- `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`: that key's ID and issuer ID

On Linux, `fyne.io/systray` talks to the panel over D-Bus
(StatusNotifierItem) in pure Go, so the build needs no cgo and no GTK or
AppIndicator packages, and the binary is static.
