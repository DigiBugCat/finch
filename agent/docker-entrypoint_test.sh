#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/bin" "$tmp/credentials"
cp "$root/testdata/fake-finch.sh" "$tmp/bin/finch"
chmod 0555 "$tmp/bin/finch"

export PATH="$tmp/bin:$PATH"
export FINCH_TEST_LOG="$tmp/calls"
export FINCH_APP_PATH=calculator
export FINCH_CREDENTIALS_DIR="$tmp/credentials"

"$root/docker-entrypoint.sh" run --config /data/finch.yml
test "$(cat "$tmp/calls")" = 'run --config /data/finch.yml'
test ! -e "$tmp/credentials/calculator.json"

# First-run AviaryMCP containers must start finchd without a bootstrap secret;
# the control socket owns the scoped device-enrollment flow.
: > "$tmp/calls"
"$root/docker-entrypoint.sh" run
test "$(cat "$tmp/calls")" = run
