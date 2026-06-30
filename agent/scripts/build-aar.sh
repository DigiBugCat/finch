#!/bin/sh
# build-aar.sh — build the finch Android SDK (.aar) from ./mobile via gomobile.
#
# Output: agent/build/finch.aar  (+ finch-sources.jar)
# An app drops the .aar into app/libs/ (or a Gradle module) and uses the
# com.finchmcp.finch.* classes — see mobile/README.md.
#
# Requirements:
#   - Go (the module's toolchain). The gomobile/x/mobile deps are pinned in
#     go.mod via ../tools.go, so no `go get` is needed here.
#   - Android SDK + NDK. ANDROID_HOME defaults to ~/Library/Android/sdk and we
#     auto-pick the newest installed NDK; override either via env.
#   - A real JDK with javac. We auto-discover one (Android Studio's bundled JBR,
#     then Homebrew openjdk, then /usr/libexec/java_home); set JAVA_HOME to force.
#     (macOS ships a /usr/bin/javac STUB that only prompts to install Java — not
#     usable, which is why we discover a real one.)
set -eu

cd "$(dirname "$0")/.."   # -> agent/

# gomobile/gobind install to GOPATH/bin; make sure it is on PATH.
GOBIN="$(go env GOPATH)/bin"
PATH="$GOBIN:$PATH"
export PATH

# --- JDK: gomobile bind runs javac, and macOS's /usr/bin/javac is a stub. ---
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "${JAVA_HOME:-/nonexistent}/bin/javac" ]; then
  JAVA_HOME=""
  for cand in \
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
    "$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
    "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home" \
    "/opt/homebrew/opt/openjdk" \
    "/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home"; do
    if [ -x "$cand/bin/javac" ]; then JAVA_HOME="$cand"; break; fi
  done
  if [ -z "$JAVA_HOME" ] && [ -x /usr/libexec/java_home ]; then
    JAVA_HOME="$(/usr/libexec/java_home 2>/dev/null || true)"
  fi
fi
if [ -n "${JAVA_HOME:-}" ]; then
  export JAVA_HOME
  PATH="$JAVA_HOME/bin:$PATH"
  export PATH
fi
if ! "${JAVA_HOME:+$JAVA_HOME/bin/}javac" -version >/dev/null 2>&1; then
  echo "build-aar: no usable JDK found. Install one (Android Studio bundles a JBR," >&2
  echo "           or 'brew install openjdk') or set JAVA_HOME." >&2
  exit 1
fi

# --- Android SDK / NDK. ---
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
export ANDROID_HOME
if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
  newest="$(ls "$ANDROID_HOME/ndk" | sort -V | tail -1)"
  ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$newest"
  export ANDROID_NDK_HOME
fi
echo "JAVA_HOME=${JAVA_HOME:-<system>}"
echo "ANDROID_HOME=$ANDROID_HOME"
echo "ANDROID_NDK_HOME=${ANDROID_NDK_HOME:-<unset>}"
[ -d "${ANDROID_NDK_HOME:-/nonexistent}" ] || {
  echo "build-aar: no Android NDK found. Install one (Android Studio > SDK Manager >" >&2
  echo "           SDK Tools > NDK) or set ANDROID_NDK_HOME." >&2
  exit 1
}

# --- Toolchain: install gomobile/gobind if absent, init, bind. ---
command -v gomobile >/dev/null 2>&1 || go install golang.org/x/mobile/cmd/gomobile@latest
command -v gobind   >/dev/null 2>&1 || go install golang.org/x/mobile/cmd/gobind@latest
gomobile init

mkdir -p build
echo "gomobile bind -> build/finch.aar"
gomobile bind -target=android -androidapi 21 -javapkg=com.finchmcp -o build/finch.aar ./mobile

echo "built: $(cd build && pwd)/finch.aar"
ls -la build/finch.aar build/finch-sources.jar 2>/dev/null || true
