#!/usr/bin/env bash
# Wires this definition into Claude Code: the Stop hook, our skills, the repository's skills.
# Idempotent. app/src/developer/harness.ts → install.
exec "$BASH" "$(dirname "$0")/../../../bin/sd" install "$@"
