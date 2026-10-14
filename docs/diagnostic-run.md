# The diagnostic run

A prompt that opens with **DIAGNOSTIC RUN** is not a work run. Every slot is
held by a run the runtime still counts as running a turn, and the prompt names
those of them that have shown no sign of life for `stuck_after_min`. No new
work starts until a slot is free. Do not build, do not claim, do not call
`run-state.sh start`.

First title the session, best-effort, with `rename_session`:
`Diagnose stuck runs <UTC date> <HH:MM>` (`Diagnose stuck runs 2026-10-09
14:00`).

For each run it names, find what it is stuck on — `run-state.sh show`, the
tail of its transcript (`~/.claude/projects/*/<session>.jsonl`), whether a
build it started is still a live process and doing anything — and report
plainly what is stuck, since when, and what would free it. The report is the
whole job: stopping another session is the operator's call, and its locks free
themselves the moment its turn ends ([runs.md](runs.md)).
