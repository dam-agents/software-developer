#!/usr/bin/env bash
# exit 0 = there is work, stdout goes into the prompt; 1 = skip the occurrence;
# anything else = broken, the run happens anyway and the reason is recorded.
#
# PRECHECK_PROBE=1 answers only "is there work, and can GitHub be read": no
# sandbox gate and no state written. verify-onboarding.sh and the audit use it
# to prove the detection end to end without claiming a run nobody will start.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/config.sh"
. "$HERE/lib/time.sh"
STATE="$HERE/run-state.sh"
RUN="$HOME/work/RUN.md"
GATE="$HOME/work/GATE.md"
SINCE="${PLATFORM_LAST_RUN_AT:-}"

# Every exit that lets a work run through claims work/RUN.md first, so the next
# occurrence can tell a run that is still working from one that died.
allow() {
  [ -n "${PRECHECK_PROBE:-}" ] ||
    "$STATE" claim "${PLATFORM_FIRE_AT:-unknown}" >/dev/null 2>&1 || true
  exit 0
}

# One run at a time, because there is one cluster, and nothing queues fresh
# sessions behind each other. Two witnesses decide whether the last run is over:
# the runtime, which says live whether the sandbox is doing anything, and
# work/RUN.md, which says whether a run of ours claimed it and never closed.
#
#   idle, record open    the run is gone — nothing can be running in an idle
#                        sandbox — so the record is abandoned and this run is
#                        told what it may have left half-done
#   busy, record open    the run is presumed alive while it shows a sign of life
#                        (a phase stamp, or its own transcript moving)
#   busy, no record      something else holds it: a chat, a terminal, background
#                        work left running
#
# Busy with no sign of life past `stuck_after_min` is the one thing declining
# cannot fix, and it is silent — the panel just counts declines — so it lets a
# DIAGNOSTIC run through, which may not build, and whose only job is to say
# what is holding the sandbox. At most one per backoff window, doubling from an
# hour to a day, so a sandbox nobody frees does not cost a turn an hour forever.
#
# A runtime that does not answer is not a reason to stop ticking: this gate only
# runs because that same runtime delivered the fire. Unless a run of ours holds
# the record — then a guess could start a second build, so it counts as busy.
STUCK_MIN="$(cfg stuck_after_min)"
case "$STUCK_MIN" in '' | *[!0-9]*) STUCK_MIN=120 ;; esac
GRACE_SEC=120
NOW="$(date -u +%s)"
NOTE=""

STATUS="$(curl -fsS --max-time 5 "${PLATFORM_RUNTIME_URL:-}/api/status" 2>/dev/null)"
IDLE="$(printf '%s' "$STATUS" | jq -r '.idle' 2>/dev/null)"
HELD="$(kv "$RUN" run_state)"
SESSION="$(kv "$RUN" session)"
PHASE="$(kv "$RUN" phase)"
PHASE_AT="$(kv "$RUN" phase_at)"

# The newest sign that the run holding the record is still working. Its own
# transcript moves on every tool call without the run doing anything, so a run
# busy in a long step still shows life; a single step longer than
# stuck_after_min is what that key exists to be raised for.
last_life() {
  local best=0 t e f
  for t in "$(kv "$RUN" claimed_at)" "$PHASE_AT"; do
    e="$(epoch "$t")" && [ "$e" -gt "$best" ] && best="$e"
  done
  f="$(find "$HOME/.claude/projects" -maxdepth 2 -name "$SESSION.jsonl" 2>/dev/null | head -1)"
  [ -n "$f" ] && e="$(mtime "$f")" && [ "$e" -gt "$best" ] && best="$e"
  echo "$best"
}

if [ -n "${PRECHECK_PROBE:-}" ]; then
  :
elif [ "$IDLE" = true ]; then
  if [ "$HELD" = running ]; then
    claimed="$(epoch "$(kv "$RUN" claimed_at)")" || claimed=0
    # claimed moments ago and not started yet — the session is still opening
    [ $(( NOW - claimed )) -lt "$GRACE_SEC" ] && exit 1
    NOTE="The run before this one (session $SESSION, last at \"$PHASE\" since $PHASE_AT) never closed work/RUN.md, and the sandbox is idle, so it is not running any more. Whatever it was doing may be half-done: look at its issue and branch before taking anything new."
    "$STATE" abandon "sandbox idle, record still open" >/dev/null 2>&1 || true
  fi
  [ -f "$GATE" ] && "$STATE" free >/dev/null 2>&1
elif [ "$IDLE" = false ] || [ "$HELD" = running ]; then
  if [ "$HELD" = running ]; then
    quiet="$(last_life)"
  else
    "$STATE" busy >/dev/null 2>&1 || true
    quiet="$(epoch "$(kv "$GATE" busy_since)")" || quiet="$NOW"
  fi
  quiet_min=$(( (NOW - quiet) / 60 ))
  [ "$quiet_min" -ge "$STUCK_MIN" ] || exit 1

  n="$(kv "$GATE" diagnoses)"; n="${n:-0}"
  wait_min=60
  i=0
  while [ "$i" -lt "$n" ] && [ "$wait_min" -lt 1440 ]; do
    wait_min=$(( wait_min * 2 )); i=$(( i + 1 ))
  done
  [ "$wait_min" -gt 1440 ] && wait_min=1440
  if last="$(epoch "$(kv "$GATE" diagnosed_at)")"; then
    [ $(( (NOW - last) / 60 )) -ge "$wait_min" ] || exit 1
  fi
  "$STATE" diagnosed >/dev/null 2>&1 || true

  echo "DIAGNOSTIC RUN — do not build, do not claim, do not take new work."
  echo
  echo "The sandbox has read busy with nothing moving for $quiet_min minutes, and the tick has stepped aside every occurrence since."
  if [ "$HELD" = running ]; then
    echo "work/RUN.md is held by session $SESSION, last at \"$PHASE\" since $PHASE_AT."
  else
    echo "No run holds work/RUN.md, so something else is keeping the sandbox busy: a chat turn, an open terminal, or background work."
  fi
  BG="$(printf '%s' "$STATUS" | jq -r '.backgroundWork[]? | "- \(.id): \(.description // .command // "no description")"' 2>/dev/null)"
  echo "Background work the runtime is holding the sandbox for:"
  echo "${BG:-none reported}"
  echo
  echo "Find out what is holding it and report — docs/diagnostic-run.md."
  exit 0
else
  NOTE="The runtime did not say whether the sandbox is busy, so another run may still be in flight. Check before you build: one cluster, one build."
fi

REPO="$(cfg repo)"
if [ -z "$REPO" ]; then
  for dir in "$HOME/work"/*/; do
    if [ -d "$dir/.git" ]; then
      REPO="$(git -C "$dir" config --get remote.origin.url 2>/dev/null |
        sed -E 's#(git@github\.com:|https://github\.com/)##; s/\.git$//')"
      [ -n "$REPO" ] && break
    fi
  done
fi
if [ -z "$REPO" ]; then
  # Nothing to work on — CONFIG.md lost or never written. Letting a run through
  # to say so would repeat every ten minutes into a chat nobody reads; the
  # weekly audit's verifier fails the missing key instead.
  exit 1
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
[ -n "$NOTE" ] && { echo; echo "$NOTE"; }
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
allow
