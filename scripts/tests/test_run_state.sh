#!/usr/bin/env bash
# run-state.sh: items and slots taken once, given back on every way out, and a
# dead run's locks freed without losing what it wrote.
. "$(dirname "$0")/helpers.sh"

# as <session> <verb> … — run-state.sh as that session, every test session
# running, and a comment from each on GitHub unless the case says otherwise
DEFAULT_COMMENTS='[{"user":{"login":"dev-bot"},"body":"Done. sess-a sess-b sess-c"}]'
as() {
  local s="$1"; shift
  CLAUDE_CODE_SESSION_ID="$s" STUB_RUNNING="${RUNNING-sess-a sess-b sess-c}" \
    STUB_COMMENTS="${STUB_COMMENTS-$DEFAULT_COMMENTS}" state "$@"
}
slot() { git -C "$HOME/work/slots/$1" rev-parse --abbrev-ref HEAD 2>/dev/null; }


CASE="start takes the item and a slot, on a new branch"; sandbox; origin_checkout
as sess-a start 7 feat/7-flag
is "$RC" 0 "exit"
has "$OUT" "slot 1: $HOME/work/slots/1 on feat/7-flag" "says where"
is "$(slot 1)" feat/7-flag "branch"
is "$(field items/7.md state)" active "item state"
is "$(field items/7.md slot)" 1 "item slot"
is "$(as sess-a held; echo "$OUT")" 7 "held"
done_

CASE="one item, one run; a second run takes another item and slot"; sandbox; origin_checkout
as sess-a start 7 feat/7
as sess-b start 7 feat/7
is "$RC" 1 "the item is taken"
has "$(cat "$HOME/err")" "held by session sess-a" "names the holder"
as sess-b start 8 feat/8
is "$RC" 0 "another item"
is "$(slot 2)" feat/8 "in the next slot"
done_

CASE="every slot in use refuses, and keeps nothing"; sandbox; origin_checkout
echo "- slots: 1" >> "$HOME/work/CONFIG.md"
as sess-a start 7 feat/7
as sess-b start 8 feat/8
is "$RC" 1 "exit"
has "$(cat "$HOME/err")" "all 1 slots are in use" "says why"
[ ! -d "$SD_LOCKS/item-8" ] || fail "kept the item it could not work on"
done_

CASE="finish gives everything back and logs the run"; sandbox; origin_checkout
as sess-a start 7 feat/7
mkdir -p "$HOME/work/slots/1/dist"; echo built > "$HOME/work/slots/1/dist/out"
STUB_PULL='{"state":"open","user":{"login":"dev-bot"},"body":"x\n\nFixes #7\n\nWritten by this agent — https://p/a/x?s=sess-a"}' \
  as sess-a finish pr-opened 21
is "$RC" 0 "exit"
[ -z "$(ls "$SD_LOCKS")" ] || fail "locks left: $(ls "$SD_LOCKS")"
is "$(field items/7.md state)" parked "parked"
is "$(field items/7.md pr)" 21 "pr"
is "$(slot 1)" HEAD "the slot lets go of the branch"
[ -e "$HOME/work/slots/1/dist" ] || fail "the build output went with it"
has "$(cat "$HOME/work/TICK.log")" "pr-opened session=sess-a issue=7 slot=1 pr=21 minutes=" "log line"
as sess-b start 8 feat/8; as sess-c start 7
is "$(slot 1)" feat/8 "8 took the first free slot"
is "$(slot 2)" feat/7 "7 resumes its branch from the item record"
done_

CASE="an item goes back to its own slot when it is free"; sandbox; origin_checkout
as sess-a start 7 feat/7; as sess-b start 8 feat/8
as sess-a finish nothing; as sess-b finish nothing
as sess-c start 8
is "$(slot 2)" feat/8 "slot 2, its last"
done_

CASE="a slot with unsaved work is never switched"; sandbox; origin_checkout
as sess-a start 7 feat/7
echo wip > "$HOME/work/slots/1/new.txt"
RUNNING="sess-b" as sess-b start 8 feat/8
is "$RC" 3 "the dead run's slot holds unsaved work"
has "$(cat "$HOME/err")" "uncommitted changes on feat/7" "says what"
[ -f "$HOME/work/slots/1/new.txt" ] || fail "the work was thrown away"
is "$(slot 1)" feat/7 "left on its branch"
done_

CASE="a branch on origin is checked out from its tip"; sandbox; origin_checkout
seed="$(mktemp -d)"; git clone -q "$HOME/widgets.git" "$seed/c"
git -C "$seed/c" switch -q -c feat/9; echo nine > "$seed/c/nine"; git -C "$seed/c" add nine
gitc -C "$seed/c" commit -qm nine; git -C "$seed/c" push -q origin feat/9; rm -rf "$seed"
as sess-a start 9 feat/9
is "$RC" 0 "exit"
[ -f "$HOME/work/slots/1/nine" ] || fail "not on the remote tip"
done_

