#!/bin/sh
# install-macos.sh — build finch-tray, wrap it in a dockless Finch.app menubar
# bundle, install it to ~/Applications, and register a LaunchAgent so it starts
# at login. Idempotent: re-run to upgrade in place.
#
#   sh agent/tray/scripts/install-macos.sh          # build + install + launch
#   FINCH_HUB=https://…  sh …/install-macos.sh      # bake a dashboard hub
#
# Uninstall:
#   launchctl bootout gui/$(id -u)/com.finchmcp.tray 2>/dev/null
#   rm -rf ~/Applications/Finch.app ~/Library/LaunchAgents/com.finchmcp.tray.plist
set -eu

APP_ID="com.finchmcp.tray"
APP="$HOME/Applications/Finch.app"
PLIST="$HOME/Library/LaunchAgents/$APP_ID.plist"
VERSION="$(grep -oE 'agentVersion = "[^"]+"' "$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || echo .)/agent/core/agent.go" 2>/dev/null | head -1 | cut -d'"' -f2 || echo 0.0.0)"

# Resolve the agent module dir (this script lives in agent/tray/scripts/).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "→ building finch-tray (CGo/macOS)…"
( cd "$AGENT_DIR" && go build -o "$SCRIPT_DIR/finch-tray" ./tray )

echo "→ assembling $APP …"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mv "$SCRIPT_DIR/finch-tray" "$APP/Contents/MacOS/finch-tray"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Finch</string>
  <key>CFBundleDisplayName</key><string>Finch</string>
  <key>CFBundleIdentifier</key><string>$APP_ID</string>
  <key>CFBundleExecutable</key><string>finch-tray</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Optional dashboard hub baked into the launch args.
HUB_ARG=""
if [ "${FINCH_HUB:-}" != "" ]; then
  HUB_ARG="<string>-hub</string><string>$FINCH_HUB</string>"
fi

echo "→ writing LaunchAgent $PLIST …"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$APP_ID</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP/Contents/MacOS/finch-tray</string>
    $HUB_ARG
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>$HOME/.finch/tray.log</string>
  <key>StandardOutPath</key><string>$HOME/.finch/tray.log</string>
</dict>
</plist>
PLIST

echo "→ (re)loading the LaunchAgent…"
launchctl bootout "gui/$(id -u)/$APP_ID" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$APP_ID" 2>/dev/null || true

echo "✓ installed $APP (v$VERSION) — running now and at every login."
echo "  Look for the teal dot in your menubar. Logs: ~/.finch/tray.log"
