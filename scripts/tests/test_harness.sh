#!/usr/bin/env bash
# The Claude Code wiring: the Stop hook keeps a turn that holds an item going,
# up to a limit; install.sh registers it and links the skills.
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

CASE="install links our skills and the repository's, and leaves a real directory alone"; sandbox
mkdir -p "$HOME/.agents/skills/implement-issue" "$HOME/work/widgets/.agents/skills/build-it"
: > "$HOME/.agents/skills/implement-issue/SKILL.md"; : > "$HOME/work/widgets/.agents/skills/build-it/SKILL.md"
FORCE_INSTALL=1 bash "$SCRIPTS/harness/claude-code/install.sh" > "$HOME/out"; RC=$?
is "$RC" 0 "exit"
[ -f "$HOME/.claude/skills/implement-issue/SKILL.md" ] || fail "our skill does not resolve"
[ -f "$HOME/work/.claude/skills/build-it/SKILL.md" ] || fail "the repository's skill does not resolve"
has "$(cat "$HOME/out")" "linked work/.claude/skills -> widgets/.agents/skills (1 skills)" "says so"
mkdir -p "$HOME/work/widgets/.claude/skills/other"
FORCE_INSTALL=1 bash "$SCRIPTS/harness/claude-code/install.sh" >/dev/null
[ -d "$HOME/work/.claude/skills/other" ] || fail ".claude/skills is preferred when the repository has it"
rm "$HOME/work/.claude/skills"; mkdir "$HOME/work/.claude/skills"
FORCE_INSTALL=1 bash "$SCRIPTS/harness/claude-code/install.sh" > "$HOME/out"; RC=$?
is "$RC" 1 "a real directory is not replaced"
has "$(cat "$HOME/out")" "is not a link — left alone" "says so"
done_

CASE="verify fails unlinked repository skills"; sandbox; onboarded
mkdir -p "$HOME/work/widgets/.agents/skills/build-it"
verify
has "$OUT" "FAIL harness.repo_skills" "unlinked"
FORCE_INSTALL=1 bash "$SCRIPTS/harness/claude-code/install.sh" >/dev/null
verify
has "$OUT" "ok   harness.repo_skills" "linked"
done_

exit "$FAILED"
