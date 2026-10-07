#!/usr/bin/env bash
# precheck.sh: the verdict for every combination of slots, live runs, cached
# items and work on GitHub.
. "$(dirname "$0")/helpers.sh"

ISSUE7='[{"number":7,"title":"Add a flag","url":"https://gh/7","labels":[{"name":"agent/implement"}]}]'
ISSUES78='[{"number":8,"title":"Newer","url":"https://gh/8","labels":[{"name":"agent/implement"}]},
           {"number":7,"title":"Older","url":"https://gh/7","labels":[{"name":"agent/implement"}]}]'
full() {   # every slot held by a live run
  for k in 1 2 3; do lock "slot-$k" "session=sess-$k" "item=$k" "slot=$k" "since=$(ago 400)" phase=x "phase_at=$(ago "${1:-5}")"; done
  export STUB_RUNNING="sess-1 sess-2 sess-3"
}

CASE="nothing to do declines and writes nothing"; sandbox
precheck
is "$RC" 1 "exit"
[ ! -d "$SD_LOCKS" ] || [ -z "$(ls "$SD_LOCKS")" ] || fail "took a lock"
done_

CASE="work lets a run through, oldest issue first, and claims nothing"; sandbox
STUB_HANDOFF="$ISSUES78" precheck
is "$RC" 0 "exit"
has "$OUT" "Take the first item below" "the instruction"
first="$(printf '%s\n' "$OUT" | grep -m1 -oE '#[78] ')"
is "$first" "#7 " "oldest first"
[ ! -d "$SD_LOCKS" ] || [ -z "$(ls "$SD_LOCKS")" ] || fail "took a lock"
done_

CASE="every slot held by a live run declines before any GitHub call"; sandbox; full
STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 1 "exit"
no_gh
done_

CASE="every slot held, one silent past stuck_after_min, asks for a diagnostic"; sandbox; full 130
STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 0 "exit"
has "$OUT" "DIAGNOSTIC RUN" "diagnostic"
has "$OUT" "session sess-1, slot 1, #1" "names the holder"
no_gh
is "$(field GATE.md diagnoses)" 1 "counted"
has "$(cat "$HOME/work/TICK.log")" "diagnostic" "logged"
done_

CASE="a live run's transcript is a sign of life"; sandbox; full 130
for k in 1 2 3; do t="$HOME/.claude/projects/-home-agent-work/sess-$k.jsonl"; : > "$t"; touch_ago "$t" 3; done
precheck
is "$RC" 1 "exit"
done_

CASE="a second diagnostic waits out the doubled window"; sandbox; full 300
printf -- '- diagnosed_at: %s\n- diagnoses: 1\n' "$(ago 90)" > "$HOME/work/GATE.md"
precheck
is "$RC" 1 "90 minutes into a 2-hour window"
printf -- '- diagnosed_at: %s\n- diagnoses: 1\n' "$(ago 125)" > "$HOME/work/GATE.md"
precheck
is "$RC" 0 "past it"
done_

CASE="stuck_after_min is read from CONFIG.md"; sandbox; full 190
sed -i.bak 's/^- stuck_after_min: .*/- stuck_after_min: 300/' "$HOME/work/CONFIG.md"
precheck
is "$RC" 1 "190 quiet minutes is under 300"
done_

CASE="a dead run's slot is freed, and its item named"; sandbox
for k in 1 2 3; do lock "slot-$k" "session=sess-$k" "item=$k" "slot=$k"; done
lock item-1 session=sess-1 item=1 slot=1
STUB_RUNNING="sess-2 sess-3" STUB_CLAIMED='[{"number":1,"title":"One","url":"https://gh/1"}]' precheck
is "$RC" 0 "a slot is free again"
has "$OUT" "A run working on #1 stopped without finishing" "note"
has "$OUT" "#1 One — a run died on it 1 time(s)" "resumable, counted"
done_

CASE="an item a live run holds is left out"; sandbox
lock item-7 session=sess-a item=7
STUB_RUNNING=sess-a STUB_HANDOFF="$ISSUES78" precheck
is "$RC" 0 "exit"
lacks "$OUT" "#7 Older" "held"
has "$OUT" "#8 Newer" "free"
done_

CASE="an item waiting for the lock is due once it is free, in the state 3.0.0 renamed too"; sandbox
item 5 state=waiting-cluster branch=feat/5 "seen_at=$(ago 30)"
lock exclusive session=sess-a item=6
STUB_RUNNING=sess-a STUB_CLAIMED='[{"number":5,"title":"Five","url":"https://gh/5"}]' precheck
is "$RC" 1 "still taken, and not resumable either"
rm -rf "$SD_LOCKS/exclusive"
STUB_CLAIMED='[{"number":5,"title":"Five","url":"https://gh/5"}]' precheck
is "$RC" 0 "free"
has "$OUT" "#5 on feat/5 — run its exclusive step" "listed"
done_

