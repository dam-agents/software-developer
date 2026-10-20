#!/usr/bin/env bash
# session-link.sh — the platform link to this run's session, for every pull request and
# review answer. app/src/developer/harness.ts.
exec "$BASH" "$(dirname "$0")/../bin/sd" session-link "$@"
