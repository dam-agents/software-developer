#!/usr/bin/env bash
# precheck.sh — the tick's schedule precheck: 0 there is work, and stdout goes into the
# prompt · 1 skip · anything else broken. app/src/developer/precheck.ts.
exec "$BASH" "$(dirname "$0")/../bin/sd" precheck "$@"