CASE="a claimed issue is resumed only when no pull request names it"; sandbox
STUB_PRS='[{"number":21,"title":"x","url":"https://gh/pr/21","reviewDecision":null,"latestReviews":[],"body":"Fixes #45\n\nFixes #7"}]' \
STUB_CLAIMED='[{"number":7,"title":"Seven","url":"https://gh/7"},{"number":4,"title":"Four","url":"https://gh/4"},{"number":45,"title":"Forty-five","url":"https://gh/45"}]' \
precheck
is "$RC" 0 "exit"
has "$OUT" "#4 Four" "#4 is not named by '#45'"
lacks "$OUT" "#7 Seven" "#7 has its pull request"
lacks "$OUT" "#45 Forty-five" "#45 has its pull request"
done_

CASE="a pull request wakes a run for what came after its item was last looked at"; sandbox
PR='[{"number":30,"title":"Thirty","url":"https://gh/pr/30","reviewDecision":"REVIEW_REQUIRED","body":"Fixes #3",
  "latestReviews":[{"author":{"login":"guardian"},"state":"COMMENTED","submittedAt":"2026-09-24T10:05:00Z"}],
  "statusCheckRollup":[{"name":"test","conclusion":"FAILURE","completedAt":"2026-09-24T10:06:00Z"},
                       {"name":"lint","conclusion":"SUCCESS","completedAt":"2026-09-24T10:06:00Z"},
                       {"context":"ci/legacy","state":"ERROR","startedAt":"2026-09-24T09:00:00Z"}]}]'
STUB_PRS="$PR" PLATFORM_LAST_RUN_AT=2026-09-24T10:00:00Z precheck
is "$RC" 0 "exit"
has "$OUT" "#3 — PR #30 Thirty — reviewed; resolve every finding" "a comment-only review wakes it"
has "$OUT" "checks failed: test —" "names the newly failed check alone"
item 3 state=parked seen_at=2026-09-24T10:10:00Z
STUB_PRS="$PR" PLATFORM_LAST_RUN_AT=2026-09-24T09:00:00Z precheck
is "$RC" 1 "its item was looked at since, whatever the last run was"
OWN='[{"number":31,"title":"Own","url":"https://gh/pr/31","reviewDecision":null,"body":"",
  "latestReviews":[{"author":{"login":"dev-bot"},"state":"COMMENTED","submittedAt":"2026-09-24T10:05:00Z"}],"statusCheckRollup":[]}]'
STUB_PRS="$OWN" PLATFORM_LAST_RUN_AT=2026-09-24T10:00:00Z precheck
is "$RC" 1 "the agent's own comment is not a review"
done_

CASE="an approved pull request is never work, red or reviewed again"; sandbox
APPROVED='[{"number":40,"title":"Forty","url":"https://gh/pr/40","reviewDecision":"APPROVED","body":"Fixes #4",
  "latestReviews":[{"author":{"login":"maintainer"},"state":"APPROVED","submittedAt":"2026-09-24T10:05:00Z"}],
  "statusCheckRollup":[{"name":"test","conclusion":"FAILURE","completedAt":"2026-09-24T10:06:00Z"}]}]'
STUB_PRS="$APPROVED" PLATFORM_LAST_RUN_AT=2026-09-24T10:00:00Z precheck
is "$RC" 1 "waits for a person"
done_

CASE="what waits on a person is not work"; sandbox
item 5 state=blocked; item 6 state=needs-info
STUB_HANDOFF='[{"number":9,"title":"Nine","url":"https://gh/9","labels":[{"name":"agent/implement"},{"name":"agent/failed"}]}]' \
STUB_CLAIMED='[{"number":5,"title":"Five","url":"https://gh/5"},{"number":6,"title":"Six","url":"https://gh/6"}]' precheck
is "$RC" 1 "a failed issue, a blocked one and one waiting for an answer"
done_

CASE="a probe skips the gate and writes nothing"; sandbox; full 300
PRECHECK_PROBE=1 STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 0 "reports the work despite full slots"
has "$OUT" "#7 Add a flag" "worklist"
[ ! -f "$HOME/work/GATE.md" ] || fail "wrote gate bookkeeping"
PRECHECK_PROBE=1 precheck
is "$RC" 1 "nothing to do still declines"
done_

CASE="no repository configured declines rather than waking a run to say so"; sandbox
rm "$HOME/work/CONFIG.md"
STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 1 "exit"
done_


