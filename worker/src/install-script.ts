/** The `finch` CLI installer served at GET /install:
 *
 *    curl -fsSL https://finchmcp.com/install | sh
 *
 *  An AI agent runs this line unattended (see /agents.md), so the script must
 *  never block on input: it never calls sudo. It installs to /usr/local/bin
 *  when that directory is writable by you and no other account, otherwise to
 *  ~/.local/bin (printing a PATH hint), and FINCH_INSTALL_DIR overrides both
 *  (FINCH_BIN_DIR is the older name, still honoured). Whatever the directory,
 *  it refuses one that other users can write (group- or world-writable
 *  without the sticky bit), since they could swap the verified binary before
 *  or after the final rename. It detects OS/arch, downloads the matching release
 *  binary from the hub-relative /releases path, verifies it against
 *  checksums.txt when a SHA-256 tool is available (failing closed when the
 *  manifest is missing or lacks exactly one entry for the asset), and swaps it
 *  into place with an atomic rename in the target directory. Its temporary
 *  files come from mktemp in that directory (exclusive, unpredictable names)
 *  and are removed on every exit.
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

# private_dir DIR succeeds when no OTHER account can unlink, rename or replace
# files in DIR: only its owner may write it, or it has the sticky bit (like
# /tmp), or its group write goes to your own user-private group (the umask-002
# default on Debian, Ubuntu and Fedora: group "you" holds only you). Anything
# else would let another user swap the binary between the checksum check and
# the final rename, or replace it at any time afterwards.
private_dir() {
  info="$(LC_ALL=C ls -ld "$1/." 2>/dev/null)" || return 1
  mode="$(echo "$info" | awk '{print $1}')"
  owner="$(echo "$info" | awk '{print $3}')"
  group="$(echo "$info" | awk '{print $4}')"
  case "$mode" in
    d????????[tT]*) return 0 ;;
    d???????w*) return 1 ;;
    d????w*)
      me="$(id -un 2>/dev/null || true)"
      [ -n "$me" ] && [ "$owner" = "$me" ] && [ "$group" = "$me" ]
      ;;
    d*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -n "\${FINCH_INSTALL_DIR:-}" ]; then
  BIN_DIR="$FINCH_INSTALL_DIR"
elif [ -n "\${FINCH_BIN_DIR:-}" ]; then
  BIN_DIR="$FINCH_BIN_DIR"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ] && private_dir /usr/local/bin; then
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
if ! private_dir "$BIN_DIR"; then
  echo "finch: refusing to install into $BIN_DIR: other users can write to it (group- or world-writable without the sticky bit), so one could swap the binary after it is verified. Run 'chmod go-w $BIN_DIR', or set FINCH_INSTALL_DIR to a directory only you can write" >&2
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
# crosses filesystems). mktemp creates each file exclusively under an
# unpredictable name, so nothing another user pre-created in a shared
# FINCH_INSTALL_DIR (a symlink to one of your files) is ever written through;
# the trap removes both files on any exit.
tmp=""
sums=""
trap 'rm -f \${tmp:+"$tmp"} \${sums:+"$sums"}' EXIT
newtemp() {
  mktemp "$BIN_DIR/.finch-$1.XXXXXXXX" 2>/dev/null || {
    echo "finch: cannot create a temporary file in $BIN_DIR (is mktemp installed?)" >&2
    return 1
  }
}
tmp="$(newtemp install)"
sums="$(newtemp checksums)"
echo "finch: downloading $url"
fetch "$url" "$tmp"
# The file must still be the regular file mktemp made, not something swapped in.
if [ -L "$tmp" ] || [ ! -f "$tmp" ]; then
  echo "finch: $tmp was replaced while downloading; not installing" >&2
  exit 1
fi
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
if [ -n "$sha" ]; then
  # Fail closed: with a hash tool present, the binary installs only against
  # exactly one checksums.txt entry for this asset.
  if ! fetch "$HUB/releases/checksums.txt" "$sums" 2>/dev/null || [ -L "$sums" ] || [ ! -s "$sums" ]; then
    echo "finch: could not fetch $HUB/releases/checksums.txt to verify $asset; not installing" >&2
    exit 1
  fi
  count="$(awk -v a="$asset" '$2 == a || $2 == "*" a {n++} END {print n+0}' "$sums")"
  if [ "$count" != 1 ]; then
    echo "finch: checksums.txt has $count entries for $asset (want exactly 1); not installing" >&2
    exit 1
  fi
  want="$(awk -v a="$asset" '$2 == a || $2 == "*" a {print $1}' "$sums")"
  if [ "$want" != "$sha" ]; then
    echo "finch: checksum mismatch for $asset (got $sha, want $want); not installing" >&2
    exit 1
  fi
else
  echo "finch: warning: no sha256sum or shasum found; installing $asset without verifying its checksum" >&2
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

# An older finch earlier on PATH (a previous installer used a root-owned
# /usr/local/bin) would keep answering to 'finch'. Compare real directories so
# a symlinked PATH entry is not mistaken for another copy.
found="$(command -v finch 2>/dev/null || true)"
case "$found" in
  /*)
    found_dir="$(cd "$(dirname "$found")" 2>/dev/null && pwd -P || true)"
    bin_real="$(cd "$BIN_DIR" && pwd -P)"
    if [ "$found_dir/$(basename "$found")" != "$bin_real/finch" ]; then
      finch_cmd="$BIN_DIR/finch"
      echo ""
      echo "finch: warning: 'finch' on your PATH is $found, not the copy just installed."
      echo "  That older finch shadows the new one. Run $BIN_DIR/finch by its full path,"
      echo "  or remove $found (it may be root-owned from an earlier install)."
    fi
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
