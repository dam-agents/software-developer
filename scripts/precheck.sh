#!/usr/bin/env bash
# exit 0 = there is work, stdout goes into the prompt; 1 = skip the occurrence;
# anything else = broken, the run happens anyway and the reason is recorded.
set -uo pipefail

CONFIG="CONFIG.md"
SINCE="${PLATFORM_LAST_RUN_AT:-}"

cfg() {
  [ -f "$CONFIG" ] || return 0
  grep -m1 -iE "^[-*]?[[:space:]]*$1[[:space:]]*:" "$CONFIG" 2>/dev/null |
    sed -E "s/^[-*]?[[:space:]]*[^:]+:[[:space:]]*//" |
    tr -d '`' |
    sed -E 's/[[:space:]]+$//'
}

REPO="$(cfg repo)"
if [ -z "$REPO" ]; then
  for dir in */; do
    if [ -d "$dir/.git" ]; then
      REPO="$(git -C "$dir" config --get remote.origin.url 2>/dev/null |
        sed -E 's#(git@github\.com:|https://github\.com/)##; s/\.git$//')"
      [ -n "$REPO" ] && break
    fi
  done
fi
if [ -z "$REPO" ]; then
  echo "No repository configured: work/CONFIG.md names none and no checkout does either."
  echo "Tell the user that is why nothing can run, and stop."
  exit 0
fi

HANDOFF="$(cfg label_handoff)"; HANDOFF="${HANDOFF:-agent/implement}"
CLAIMED="$(cfg label_claimed)"; CLAIMED="${CLAIMED:-agent/in-progress}"

PRS="$(gh pr list -R "$REPO" --author "@me" --state open --limit 50 \
  --json number,title,url,reviewDecision,latestReviews 2>/dev/null)" || {
  echo "gh could not list pull requests on $REPO" >&2
  exit 2
}

PR_WORK="$(printf '%s' "$PRS" | jq -r --arg since "$SINCE" '
  map(select(
    .reviewDecision == "APPROVED"
    or (.reviewDecision == "CHANGES_REQUESTED"
        and (([.latestReviews[]?.submittedAt] | max // "") > $since))
  ))
  | .[]
  | "- #\(.number) \(.title) — \(if .reviewDecision == "APPROVED" then "approved; release its issue and move on" else "changes requested; resolve and re-request review" end)\n  \(.url)"
')" || exit 2

ISSUES="$(gh issue list -R "$REPO" --label "$HANDOFF" --state open --limit 50 \
  --json number,title,url,labels 2>/dev/null)" || {
  echo "gh could not list issues on $REPO" >&2
  exit 2
}

ISSUE_WORK="$(printf '%s' "$ISSUES" | jq -r --arg claimed "$CLAIMED" '
  map(select([.labels[].name] | index($claimed) | not))
  | .[]
  | "- #\(.number) \(.title)\n  \(.url)"
')" || exit 2

[ -z "$PR_WORK" ] && [ -z "$ISSUE_WORK" ] && exit 1

echo "Repository: $REPO"
if [ -n "$PR_WORK" ]; then
  echo
  echo "Your open pull requests needing attention — handle these first:"
  echo "$PR_WORK"
fi
if [ -n "$ISSUE_WORK" ]; then
  echo
  echo "Unclaimed issues labelled $HANDOFF — take AT MOST ONE:"
  echo "$ISSUE_WORK"
fi
exit 0
