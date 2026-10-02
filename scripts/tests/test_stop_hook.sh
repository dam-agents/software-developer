#!/usr/bin/env bash
# enforce-finish.sh: a turn that holds an item does not end, up to a limit;
# install.sh registers it once and keeps everything else.
. "$(dirname "$0")/helpers.sh"
HOOK="$SCRIPTS/harness/claude-code/enforce-finish.sh"
stop() { OUT="$(printf '{"session_id":"%s","stop_hook_active":false}' "$1" | bash "$HOOK" 2>&1)"; RC=$?; }

CASE="a session holding nothing stops"; sandbox
lock item-7 session=sess-b item=7
stop sess-a
is "$RC" 0 "exit"
is "$OUT" "" "silent"
done_

CASE="a session holding an item is kept going, three times"; sandbox
lock item-7 session=sess-a item=7 phase=verify
stop sess-a
is "$RC" 2 "first"
has "$OUT" "Stop blocked (1/3): this run still holds #7, last at \"verify\"" "names the item"
has "$OUT" "run-state.sh\" finish" "says how to end"
stop sess-a; stop sess-a
is "$RC" 2 "third"
has "$OUT" "This is the last block" "the way out"
stop sess-a
is "$RC" 0 "then it lets the stop through; the precheck finds the run dead"
done_

CASE="garbage in never blocks"; sandbox
OUT="$(echo 'not json' | bash "$HOOK" 2>&1)"; is "$?" 0 "exit"
done_

CASE="install registers the hook once, beside the settings already there"; sandbox
echo '{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"/other.sh"}]}]}}' > "$HOME/.claude/settings.json"
FORCE_INSTALL=1 bash "$SCRIPTS/harness/claude-code/install.sh" >/dev/null
FORCE_INSTALL=1 bash "$SCRIPTS/harness/claude-code/install.sh" >/dev/null
s="$HOME/.claude/settings.json"
is "$(jq -r .model "$s")" opus "kept the settings"
is "$(jq -r '[.hooks.Stop[].hooks[].command] | join(" ")' "$s")" "/other.sh $HOME/scripts/harness/claude-code/enforce-finish.sh" "once, after the other"
done_

exit "$FAILED"