CASE="label_mine: only labelled pull requests are yours, and a bot is one login"; sandbox
precheck
lacks "$(cat "$HOME/gh.calls")" "--label agent/mine" "no label filter without the key"
sed -i.bak 's/^- author: .*/- author: dev-app[bot]/' "$HOME/work/CONFIG.md"
echo "- label_mine: agent/mine" >> "$HOME/work/CONFIG.md"
BOT='[{"number":32,"title":"Bot","url":"https://gh/pr/32","reviewDecision":null,"body":"Fixes #9",
  "latestReviews":[{"author":{"login":"app/dev-app"},"state":"COMMENTED","submittedAt":"2026-09-24T10:05:00Z"}],"statusCheckRollup":[]}]'
STUB_PRS="$BOT" PLATFORM_LAST_RUN_AT=2026-09-24T10:00:00Z precheck
is "$RC" 1 "the bot's own comment, as app/name, is not a review"
has "$(cat "$HOME/gh.calls")" 'q=repo:acme/widgets is:pr is:open author:dev-app[bot] label:"agent/mine"' "lists only labelled pull requests"
done_

CASE="the whole list is one GraphQL request"; sandbox
STUB_HANDOFF="$ISSUE7" STUB_CLAIMED='[{"number":5,"title":"Five","url":"https://gh/5"}]' precheck
is "$RC" 0 "exit"
is "$(grep -c '^api .*graphql' "$HOME/gh.calls")" 1 "one request"
lacks "$(cat "$HOME/gh.calls")" "pr list" "no gh pr list"
lacks "$(cat "$HOME/gh.calls")" "issue list" "no gh issue list"
done_

CASE="GraphQL refused, the same list is read over REST"; sandbox
sed -i.bak 's/^- author: .*/- author: dev-app[bot]/' "$HOME/work/CONFIG.md"
echo "- label_mine: agent/mine" >> "$HOME/work/CONFIG.md"
PULLS='[{"number":30,"title":"Thirty","html_url":"https://gh/pr/30","body":"Fixes #3","state":"open","head":{"sha":"abc"},
         "user":{"login":"dev-app[bot]"},"labels":[{"name":"agent/mine"}]},
        {"number":31,"title":"Theirs","html_url":"https://gh/pr/31","body":"Fixes #9","state":"open","head":{"sha":"def"},
         "user":{"login":"dev-app[bot]"},"labels":[]}]'
STUB_GRAPHQL_FAIL=1 STUB_REST_PULLS="$PULLS" STUB_HANDOFF="$ISSUE7" \
STUB_REVIEWS='[{"user":{"login":"guardian"},"state":"CHANGES_REQUESTED","submitted_at":"2026-09-24T10:05:00Z"}]' \
STUB_CHECKS='{"check_runs":[{"id":1,"name":"test","status":"completed","conclusion":"failure","completed_at":"2026-09-24T10:06:00Z"}]}' \
PLATFORM_LAST_RUN_AT=2026-09-24T10:00:00Z precheck
is "$RC" 0 "exit"
has "$OUT" "read over REST" "says so"
has "$OUT" "#3 — PR #30 Thirty — reviewed; resolve every finding and re-request review; checks failed: test" "the pull request, from REST"
lacks "$OUT" "PR #31" "another agent's, unlabelled"
has "$OUT" "#7 Add a flag" "the hand-off issue, from REST"
done_

CASE="neither GraphQL nor REST answers: broken, not idle"; sandbox
STUB_GRAPHQL_FAIL=1 STUB_REST_FAIL=1 STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 2 "exit"
has "$(cat "$HOME/err")" "nor REST" "says why"
done_

CASE="label_mine: a claim is ours only with the label beside it"; sandbox
echo "- label_mine: agent/mine" >> "$HOME/work/CONFIG.md"
STUB_CLAIMED='[{"number":7,"title":"Seven","url":"https://gh/7","labels":[{"name":"agent/in-progress"},{"name":"agent/mine"}]},
  {"number":8,"title":"Eight","url":"https://gh/8","labels":[{"name":"agent/in-progress"}]}]'
STUB_CLAIMED="$STUB_CLAIMED" precheck
is "$RC" 0 "exit"
has "$OUT" "#7 Seven" "ours"
lacks "$OUT" "#8 Eight" "another agent's claim"
STUB_GRAPHQL_FAIL=1 STUB_CLAIMED="$STUB_CLAIMED" precheck
has "$OUT" "#7 Seven" "ours, over REST"
lacks "$OUT" "#8 Eight" "another agent's claim, over REST"
done_

CASE="interactive: work on GitHub wakes nothing, and nothing is asked of it"; sandbox
sed -i.bak 's/^- mode: .*/- mode: interactive/' "$HOME/work/CONFIG.md"
STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 1 "exit"
no_gh
done_

CASE="no mode reads as interactive: nothing is watched"; sandbox
sed -i.bak '/^- mode:/d' "$HOME/work/CONFIG.md"
STUB_HANDOFF="$ISSUE7" precheck
is "$RC" 1 "exit"
no_gh
done_

exit "$FAILED"
