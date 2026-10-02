#!/usr/bin/env bash
# Stop hook (Claude Code): refuses to end a turn while this session still holds
# an item. Nobody watches a scheduled run, so a turn that ends mid-work — a
# summary, a question, "I'll continue next time" — is work nobody hears about
# until a later run finds it dead. Exit 2 keeps the turn going and shows the
# model stderr: what it holds, and how to finish.
#
# Read-only: it looks at the locks run-state.sh keeps and counts its own
# blocks there. After MAX_BLOCKS it lets the stop through — the harness ends a
# turn after eight blocks anyway — and the next precheck finds the run dead and
# hands its item on. Anything unexpected exits 0: this hook may never be what
# breaks a run. Registered by install.sh beside it.
set -u
MAX_BLOCKS=3
LOCKS="${SD_LOCKS:-/dev/shm/software-developer}"

INPUT="$(cat 2>/dev/null || true)"
command -v jq >/dev/null 2>&1 || exit 0
sid="$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)"
[ -n "$sid" ] || exit 0
. "$(cd "$(dirname "$0")/../.." && pwd)/lib/config.sh" 2>/dev/null || exit 0

lock=""
for l in "$LOCKS"/item-*; do
  [ -d "$l" ] && [ "$(kv "$l/owner" session)" = "$sid" ] && { lock="$l"; break; }
done
[ -n "$lock" ] || exit 0

item="$(kv "$lock/owner" item)"; phase="$(kv "$lock/owner" phase)"
n="$(cat "$lock/stop_blocks" 2>/dev/null)"; case "$n" in '' | *[!0-9]*) n=0 ;; esac
[ "$n" -ge "$MAX_BLOCKS" ] && exit 0
n=$((n + 1)); echo "$n" > "$lock/stop_blocks" 2>/dev/null || exit 0

{
  echo "Stop blocked ($n/$MAX_BLOCKS): this run still holds #$item, last at \"$phase\"."
  echo
  echo "No one is watching this session — nothing you write here is read. The run"
  echo "ends with its outcome on GitHub, and \`run-state.sh finish\`, never mid-work:"
  echo
  echo "1. Commit and push everything in your slot."
  echo "2. Report on the issue or its pull request: what you did, where it stands,"
  echo "   what happens next, with this run's session link"
  echo "   (bash \"\$HOME/scripts/session-link.sh\"). A question for a person goes"
  echo "   there too, with the needs-info label — never into this turn."
  echo "3. bash \"\$HOME/scripts/run-state.sh\" finish <outcome> [pr]"
  if [ "$n" -ge "$MAX_BLOCKS" ]; then
    echo
    echo "This is the last block. If the work cannot go on, finish \`blocked\`:"
    echo "comment the issue with what fails and what you tried, swap the claim"
    echo "for the failed label, and finish blocked. That is always possible."
  else
    echo
    echo "Or carry on with the work, if it is not done."
  fi
} >&2
exit 2
