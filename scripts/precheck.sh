#!/usr/bin/env bash
# exit 0 = there is work, stdout goes into the prompt; 1 = skip the occurrence;
# anything else = broken, the run happens anyway and the reason is recorded.
set -uo pipefail

CONFIG="CONFIG.md"
SINCE="${PLATFORM_LAST_RUN_AT:-}"

# One run at a time, because there is one cluster. Every fire opens its own
# session now, so nothing queues behind the run before it the way a resumed
# session did — this is the gate that replaced that. The runtime publishes what
# the sandbox is doing, live, so there is no lock to leak when a run dies: a
# turn still working (or a terminal someone left open) reads as busy, and this
# occurrence steps aside for it.
#
# An unanswerable runtime is not a reason to stop ticking — this gate only ever
# runs because that same runtime delivered the fire — so the run happens and is
# told the check could not be made.
UNGATED=""
IDLE="$(curl -fsS --max-time 5 "${PLATFORM_RUNTIME_URL:-}/api/status" 2>/dev/null |
  jq -r '.idle' 2>/dev/null)"
case "$IDLE" in
  false) exit 1 ;;
  true) ;;
  *) UNGATED="The runtime did not say whether the sandbox is busy, so another run may still be in flight. Check before you build: one cluster, one build." ;;
esac

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

# The login onboarding recorded, else whoever the token belongs to. `@me` is
# the last resort: resolving it costs a call, and a token without user scope
# cannot answer it at all.
AUTHOR="$(cfg author)"
if [ -z "$AUTHOR" ]; then
  AUTHOR="$(gh api user --jq .login 2>/dev/null)" || true
fi
AUTHOR="${AUTHOR:-@me}"

ERR="$(mktemp)"
trap 'rm -f "$ERR"' EXIT

# One retry: this runs every ten minutes, and a blip that fails open costs a
# whole turn that begins by wondering why.
gh_json() {
  gh "$@" 2>"$ERR" && return 0
  sleep 3
  gh "$@" 2>"$ERR"
}

PRS="$(gh_json pr list -R "$REPO" --author "$AUTHOR" --state open --limit 50 \
  --json number,title,url,reviewDecision,latestReviews,body)" || {
  echo "gh could not list pull requests on $REPO as author '$AUTHOR', twice:" >&2
  cat "$ERR" >&2
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

ISSUES="$(gh_json issue list -R "$REPO" --label "$HANDOFF" --state open --limit 50 \
  --json number,title,url,labels)" || {
  echo "gh could not list issues on $REPO with label '$HANDOFF', twice:" >&2
  cat "$ERR" >&2
  exit 2
}

ISSUE_WORK="$(printf '%s' "$ISSUES" | jq -r --arg claimed "$CLAIMED" '
  map(select([.labels[].name] | index($claimed) | not))
  | .[]
  | "- #\(.number) \(.title)\n  \(.url)"
')" || exit 2

# Work an earlier run started and never finished. A run holds no memory of the
# one before it, so an issue left claimed with no pull request to show for it is
# invisible to both queries above: the claim hides it from the hand-off list, and
# there is nothing open to review. That is the one thing a resumed session used
# to remember, so it is named here instead. The link between the two is the
# `Fixes #<n>` line every pull request body carries (CLAUDE.md → "Rules").
CLAIMED_ISSUES="$(gh_json issue list -R "$REPO" --label "$CLAIMED" --state open --limit 50 \
  --json number,title,url)" || {
  echo "gh could not list issues on $REPO with label '$CLAIMED', twice:" >&2
  cat "$ERR" >&2
  exit 2
}

RESUME_WORK="$(printf '%s' "$CLAIMED_ISSUES" | jq -r --argjson prs "$PRS" '
  map(select(.number as $n | ($prs | map(.body // "") | any(test("#\($n)(\\D|$)"))) | not))
  | .[]
  | "- #\(.number) \(.title)\n  \(.url)"
')" || exit 2

[ -z "$PR_WORK" ] && [ -z "$ISSUE_WORK" ] && [ -z "$RESUME_WORK" ] && exit 1

echo "Repository: $REPO"
[ -n "$UNGATED" ] && { echo; echo "$UNGATED"; }
if [ -n "$PR_WORK" ]; then
  echo
  echo "Your open pull requests needing attention — handle these first:"
  echo "$PR_WORK"
fi
if [ -n "$RESUME_WORK" ]; then
  echo
  echo "Claimed by a run that never opened a pull request — finish or release these before taking anything new:"
  echo "$RESUME_WORK"
fi
if [ -n "$ISSUE_WORK" ]; then
  echo
  echo "Unclaimed issues labelled $HANDOFF — take AT MOST ONE:"
  echo "$ISSUE_WORK"
fi
exit 0
