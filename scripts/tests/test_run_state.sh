#!/usr/bin/env bash
# run-state.sh: who may write the record, and what a closed run leaves behind.
. "$(dirname "$0")/helpers.sh"

CASE="claim opens a fresh record"; sandbox
record run_state=idle outcome=pr-opened pr=12
state claim 2026-09-24T10:20:00Z
is "$(field RUN.md run_state)" running "state"
is "$(field RUN.md session)" pending "session"
is "$(field RUN.md occurrence)" 2026-09-24T10:20:00Z "occurrence"
is "$(field RUN.md pr)" "" "the last run's pr is not carried over"
done_

CASE="start adopts the precheck's claim"; sandbox
state claim X
CLAUDE_CODE_SESSION_ID=sess-a state start
is "$RC" 0 "exit"
is "$(field RUN.md session)" sess-a "session"
is "$(field RUN.md phase)" started "phase"
CLAUDE_CODE_SESSION_ID=sess-a state start
is "$RC" 0 "start again from the same session"
done_

CASE="start with nothing claimed records a manual run"; sandbox
CLAUDE_CODE_SESSION_ID=sess-b state start
is "$(field RUN.md occurrence)" manual "occurrence"
is "$(field RUN.md session)" sess-b "session"
done_

CASE="start refuses while another session holds the record"; sandbox
record run_state=running session=sess-a phase=building "phase_at=$(ago 5)"
CLAUDE_CODE_SESSION_ID=sess-b state start
is "$RC" 1 "exit"
has "$(cat "$HOME/err")" "sess-a" "names the holder"
is "$(field RUN.md session)" sess-a "record untouched"
done_

CASE="phase moves the stamp and keeps the claim"; sandbox
state claim X; claimed="$(field RUN.md claimed_at)"
CLAUDE_CODE_SESSION_ID=sess-a state start
CLAUDE_CODE_SESSION_ID=sess-a state phase "building: mise run test" 42
is "$(field RUN.md phase)" "building: mise run test" "phase text survives its colon"
is "$(field RUN.md issue)" 42 "issue"
is "$(field RUN.md claimed_at)" "$claimed" "claimed_at"
CLAUDE_CODE_SESSION_ID=sess-z state phase "hijack"
is "$RC" 1 "a non-holder cannot write a phase"
done_

CASE="finish closes the record and logs the run"; sandbox
record run_state=running session=sess-a occurrence=O "claimed_at=$(ago 37)" phase=x "phase_at=$(ago 1)" issue=42
CLAUDE_CODE_SESSION_ID=sess-a state finish pr-opened 51
is "$RC" 0 "exit"
is "$(field RUN.md run_state)" idle "state"
is "$(field RUN.md outcome)" pr-opened "outcome"
line="$(cat "$HOME/work/TICK.log")"
has "$line" "pr-opened session=sess-a occurrence=O issue=42 pr=51 minutes=37" "log line"
done_

CASE="abandon is a no-op on a closed record"; sandbox
record run_state=idle outcome=nothing
state abandon "why"
is "$RC" 0 "exit"
[ ! -f "$HOME/work/TICK.log" ] || fail "logged an abandon of nothing"
done_

exit "$FAILED"
