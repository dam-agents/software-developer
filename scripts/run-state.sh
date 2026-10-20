#!/usr/bin/env bash
# run-state.sh — the one writer of the tick's state: items, slots and the exclusive lock.
# Its verbs and their contract: app/src/developer/run-state.ts; docs/runs.md.
exec "$BASH" "$(dirname "$0")/../bin/sd" run-state "$@"
