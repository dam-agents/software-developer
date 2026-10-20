#!/usr/bin/env bash
# audit.sh — the deterministic half of the weekly audit (docs/audit.md). app/src/developer/audit.ts.
exec "$BASH" "$(dirname "$0")/../bin/sd" audit "$@"