CASE="sweep frees a dead run's locks and counts it on its item"; sandbox
lock slot-1 session=sess-x item=7 slot=1 "since=$(ago 30)" phase=building "phase_at=$(ago 20)"
lock item-7 session=sess-x item=7 slot=1
lock slot-2 session=sess-y item=8 slot=2 boot=boot-0
lock slot-3 session=sess-z item=9 slot=3
STUB_RUNNING="sess-z" state sweep
is "$OUT" "$(printf '#7\n#8')" "names the abandoned items"
[ ! -d "$SD_LOCKS/slot-1" ] && [ ! -d "$SD_LOCKS/item-7" ] || fail "a dead session's locks stayed"
[ ! -d "$SD_LOCKS/slot-2" ] || fail "a lock from an earlier boot stayed"
[ -d "$SD_LOCKS/slot-3" ] || fail "freed a live run's slot"
is "$(field items/7.md abandoned)" 1 "counted"
is "$(field items/7.md state)" abandoned "state"
has "$(cat "$HOME/work/TICK.log")" "abandoned session=sess-x issue=7 slot=1" "logged"
done_

CASE="a runtime that does not answer frees nothing"; sandbox
lock slot-1 session=sess-x item=7 slot=1
STUB_RUNTIME_DOWN=1 state sweep
[ -d "$SD_LOCKS/slot-1" ] || fail "freed on a guess"
done_

CASE="one cluster: a second item waits, and a dead holder leaves it dirty"; sandbox; origin_checkout
as sess-a start 7 feat/7; as sess-b start 8 feat/8
as sess-a cluster
is "$RC" 0 "the first takes it"
has "$OUT" "cluster: yours." "says so"
as sess-b cluster
is "$RC" 1 "the second waits"
is "$(field items/8.md state)" waiting-cluster "recorded"
RUNNING="sess-b" as sess-b cluster
is "$RC" 0 "the holder died: it is freed"
has "$OUT" "run cluster_uninstall before anything else" "told it is dirty"
as sess-b finish pr-updated
[ ! -d "$SD_LOCKS/cluster" ] || fail "finish kept the cluster"
done_

CASE="nothing is held without a session id"; sandbox; origin_checkout
CLAUDE_CODE_SESSION_ID= state start 7 feat/7
is "$RC" 2 "exit"
[ ! -d "$SD_LOCKS/item-7" ] || fail "took a lock nobody can prove alive"
done_

CASE="finish refuses until the work is pushed and reported"; sandbox; origin_checkout
as sess-a start 7 feat/7
echo change > "$HOME/work/slots/1/change.txt"
as sess-a finish pr-updated
is "$RC" 1 "unpushed"
has "$(cat "$HOME/err")" "push it to its branch first" "says so"
rm "$HOME/work/slots/1/change.txt"
STUB_COMMENTS='[{"user":{"login":"dev-bot"},"body":"another run, sess-b"}]' as sess-a finish pr-updated
is "$RC" 1 "no comment from this run"
has "$(cat "$HOME/err")" "no comment from this run on #7" "says where"
[ -d "$SD_LOCKS/item-7" ] || fail "gave the item back unreported"
STUB_PULL='{"state":"open","user":{"login":"dev-bot"},"body":"Fixes #8\nhttps://p/a/x?s=sess-a"}' as sess-a finish pr-opened 21
is "$RC" 1 "the pull request names another issue"
has "$(cat "$HOME/err")" "does not say Fixes #7" "says what"
STUB_ISSUE='{"labels":[{"name":"agent/in-progress"}]}' as sess-a finish blocked
is "$RC" 1 "blocked, but still claimed and not failed"
has "$(cat "$HOME/err")" "still carries agent/in-progress; #7 does not carry agent/failed" "labels"
STUB_ISSUE='{"labels":[{"name":"agent/failed"}]}' as sess-a finish blocked
is "$RC" 0 "reported and labelled"
done_

CASE="GitHub unreadable: the run closes, logged as unverified"; sandbox; origin_checkout
as sess-a start 7 feat/7
STUB_COMMENTS= as sess-a finish pr-updated
is "$RC" 0 "exit"
has "$(cat "$HOME/work/TICK.log")" "report=unverified" "logged"
done_

CASE="finish with nothing held still logs the run"; sandbox
as sess-a finish nothing
is "$RC" 0 "exit"
has "$(cat "$HOME/work/TICK.log")" "nothing session=sess-a issue=- slot=-" "log line"
done_

exit "$FAILED"
