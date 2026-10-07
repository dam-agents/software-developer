#!/usr/bin/env bash
# run-state.sh: items and slots taken once, given back on every way out, and a
# dead run's locks freed without losing what it wrote.
. "$(dirname "$0")/helpers.sh"

# as <session> <verb> … — run-state.sh as that session, every test session
# running, a comment from each on GitHub and an issue no one claimed unless the
# case says otherwise
DEFAULT_COMMENTS='[{"user":{"login":"dev-bot"},"body":"Done. sess-a sess-b sess-c"}]'
DEFAULT_ISSUE='{"labels":[]}'
as() {
  local s="$1"; shift
  CLAUDE_CODE_SESSION_ID="$s" STUB_RUNNING="${RUNNING-sess-a sess-b sess-c}" \
    STUB_COMMENTS="${STUB_COMMENTS-$DEFAULT_COMMENTS}" STUB_ISSUE="${STUB_ISSUE-$DEFAULT_ISSUE}" SD_WAIT_FOR="${SD_WAIT_FOR:-3}" SD_WAIT_POLL="${SD_WAIT_POLL:-1}" \
    state "$@"
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
STUB_ISSUE='{"labels":[]}' as sess-a finish released 21
is "$RC" 0 "exit"
[ -z "$(ls "$SD_LOCKS")" ] || fail "locks left: $(ls "$SD_LOCKS")"
is "$(field items/7.md state)" released "released"
is "$(field items/7.md pr)" 21 "pr"
is "$(slot 1)" HEAD "the slot lets go of the branch"
[ -e "$HOME/work/slots/1/dist" ] || fail "the build output went with it"
has "$(cat "$HOME/work/TICK.log")" "released session=sess-a issue=7 slot=1 pr=21 minutes=" "log line"
as sess-b start 8 feat/8; as sess-c start 7
is "$(slot 1)" feat/8 "8 took the first free slot"
is "$(slot 2)" feat/7 "7 resumes its branch from the item record"
done_

CASE="with slack_channel set, finish says what to post, and only for a moment a person acts on"; sandbox; origin_checkout
as sess-a start 7 feat/7
STUB_ISSUE='{"labels":[]}' as sess-a finish released 21
lacks "$(cat "$HOME/err")" "notify:" "unset: no posts"
echo "- slack_channel: C0123ABCD" >> "$HOME/work/CONFIG.md"
as sess-a start 7 feat/7
STUB_ISSUE='{"labels":[]}' as sess-a finish released 21
has "$(cat "$HOME/err")" "notify: if #21 is still open, post that it is ready to merge to slack_channel C0123ABCD" "ready to merge"
as sess-a start 7 feat/7
STUB_ISSUE='{"labels":[{"name":"agent/failed"}]}' as sess-a finish blocked
has "$(cat "$HOME/err")" "notify: post this blocked to slack_channel C0123ABCD" "blocked"
as sess-a start 7 feat/7
as sess-a finish waiting-lock
lacks "$(cat "$HOME/err")" "notify:" "nothing for a person to do"
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

CASE="one exclusive lock: a second item waits, and a dead holder leaves it dirty"; sandbox; origin_checkout
as sess-a start 7 feat/7; as sess-b start 8 feat/8
as sess-a lock
is "$RC" 0 "the first takes it"
has "$OUT" "lock: yours." "says so"
as sess-b lock
is "$RC" 1 "the second waits"
is "$(field items/8.md state)" waiting-lock "recorded"
RUNNING="sess-b" as sess-b lock
is "$RC" 0 "the holder died: it is freed"
has "$OUT" "bring what exclusive names back to a known state" "told it is dirty"
as sess-b finish pr-updated
[ ! -d "$SD_LOCKS/exclusive" ] || fail "finish kept the lock"
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
echo "- babysat_out: yes" >> "$HOME/work/items/7.md"
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

# view <state> <review decision> <mergeable> <checks json> [reviews json]
view() { printf '{"state":"%s","reviewDecision":"%s","mergeable":"%s","headRefOid":"abc","statusCheckRollup":%s,"latestReviews":%s}' \
  "$1" "$2" "$3" "$4" "${5:-[]}"; }
RUNNING_CHECK='[{"name":"e2e","status":"IN_PROGRESS","conclusion":""}]'
GREEN='[{"name":"e2e","conclusion":"SUCCESS","completedAt":"2026-09-24T10:00:00Z"}]'

CASE="a run keeps its pull request until it is done"; sandbox; origin_checkout
as sess-a start 7 feat/7
STUB_PULL='{"state":"open","user":{"login":"dev-bot"},"body":"Fixes #7 sess-a"}' as sess-a finish pr-opened 21
is "$RC" 1 "opening it is not the end"
has "$(cat "$HOME/err")" "run-state.sh\" wait 21" "says how to babysit"
[ -d "$SD_LOCKS/item-7" ] || fail "gave the item back"
done_

CASE="wait comes back with nothing yet while checks run, then with a review"; sandbox; origin_checkout
as sess-a start 7 feat/7
STUB_PR_VIEW="$(view OPEN REVIEW_REQUIRED MERGEABLE "$RUNNING_CHECK")" as sess-a wait 21
is "$RC" 3 "nothing yet"
has "$OUT" "nothing yet — checks running. Call wait again" "says so"
has "$(field items/7.md pr)" 21 "remembers the pull request"
sleep 1; REVIEW="[{\"author\":{\"login\":\"guardian\"},\"state\":\"CHANGES_REQUESTED\",\"submittedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]"
STUB_PR_VIEWS="$(view OPEN REVIEW_REQUIRED MERGEABLE "$RUNNING_CHECK")
$(view OPEN CHANGES_REQUESTED MERGEABLE "$RUNNING_CHECK" "$REVIEW")" as sess-a wait 21
is "$RC" 0 "something to do"
has "$OUT" "reviewed by guardian (CHANGES_REQUESTED): resolve every finding" "what"
STUB_PR_VIEW="$(view OPEN CHANGES_REQUESTED MERGEABLE "$RUNNING_CHECK" "$REVIEW")" as sess-a wait 21
is "$RC" 3 "a review already answered is not new"
done_

CASE="wait says done once approved, green and mergeable, and then finish releases"; sandbox; origin_checkout
as sess-a start 7 feat/7
STUB_PR_VIEW="$(view OPEN APPROVED MERGEABLE "$GREEN")" as sess-a wait 21
is "$RC" 0 "exit"
has "$OUT" "done — approved, green and mergeable" "done"
STUB_ISSUE='{"labels":[]}' as sess-a finish released 21
is "$RC" 0 "released"
done_

CASE="a review on an approved pull request is not a round"; sandbox; origin_checkout
as sess-a start 7 feat/7
sleep 1; LATE="[{\"author\":{\"login\":\"guardian\"},\"state\":\"APPROVED\",\"submittedAt\":\"$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+1M +%Y-%m-%dT%H:%M:%SZ)\"}]"
STUB_PR_VIEW="$(view OPEN APPROVED MERGEABLE "$GREEN" "$LATE")" as sess-a wait 21
is "$RC" 0 "exit"
has "$OUT" "done — approved, green and mergeable" "done, not reviewed"
STUB_PR_VIEW="$(view OPEN APPROVED MERGEABLE "$RUNNING_CHECK" "$LATE")" as sess-a wait 21
is "$RC" 3 "checks still running: nothing yet"
done_

CASE="a failed check is something to do"; sandbox; origin_checkout
as sess-a start 7 feat/7
FAILING="[{\"name\":\"test\",\"conclusion\":\"FAILURE\",\"completedAt\":\"$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+1M +%Y-%m-%dT%H:%M:%SZ)\"}]"
STUB_PR_VIEW="$(view OPEN REVIEW_REQUIRED MERGEABLE "$FAILING")" as sess-a wait 21
is "$RC" 0 "exit"
has "$OUT" "checks failed: test" "names it"
done_

CASE="after babysit_max_hours, wait hands it on and finish lets it go"; sandbox; origin_checkout
echo "- babysit_max_hours: 1" >> "$HOME/work/CONFIG.md"
as sess-a start 7 feat/7
STUB_PR_VIEW="$(view OPEN REVIEW_REQUIRED MERGEABLE "$GREEN")" as sess-a wait 21
sed -i.bak "s/^- babysit_since: .*/- babysit_since: $(ago 61)/" "$HOME/work/items/7.md"
as sess-a wait 21
is "$RC" 4 "timeout"
has "$OUT" "babysat #21 for 1h" "says so"
as sess-a finish pr-updated 21
is "$RC" 0 "now it may go"
as sess-b start 7
is "$(field items/7.md babysat_out)" "" "the next run babysits afresh"
done_

PULL21='{"number":21,"state":"open","mergeable":true,"head":{"sha":"abc"},"user":{"login":"dev-bot"},"body":"Fixes #7 sess-a"}'
GREEN_RUNS='{"check_runs":[{"id":1,"name":"e2e","status":"completed","conclusion":"success","completed_at":"2026-09-24T10:00:00Z"}]}'

CASE="wait reads GraphQL only when the pull request changed"; sandbox; origin_checkout
as sess-a start 7 feat/7
STUB_ETAG='"e1"' STUB_PULL="$PULL21" STUB_PR_VIEW="$(view OPEN REVIEW_REQUIRED MERGEABLE "$RUNNING_CHECK")" as sess-a wait 21
is "$RC" 3 "nothing yet"
has "$OUT" "checks running" "the GraphQL verdict, kept"
is "$(grep -c '^pr view' "$HOME/gh.calls")" 1 "one GraphQL read for three looks"
done_

CASE="GraphQL refused, wait reads REST, and an approval there is never done"; sandbox; origin_checkout
as sess-a start 7 feat/7
STUB_PULL="$PULL21" STUB_PR_VIEW= STUB_CHECKS="$GREEN_RUNS" \
STUB_REVIEWS='[{"user":{"login":"maintainer"},"state":"APPROVED","submitted_at":"2020-01-01T00:00:00Z"}]' as sess-a wait 21
is "$RC" 3 "not done"
has "$OUT" "approved by its reviews and green; GitHub's review decision is unreadable" "says why"
sleep 1; NOWZ="$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+1M +%Y-%m-%dT%H:%M:%SZ)"
STUB_PULL="$PULL21" STUB_PR_VIEW= STUB_CHECKS="$GREEN_RUNS" \
STUB_REVIEWS="[{\"user\":{\"login\":\"guardian\"},\"state\":\"CHANGES_REQUESTED\",\"submitted_at\":\"$NOWZ\"}]" as sess-a wait 21
is "$RC" 0 "a review is still something to do"
has "$OUT" "reviewed by guardian (CHANGES_REQUESTED)" "what"
done_

CASE="finish with nothing held still logs the run"; sandbox
as sess-a finish nothing
is "$RC" 0 "exit"
has "$(cat "$HOME/work/TICK.log")" "nothing session=sess-a issue=- slot=-" "log line"
done_


CASE="label_mine: pr-opened needs the label; a bot's login matches in any spelling"; sandbox; origin_checkout
sed -i.bak 's/^- author: .*/- author: dev-app[bot]/' "$HOME/work/CONFIG.md"
echo "- label_mine: agent/mine" >> "$HOME/work/CONFIG.md"
as sess-a start 7 feat/7
echo "- babysat_out: yes" >> "$HOME/work/items/7.md"
STUB_PULL='{"state":"open","user":{"login":"Dev-App[bot]"},"labels":[],"body":"Fixes #7 sess-a"}' as sess-a finish pr-opened 21
is "$RC" 1 "unlabelled"
has "$(cat "$HOME/err")" "does not carry agent/mine" "says what"
lacks "$(cat "$HOME/err")" "was not opened by" "the login matched"
STUB_PULL='{"state":"open","user":{"login":"dev-app[bot]"},"labels":[{"name":"agent/mine"}],"body":"Fixes #7 sess-a"}' as sess-a finish pr-opened 21
is "$RC" 0 "labelled"
done_

CASE="start refuses another agent's work: its claim, its pull request, an unreadable issue"; sandbox; origin_checkout
sed -i.bak 's/^- author: .*/- author: dev-app[bot]/' "$HOME/work/CONFIG.md"
echo "- label_mine: agent/mine" >> "$HOME/work/CONFIG.md"
STUB_ISSUE='{"labels":[{"name":"agent/in-progress"}]}' as sess-a start 7 feat/7
is "$RC" 1 "claimed without agent/mine"
has "$(cat "$HOME/err")" "another agent's claim" "says why"
is "$(slot 1)" "" "no slot was touched"
[ ! -d "$SD_LOCKS/item-7" ] || fail "the item stays free"
THEIRS='[{"number":99,"user":{"login":"dev-app[bot]"},"labels":[],"body":"Fixes #7"}]'
STUB_REST_PULLS="$THEIRS" as sess-a start 7 feat/7
is "$RC" 1 "named by a pull request without agent/mine"
has "$(cat "$HOME/err")" "pull request #99, not ours" "names it"
STUB_ISSUE= as sess-a start 7 feat/7
is "$RC" 1 "unreadable is not ours"
has "$(cat "$HOME/err")" "was not measured" "says so"
STUB_PULL='{"number":21,"user":{"login":"dev-app[bot]"},"labels":[]}' as sess-a start pr21 feat/x
is "$RC" 1 "a pull request item without agent/mine"
MINE='[{"number":98,"user":{"login":"dev-app[bot]"},"labels":[{"name":"agent/mine"}],"body":"Fixes #7"}]'
STUB_REST_PULLS="$MINE" STUB_ISSUE='{"labels":[{"name":"agent/in-progress"},{"name":"agent/mine"}]}' as sess-a start 7 feat/7
is "$RC" 0 "our claim and our pull request"
STUB_ISSUE='{"labels":[{"name":"agent/mine"}]}' as sess-a finish released
is "$RC" 1 "releasing drops agent/mine too"
has "$(cat "$HOME/err")" "still carries agent/mine" "says what"
done_

CASE="interactive: the operator holds the pull request, so opening it ends the run"; sandbox; origin_checkout
echo "- mode: interactive" >> "$HOME/work/CONFIG.md"
as sess-a start 7 feat/7
STUB_PULL='{"state":"open","user":{"login":"dev-bot"},"body":"Fixes #7 sess-a"}' as sess-a finish pr-opened 21
is "$RC" 0 "no babysitting asked"
[ ! -d "$SD_LOCKS/item-7" ] || fail "kept the item"
is "$(field items/7.md pr)" 21 "the pull request is recorded"
done_

exit "$FAILED"
