#!/bin/sh
# Builds finch-bar for Linux and packs finch-bar-linux-<arch>.tar.gz:
#
#   finch-bar-linux-<arch>/
#     finch-bar           the binary (static; talks to the panel over D-Bus)
#     finch-bar.png       the app icon (256px)
#     finch-bar.desktop   an application-menu entry
#     icons/              the tray icons, for reference
#     README.txt          how to install it
#
#   scripts/package-linux.sh <version> <arch> <out-dir>
#
# Run from bar/. fyne.io/systray speaks the StatusNotifierItem D-Bus protocol
# in pure Go, so no cgo and no GTK or AppIndicator libraries are needed to
# build or run it.
set -eu

version=${1:?usage: package-linux.sh <version> <arch> <out-dir>}
arch=${2:?usage: package-linux.sh <version> <arch> <out-dir>}
out=${3:?usage: package-linux.sh <version> <arch> <out-dir>}
case "$version" in
  *[!0-9A-Za-z.+-]*|"") echo "package-linux.sh: bad version: $version" >&2; exit 2 ;;
esac
case "$arch" in
  amd64|arm64) ;;
  *) echo "package-linux.sh: unsupported arch: $arch" >&2; exit 2 ;;
esac

name="finch-bar-linux-$arch"
dir="$out/$name"
rm -rf "$dir"
mkdir -p "$dir/icons"

CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath \
  -ldflags "-s -w -X main.version=$version" \
  -o "$dir/finch-bar" .
go run ./tools/genicons -app assets/app-icon.svg -png "$dir/finch-bar.png"
cp packaging/linux/finch-bar.desktop "$dir/"
cp internal/icons/linux-*.png "$dir/icons/"
cat > "$dir/README.txt" <<EOF
finch-bar $version for Linux ($arch)

finch-bar shows finch in your panel's system tray. It needs the finch
command-line tool (curl -fsSL https://finchmcp.com/install | sh) and a
panel with StatusNotifierItem/AppIndicator support. On GNOME, install the
"AppIndicator and KStatusNotifierItem Support" extension first.

Install for your user:

  install -Dm755 finch-bar ~/.local/bin/finch-bar
  install -Dm644 finch-bar.png ~/.local/share/icons/hicolor/256x256/apps/finch-bar.png
  install -Dm644 finch-bar.desktop ~/.local/share/applications/finch-bar.desktop
  finch-bar --install-login-item   # open it when you log in (optional)
  finch-bar &

More: https://finchmcp.com/docs/menu-bar
EOF

tar -C "$out" -czf "$out/$name.tar.gz" "$name"
rm -rf "$dir"
echo "packed $out/$name.tar.gz ($version)"
