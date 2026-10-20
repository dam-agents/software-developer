#!/usr/bin/env bash
# Stop hook (Claude Code), registered by install.sh beside it: keeps an unattended run's turn
# going while it holds an item. app/src/developer/harness.ts → enforceFinish.
exec "$BASH" "$(dirname "$0")/../../../bin/sd" hook-stop "$@"
