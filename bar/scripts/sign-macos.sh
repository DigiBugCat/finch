#!/bin/sh
# Signs, notarizes and zips finch-bar.app for release.
#
#   scripts/sign-macos.sh <dir-with-finch-bar.app>
#   -> <dir>/finch-bar-darwin-universal.zip           (signed and notarized)
#   -> <dir>/finch-bar-darwin-universal-unsigned.zip  (when secrets are absent)
#
# Signing needs a Developer ID Application certificate and an App Store
# Connect API key, passed in the environment (the release workflow maps them
# from GitHub secrets):
#
#   MACOS_CERT_P12_BASE64    the certificate and its private key, as a
#                            base64-encoded .p12
#   MACOS_CERT_PASSWORD      the .p12's password
#   APPLE_API_KEY_P8_BASE64  the API key (.p8), base64-encoded
#   APPLE_API_KEY_ID         the key's ID
#   APPLE_API_ISSUER_ID      the key's issuer ID
#
# Without all five it still ships: it ad-hoc signs the app, zips it as
# ...-unsigned.zip and prints a loud warning. It writes the zip's file name to
# $GITHUB_OUTPUT as "asset" when that is set.
set -eu

dir=${1:?usage: sign-macos.sh <dir-with-finch-bar.app>}
app="$dir/finch-bar.app"
[ -d "$app" ] || { echo "sign-macos.sh: no $app" >&2; exit 2; }

output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1=$2" >> "$GITHUB_OUTPUT"
  fi
}

missing=""
for name in MACOS_CERT_P12_BASE64 MACOS_CERT_PASSWORD APPLE_API_KEY_P8_BASE64 APPLE_API_KEY_ID APPLE_API_ISSUER_ID; do
  if [ -z "$(printenv "$name" || true)" ]; then
    missing="$missing $name"
  fi
done

if [ -n "$missing" ]; then
  echo "::warning title=finch-bar is UNSIGNED::Missing secrets:$missing. Publishing finch-bar-darwin-universal-unsigned.zip, which macOS Gatekeeper will block until the user removes the quarantine flag. Add the secrets and re-run to ship a signed, notarized build."
  codesign --force --sign - "$app"
  asset="finch-bar-darwin-universal-unsigned.zip"
  rm -f "$dir/$asset"
  ditto -c -k --keepParent "$app" "$dir/$asset"
  output asset "$asset"
  output signed false
  exit 0
fi

tmp=$(mktemp -d)
keychain="$tmp/finch-bar-signing.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

# A throwaway keychain holds the certificate for this job only.
keychain_password=$(openssl rand -hex 24)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
printf '%s' "$MACOS_CERT_P12_BASE64" | base64 --decode > "$tmp/cert.p12"
security import "$tmp/cert.p12" -k "$keychain" -P "$MACOS_CERT_PASSWORD" -T /usr/bin/codesign >/dev/null
rm -f "$tmp/cert.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
# shellcheck disable=SC2046 # the existing search list is several paths
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')

identity=$(security find-identity -v -p codesigning "$keychain" | awk -F'"' '/Developer ID Application/ { print $2; exit }')
if [ -z "$identity" ]; then
  echo "::error title=finch-bar signing::MACOS_CERT_P12_BASE64 holds no Developer ID Application identity" >&2
  exit 1
fi
echo "Signing as: $identity"

codesign --force --options runtime --timestamp --keychain "$keychain" --sign "$identity" "$app"
codesign --verify --strict --verbose=2 "$app"

printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode > "$tmp/AuthKey.p8"
ditto -c -k --keepParent "$app" "$tmp/notarize.zip"
xcrun notarytool submit "$tmp/notarize.zip" \
  --key "$tmp/AuthKey.p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" \
  --wait --timeout 30m --output-format json > "$tmp/notary.json" || true
status=$(plutil -extract status raw -o - "$tmp/notary.json" 2>/dev/null || echo unknown)
submission=$(plutil -extract id raw -o - "$tmp/notary.json" 2>/dev/null || echo "")
echo "Notarization: $status ($submission)"
if [ "$status" != "Accepted" ]; then
  cat "$tmp/notary.json" >&2 || true
  if [ -n "$submission" ]; then
    xcrun notarytool log "$submission" \
      --key "$tmp/AuthKey.p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" >&2 || true
  fi
  echo "::error title=finch-bar notarization::Apple did not accept finch-bar.app (status: $status)" >&2
  exit 1
fi

xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"

asset="finch-bar-darwin-universal.zip"
rm -f "$dir/$asset"
ditto -c -k --keepParent "$app" "$dir/$asset"
output asset "$asset"
output signed true
