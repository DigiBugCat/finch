#!/bin/sh
set -eu

printf '%s\n' "$*" >> "$FINCH_TEST_LOG"
