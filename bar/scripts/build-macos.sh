#!/bin/sh
# Builds finch-bar.app: a universal (arm64 + amd64) binary in an app bundle
# with LSUIElement set (menu bar only, no Dock icon). It does not sign; the
# release workflow signs and notarizes the bundle this writes.
#
#   scripts/build-macos.sh <version> <out-dir>
#   -> <out-dir>/finch-bar.app
#
# Run from bar/. Needs Xcode's command line tools (clang, lipo, iconutil).
set -eu

version=${1:?usage: build-macos.sh <version> <out-dir>}
out=${2:?usage: build-macos.sh <version> <out-dir>}
case "$version" in
  *[!0-9A-Za-z.+-]*|"") echo "build-macos.sh: bad version: $version" >&2; exit 2 ;;
esac

work="$out/work"
app="$out/finch-bar.app"
rm -rf "$work" "$app"
mkdir -p "$work" "$app/Contents/MacOS" "$app/Contents/Resources"

export CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=11.0
for arch in arm64 amd64; do
  GOOS=darwin GOARCH=$arch go build -trimpath \
    -ldflags "-s -w -X main.version=$version" \
    -o "$work/finch-bar-$arch" .
done
lipo -create -output "$app/Contents/MacOS/finch-bar" "$work/finch-bar-arm64" "$work/finch-bar-amd64"
lipo "$app/Contents/MacOS/finch-bar" -verify_arch arm64 x86_64

sed "s/__VERSION__/$version/g" packaging/darwin/Info.plist > "$app/Contents/Info.plist"
plutil -lint "$app/Contents/Info.plist" >/dev/null

go run ./tools/genicons -app assets/app-icon.svg -iconset "$work/AppIcon.iconset"
iconutil -c icns -o "$app/Contents/Resources/AppIcon.icns" "$work/AppIcon.iconset"

rm -rf "$work"
echo "built $app ($version)"
