#!/usr/bin/env bash
# precheck.sh: the verdict for every combination of sandbox state, run record
# and work on GitHub.
. "$(dirname "$0")/helpers.sh"

IDLE='{"idle":true,"backgroundWork":[]}'
BUSY='{"idle":false,"backgroundWork":[]}'
ISSUE7='[{"number":7,"title":"Add a flag","url":"https://gh/7","labels":[{"name":"agent/implement"}]}]'

CASE="idle and nothing to do declines without a claim"; sandbox
STUB_STATUS="$IDLE" precheck
is "$RC" 1 "exit"
[ ! -f "$HOME/work/RUN.md" ] || fail "claimed a run that was never let through"
done_

CASE="idle with work lets it through and claims it"; sandbox
STUB_STATUS="$IDLE" STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 0 "exit"
has "$OUT" "#7 Add a flag" "worklist"
is "$(field RUN.md run_state)" running "claimed"
is "$(field RUN.md session)" pending "waiting for the run"
is "$(field RUN.md occurrence)" 2026-09-24T10:20:00Z "occurrence"
done_

CASE="busy with no record declines before any GitHub call"; sandbox
STUB_STATUS="$BUSY" STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 1 "exit"
no_gh
[ -n "$(field GATE.md busy_since)" ] || fail "busy streak not started"
done_

CASE="a busy streak past stuck_after_min lets a diagnostic through"; sandbox
printf -- '- busy_since: %s\n' "$(ago 130)" > "$HOME/work/GATE.md"
STUB_STATUS='{"idle":false,"backgroundWork":[{"id":"b1","description":"dev server on :8080"}]}' precheck
is "$RC" 0 "exit"
has "$OUT" "DIAGNOSTIC RUN" "diagnostic"
has "$OUT" "No run holds work/RUN.md" "names the case"
has "$OUT" "b1: dev server on :8080" "names the background work"
no_gh
[ ! -f "$HOME/work/RUN.md" ] || fail "a diagnostic run must not claim"
is "$(field GATE.md diagnoses)" 1 "counted"
has "$(cat "$HOME/work/TICK.log")" "diagnostic" "logged"
done_

CASE="a second diagnostic waits out the doubled window"; sandbox
printf -- '- busy_since: %s\n- diagnosed_at: %s\n- diagnoses: 1\n' "$(ago 300)" "$(ago 90)" > "$HOME/work/GATE.md"
STUB_STATUS="$BUSY" precheck
is "$RC" 1 "90 minutes into a 2-hour window"
printf -- '- busy_since: %s\n- diagnosed_at: %s\n- diagnoses: 1\n' "$(ago 300)" "$(ago 125)" > "$HOME/work/GATE.md"
STUB_STATUS="$BUSY" precheck
is "$RC" 0 "past it"
done_

CASE="busy with a run that stamped a phase recently declines"; sandbox
record run_state=running session=sess-a "claimed_at=$(ago 200)" phase=building "phase_at=$(ago 10)"
STUB_STATUS="$BUSY" precheck
is "$RC" 1 "exit"
no_gh
done_

CASE="busy with a run whose transcript moved recently declines"; sandbox
record run_state=running session=sess-a "claimed_at=$(ago 200)" phase=building "phase_at=$(ago 190)"
t="$HOME/.claude/projects/-home-agent-work/sess-a.jsonl"; : > "$t"; touch_ago "$t" 3
STUB_STATUS="$BUSY" precheck
is "$RC" 1 "the transcript is a sign of life"
done_

CASE="busy with a run silent past stuck_after_min asks for a diagnostic"; sandbox
record run_state=running session=sess-a "claimed_at=$(ago 200)" phase=building "phase_at=$(ago 190)"
STUB_STATUS="$BUSY" precheck
is "$RC" 0 "exit"
has "$OUT" "held by session sess-a, last at \"building\"" "names the holder"
is "$(field RUN.md session)" sess-a "the record is left alone"
done_

CASE="stuck_after_min is read from CONFIG.md"; sandbox
echo "- stuck_after_min: 300" >> "$HOME/work/CONFIG.md"
record run_state=running session=sess-a "claimed_at=$(ago 200)" phase=building "phase_at=$(ago 190)"
STUB_STATUS="$BUSY" precheck
is "$RC" 1 "190 quiet minutes is under 300"
done_

CASE="idle with a record claimed moments ago waits for the session to open"; sandbox
record run_state=running session=pending "claimed_at=$(ago 0)" phase=claimed "phase_at=$(ago 0)"
STUB_STATUS="$IDLE" STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 1 "exit"
is "$(field RUN.md run_state)" running "left open"
done_

CASE="idle with an open record abandons it and says so"; sandbox
record run_state=running session=sess-a occurrence=O "claimed_at=$(ago 30)" phase=building "phase_at=$(ago 20)" issue=7
printf -- '- busy_since: %s\n' "$(ago 40)" > "$HOME/work/GATE.md"
STUB_STATUS="$IDLE" STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 0 "exit"
has "$OUT" "session sess-a, last at \"building\"" "takeover note"
has "$(cat "$HOME/work/TICK.log")" "abandoned session=sess-a occurrence=O issue=7" "logged"
is "$(field RUN.md session)" pending "re-claimed for this run"
[ ! -f "$HOME/work/GATE.md" ] || fail "the busy streak outlived an idle sandbox"
done_

CASE="an unanswerable runtime with no record lets work through, warned"; sandbox
STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 0 "exit"
has "$OUT" "did not say whether the sandbox is busy" "warning"
done_

CASE="an unanswerable runtime while a run holds the record counts as busy"; sandbox
record run_state=running session=sess-a "claimed_at=$(ago 20)" phase=building "phase_at=$(ago 5)"
STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 1 "exit"
no_gh
done_

CASE="a claimed issue is resumed only when no pull request names it"; sandbox
STUB_STATUS="$IDLE" \
STUB_PRS='[{"number":21,"title":"x","url":"https://gh/pr/21","reviewDecision":null,"latestReviews":[],"body":"Fixes #45\n\nFixes #7"}]' \
STUB_CLAIMED='[{"number":7,"title":"Seven","url":"https://gh/7"},{"number":4,"title":"Four","url":"https://gh/4"},{"number":45,"title":"Forty-five","url":"https://gh/45"}]' \
precheck
is "$RC" 0 "exit"
has "$OUT" "#4 Four" "#4 is not named by '#45'"
lacks "$OUT" "#7 Seven" "#7 has its pull request"
lacks "$OUT" "#45 Forty-five" "#45 has its pull request"
done_

exit "$FAILED"
