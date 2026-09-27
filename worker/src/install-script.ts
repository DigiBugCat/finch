/** The `finch` CLI installer served at GET /install:
 *
 *    curl -fsSL https://finchmcp.com/install | sh
 *
 *  An AI agent runs this line unattended (see /agents.md), so the script must
 *  never block on input: it never calls sudo. It installs to /usr/local/bin
 *  when that directory is writable, otherwise to ~/.local/bin (printing a PATH
 *  hint), and FINCH_INSTALL_DIR overrides both (FINCH_BIN_DIR is the older
 *  name, still honoured). It detects OS/arch, downloads the matching release
 *  binary from the hub-relative /releases path, verifies it against
 *  checksums.txt when a SHA-256 tool is available, and swaps it into place with
 *  an atomic rename in the target directory.
 *
 *  POSIX sh only: it runs under `sh` on macOS and Linux. Kept free of Workers
 *  APIs so tests can execute it under a real shell. */
export function installScript(base: string): string {
  return `#!/bin/sh
# finch installer — run via: curl -fsSL ${base}/install | sh
# Installs the 'finch' CLI (macOS and Linux). Never uses sudo: installs to
# /usr/local/bin when writable, else ~/.local/bin. Set FINCH_INSTALL_DIR to
# choose the directory.
set -eu

HUB="${base}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  armv7l|armv7) arch="armv7" ;;
  armv6l|armv6) arch="armv6" ;;
  *) echo "finch: unsupported architecture: $arch" >&2; exit 1 ;;
esac
case "$os" in
  darwin|linux) ;;
  *) echo "finch: unsupported OS: $os (finch runs on macOS and Linux)" >&2; exit 1 ;;
esac

if [ -n "\${FINCH_INSTALL_DIR:-}" ]; then
  BIN_DIR="$FINCH_INSTALL_DIR"
elif [ -n "\${FINCH_BIN_DIR:-}" ]; then
  BIN_DIR="$FINCH_BIN_DIR"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  BIN_DIR="/usr/local/bin"
elif [ -n "\${HOME:-}" ]; then
  BIN_DIR="$HOME/.local/bin"
else
  echo "finch: /usr/local/bin is not writable and HOME is unset; set FINCH_INSTALL_DIR" >&2
  exit 1
fi
mkdir -p "$BIN_DIR" 2>/dev/null || true
if [ ! -d "$BIN_DIR" ] || [ ! -w "$BIN_DIR" ]; then
  echo "finch: cannot write to $BIN_DIR; set FINCH_INSTALL_DIR to a directory you own" >&2
  exit 1
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "finch: need curl or wget to install" >&2
    return 1
  fi
}

asset="finch-\${os}-\${arch}"
url="$HUB/releases/$asset"
# Download next to the destination so the final rename is atomic (and never
# crosses filesystems); clean up on any failure.
tmp="$BIN_DIR/.finch-install.$$"
sums="$BIN_DIR/.finch-checksums.$$"
trap 'rm -f "$tmp" "$sums"' EXIT
echo "finch: downloading $url"
fetch "$url" "$tmp"
if [ ! -s "$tmp" ]; then
  echo "finch: download was empty" >&2
  exit 1
fi

sha=""
if command -v sha256sum >/dev/null 2>&1; then
  sha="$(sha256sum "$tmp" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  sha="$(shasum -a 256 "$tmp" | awk '{print $1}')"
fi
if [ -n "$sha" ] && fetch "$HUB/releases/checksums.txt" "$sums" 2>/dev/null; then
  want="$(awk -v a="$asset" '$2 == a {print $1}' "$sums")"
  if [ -n "$want" ] && [ "$want" != "$sha" ]; then
    echo "finch: checksum mismatch for $asset (got $sha, want $want); not installing" >&2
    exit 1
  fi
fi

chmod 755 "$tmp"
mv -f "$tmp" "$BIN_DIR/finch"
echo "finch: installed to $BIN_DIR/finch"

finch_cmd="finch"
case ":\${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *)
    finch_cmd="$BIN_DIR/finch"
    echo ""
    echo "finch: $BIN_DIR is not on your PATH. Add it with:"
    echo "  export PATH=\\"$BIN_DIR:\\$PATH\\""
    echo "  (or run $BIN_DIR/finch by its full path)"
    ;;
esac

echo ""
echo "  Next:  $finch_cmd login --start      # prints a sign-in link + code"
echo "         $finch_cmd login --poll       # repeat until approved"
echo "         $finch_cmd add <name> --service http://127.0.0.1:8000"
echo "         $finch_cmd service install    # keep it running"
echo ""
echo "  Driving finch with an AI agent? Point it at https://finchmcp.com/agents.md"
echo "  (or run '$finch_cmd guide')."
`;
}
