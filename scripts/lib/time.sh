#!/usr/bin/env bash
# time.sh — UTC timestamps for the state files, and reading them back. Sourced.
# GNU date on the pod; the BSD fallbacks let the tests run on a Mac.

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# epoch <ISO-UTC> — seconds since the epoch; fails on an empty or unparsable time
epoch() {
  [ -n "${1:-}" ] || return 1
  date -u -d "$1" +%s 2>/dev/null ||
    TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null
}

# mtime <file> — when it was last written, in seconds since the epoch
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
