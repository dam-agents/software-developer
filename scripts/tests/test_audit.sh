#!/usr/bin/env bash
# audit.sh: the week in numbers, and a failed read reported as not measured.
. "$(dirname "$0")/helpers.sh"

IDLE='{"idle":true,"backgroundWork":[]}'
origin() {   # a local remote for the definition, at the given VERSION
  git init -q --bare "$HOME/origin.git"
  git -C "$HOME" remote add origin "$HOME/origin.git"
  echo "$1" > "$HOME/VERSION.next"
  git -C "$HOME" push -q origin HEAD:refs/heads/main 2>/dev/null
  git -C "$HOME/origin.git" symbolic-ref HEAD refs/heads/main
  if [ "$1" != "$(cat "$HOME/VERSION")" ]; then
    tmp="$(mktemp -d)"; git clone -q "$HOME/origin.git" "$tmp/c" 2>/dev/null
    echo "$1" > "$tmp/c/VERSION"
    git -C "$tmp/c" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -qam bump
    git -C "$tmp/c" push -q origin HEAD:main 2>/dev/null; rm -rf "$tmp"
  fi
  rm -f "$HOME/VERSION.next"
}
audit() { OUT="$(STUB_STATUS="$IDLE" bash "$SCRIPTS/audit.sh" 2>"$HOME/err")"; RC=$?; }

CASE="a busy week, counted"; sandbox; onboarded; origin "$(cat "$HOME/VERSION")"
{ echo "$(ago 20000) pr-opened session=old occurrence=O issue=1 pr=2 minutes=99"
  echo "$(ago 3000) pr-opened session=a occurrence=O issue=3 pr=4 minutes=30"
  echo "$(ago 2000) nothing session=b occurrence=O issue=- pr=- minutes=1"
  echo "$(ago 1500) abandoned session=c occurrence=O issue=5 pr=- minutes=40 reason=\"sandbox idle\""
  echo "$(ago 1000) diagnostic busy_since=x holder=-"
  echo "$(ago 500) pr-updated session=d occurrence=O issue=3 pr=4 minutes=12"; } > "$HOME/work/TICK.log"
STUB_PRS="[{\"number\":4,\"createdAt\":\"$(ago 12000)\",\"reviewDecision\":\"REVIEW_REQUIRED\",\"title\":\"x\",\"url\":\"u\",\"latestReviews\":[],\"body\":\"Fixes #3\"},
          {\"number\":9,\"createdAt\":\"$(ago 12000)\",\"reviewDecision\":\"APPROVED\",\"title\":\"y\",\"url\":\"u\",\"latestReviews\":[],\"body\":\"Fixes #8\"}]" \
STUB_CLAIMED='[{"number":3,"title":"Three","url":"u"},{"number":5,"title":"Five","url":"u"}]' audit
has "$OUT" "PASS (live)" "runs the verifier first"
has "$OUT" "runs: abandoned: 1 diagnostic: 1 nothing: 1 pr-opened: 1 pr-updated: 1" "counts the week only"
has "$OUT" "median 12, longest 40" "minutes"
has "$OUT" "warn runs.abandoned — 1 run(s)" "abandoned"
has "$OUT" "session=c" "names the session"
has "$OUT" "warn runs.diagnostic — 1" "diagnostic"
has "$OUT" "warn prs.waiting — older than a week, not approved: #4" "stale pull request"
lacks "$OUT" "#9" "an approved one is not waiting"
has "$OUT" "warn issues.orphaned — claimed, no pull request: #5" "orphaned claim"
has "$OUT" "ok   definition.version" "up to date"
done_

CASE="a failed read is not measured, never none"; sandbox; onboarded; origin "1.1.0"
STUB_PR_FAIL=1 audit
has "$OUT" "warn prs.waiting — not measured" "pull requests"
has "$OUT" "warn issues.orphaned — not measured" "claims"
has "$OUT" "warn definition.version — checked out 1.0.0, latest 1.1.0" "version drift"
has "$OUT" "runs: none closed this week" "an empty log"
done_

exit "$FAILED"
