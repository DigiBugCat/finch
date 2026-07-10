#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lock="$root/go.sum"

if [ ! -f "$lock" ]; then
  echo "go.sum not found: $lock" >&2
  exit 1
fi

actual=$(sha256sum "$lock" | awk '{print $1}')
if [ "$#" -eq 0 ]; then
  printf '%s\n' "$actual"
  exit 0
fi

if [ "$#" -ne 1 ]; then
  echo "usage: $0 [expected-sha256]" >&2
  exit 2
fi

if [ "$actual" != "$1" ]; then
  echo "go.sum checksum mismatch: expected $1, got $actual" >&2
  exit 1
fi

printf 'go.sum checksum verified: %s\n' "$actual"
