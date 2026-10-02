#!/usr/bin/env bash
# Registers this definition's Claude Code hooks in ~/.claude/settings.json:
# enforce-finish.sh on Stop. Idempotent; keeps every other hook and setting.
# On another harness it says so and exits 0. A hook registered here takes
# effect from the next session.
set -u
if [ "${CLAUDECODE:-}" != 1 ] && [ -z "${FORCE_INSTALL:-}" ]; then
  echo "not the Claude Code harness — no hooks installed"
  exit 0
fi
command -v jq >/dev/null 2>&1 || { echo "jq missing — no hooks installed"; exit 1; }

SETTINGS="$HOME/.claude/settings.json"
HOOK="$HOME/scripts/harness/claude-code/enforce-finish.sh"
mkdir -p "$(dirname "$SETTINGS")"
[ -s "$SETTINGS" ] || echo '{}' > "$SETTINGS"

if jq -e --arg h "$HOOK" '[.hooks.Stop[]?.hooks[]?.command] | index($h)' "$SETTINGS" >/dev/null 2>&1; then
  echo "Stop hook already installed ($SETTINGS)"
  exit 0
fi
tmp="$(mktemp)"
if jq --arg h "$HOOK" '.hooks //= {} | .hooks.Stop = ((.hooks.Stop // []) + [{hooks: [{type: "command", command: $h, timeout: 15}]}])' \
    "$SETTINGS" > "$tmp"; then
  mv "$tmp" "$SETTINGS"
  echo "Stop hook installed into $SETTINGS -> $HOOK"
else
  rm -f "$tmp"; echo "could not update $SETTINGS — left unchanged"; exit 1
fi
