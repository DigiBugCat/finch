#!/bin/sh
# install-linux.sh — build finch-tray, install it under ~/.local, register a
# .desktop launcher, and autostart it at login. Idempotent: re-run to upgrade.
#
#   sh agent/tray/scripts/install-linux.sh
#   FINCH_HUB=https://…  sh …/install-linux.sh   # bake a dashboard hub
#
# Prereqs (system tray needs a GUI toolkit + CGo):
#   Debian/Ubuntu: sudo apt install gcc libgtk-3-dev libayatana-appindicator3-dev
#   Fedora:        sudo dnf install gcc gtk3-devel libayatana-appindicator-gtk3-devel
#
# Uninstall:
#   rm -f ~/.local/bin/finch-tray ~/.local/share/applications/finch.desktop \
#         ~/.config/autostart/finch.desktop ~/.local/share/icons/finch.png
set -eu

BIN_DIR="${FINCH_BIN_DIR:-$HOME/.local/bin}"
ICON_DIR="$HOME/.local/share/icons"
APPS_DIR="$HOME/.local/share/applications"
AUTOSTART_DIR="$HOME/.config/autostart"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "→ building finch-tray (CGo)…"
mkdir -p "$BIN_DIR" "$ICON_DIR" "$APPS_DIR" "$AUTOSTART_DIR"
( cd "$AGENT_DIR" && CGO_ENABLED=1 go build -o "$BIN_DIR/finch-tray" ./tray )

echo "→ installing icon…"
cp "$SCRIPT_DIR/../icon-app.png" "$ICON_DIR/finch.png"

# Optional dashboard hub baked into the Exec line.
EXEC="$BIN_DIR/finch-tray"
if [ "${FINCH_HUB:-}" != "" ]; then
  EXEC="$EXEC -hub $FINCH_HUB"
fi

echo "→ writing .desktop launcher + autostart entry…"
cat > "$APPS_DIR/finch.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Finch
Comment=Publish local services through the finch hub
Exec=$EXEC
Icon=$ICON_DIR/finch.png
Terminal=false
Categories=Network;Utility;
X-GNOME-Autostart-enabled=true
DESKTOP
cp "$APPS_DIR/finch.desktop" "$AUTOSTART_DIR/finch.desktop"

echo "→ launching…"
# Start now (detached); ignore failure on headless boxes.
( setsid "$BIN_DIR/finch-tray" ${FINCH_HUB:+-hub "$FINCH_HUB"} >"$HOME/.finch/tray.log" 2>&1 & ) 2>/dev/null || true

echo "✓ installed finch-tray to $BIN_DIR — in your app menu and at every login."
echo "  Reads ~/.finch/finch.yml. Logs: ~/.finch/tray.log"
