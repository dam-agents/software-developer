#!/usr/bin/env bash
# exit 0 = there is work, stdout goes into the prompt; 1 = skip the occurrence;
# anything else = broken, the run happens anyway and the reason is recorded.
#
# PRECHECK_PROBE=1 answers only "is there work, and can GitHub be read": no
# slot gate and no state written. verify-onboarding.sh and the audit use it to
# prove the detection end to end.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/config.sh"
. "$HERE/lib/time.sh"
STATE="$HERE/run-state.sh"
GATE="$HOME/work/GATE.md"
ITEMS="$HOME/work/items"
SINCE="${PLATFORM_LAST_RUN_AT:-}"

LOCKS="${SD_LOCKS:-/dev/shm/software-developer}"

# Up to `slots` runs at once, one item each (scripts/run-state.sh). Nothing is
# claimed here: a run takes its item and its slot itself, atomically, so two
# runs let through close together simply take different items. What this gate
# does is free what dead runs left, decline while every slot is held, and
# leave out of the list what a live run already holds.
#
# Every slot held, and one of the holders silent past `stuck_after_min`, is the
# one thing declining cannot fix, and it is silent — the panel just counts
# declines — so it lets a DIAGNOSTIC run through, which may not build, and
# whose only job is to say what is stuck. At most one per backoff window,
# doubling from an hour to a day.
NOTE=""
N="$(cfg slots)"; case "$N" in '' | *[!0-9]* | 0) N=3 ;; esac

if [ -z "${PRECHECK_PROBE:-}" ]; then
  ABANDONED="$("$STATE" sweep 2>/dev/null | tr '\n' ' ' | sed -E 's/ $//')"
  [ -z "$ABANDONED" ] ||
    NOTE="A run working on $ABANDONED stopped without finishing (its session is not running any more); its branch and slot hold what it got to."
  if [ "$("$STATE" live)" -ge "$N" ]; then
    QUIET="$("$STATE" quiet)"
    [ -n "$QUIET" ] || exit 1
    NOW="$(date -u +%s)"
    n="$(kv "$GATE" diagnoses)"; n="${n:-0}"
    wait_min=60; i=0
    while [ "$i" -lt "$n" ] && [ "$wait_min" -lt 1440 ]; do
      wait_min=$(( wait_min * 2 )); i=$(( i + 1 ))
    done
    [ "$wait_min" -gt 1440 ] && wait_min=1440
    if last="$(epoch "$(kv "$GATE" diagnosed_at)")"; then
      [ $(( (NOW - last) / 60 )) -ge "$wait_min" ] || exit 1
    fi
    "$STATE" diagnosed >/dev/null 2>&1 || true
    echo "DIAGNOSTIC RUN — do not build, do not start an item, do not take new work."
    echo
    echo "Every one of the $N slots is held, and these runs have shown no sign of life for $(cfg stuck_after_min | grep . || echo 120) minutes or more:"
    printf '%s\n' "$QUIET" | sed 's/^/- /'
    echo
    echo "Find out what is holding them and report — docs/diagnostic-run.md."
    exit 0
  fi
  # the cluster's other holder, if any, and whether it is free
  CLUSTER_FREE=1; [ -d "$LOCKS/cluster" ] && CLUSTER_FREE=0
else
  CLUSTER_FREE=1
fi
HELD=" $("$STATE" held 2>/dev/null | tr '\n' ' ') "

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
NEEDS_INFO="$(cfg label_needs_info)"; NEEDS_INFO="${NEEDS_INFO:-agent/needs-info}"

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
  --json number,title,url,reviewDecision,latestReviews,statusCheckRollup,body)" || {
  echo "gh could not list pull requests on $REPO as author '$AUTHOR', twice:" >&2
  cat "$ERR" >&2
  exit 2
}

# What the local cache knows of each item (scripts/run-state.sh): when a run
# last looked at it, what state it was left in, how often a run died on it.
# Missing or lost, every item reads as never seen: the labels, branches and
# pull requests on GitHub are the truth, and this cache is never pushed.
ITEMS_JSON="$(for f in "$ITEMS"/*.md; do
  [ -f "$f" ] || continue
  jq -n --arg item "$(basename "$f" .md)" --arg seen "$(kv "$f" seen_at)" \
    --arg state "$(kv "$f" state)" --arg ab "$(kv "$f" abandoned)" --arg branch "$(kv "$f" branch)" \
    '{($item): {seen: $seen, state: $state, abandoned: ($ab | tonumber? // 0), branch: $branch}}'
done | jq -s 'add // {}')" || ITEMS_JSON='{}'

# A pull request is babysat until it is approved and green (docs/babysit.md),
# so it wakes a run for anything that happened to it since a run last looked
# at its item: a review of any kind, or a check that failed — once, so one the
# agent could not fix is reported once rather than every tick. Approval is not
# gated: releasing the issue is that run's job. Its item is the issue its body
# names (`Fixes #<n>`), and an item a live run holds is left out.
PR_WORK="$(printf '%s' "$PRS" | jq -r --arg since "$SINCE" --arg author "$AUTHOR" \
    --arg held "$HELD" --argjson items "$ITEMS_JSON" '
  map(.number as $pr | . + {item: ((.body // "") | capture("(?i)(fix(es|ed)?|close[sd]?|resolve[sd]?) #(?<n>[0-9]+)").n // "pr\($pr)")})
  | map(. + {since: ($items[.item].seen // $since)})
  | map(select(.item as $i | $held | contains(" \($i) ") | not))
  | map(. + {
    reviewed: (([.latestReviews[]? | select(.author.login != $author) | .submittedAt] | max // "") > .since),
    failed: (.since as $s | [.statusCheckRollup[]?
      | select((.conclusion // .state // "") | test("^(FAILURE|ERROR|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED)$"))
      | select((.completedAt // .startedAt // "") > $s)
      | (.name // .context)])
  })
  | map(select(.reviewDecision == "APPROVED" or .reviewed or (.failed | length > 0)))
  | .[]
  | "- \(if (.item | startswith("pr")) then .item else "#\(.item)" end) — PR #\(.number) \(.title) — \([
      (if .reviewDecision == "APPROVED" then "approved" else empty end),
      (if .reviewed and .reviewDecision != "APPROVED" then "reviewed; resolve every finding and re-request review" else empty end),
      (if (.failed | length > 0) then "checks failed: \(.failed | join(", "))" else empty end)
    ] | join("; ")) — docs/babysit.md\n  \(.url)"
')" || exit 2

# Items a run parked because the cluster was taken: due again once it is free
CLUSTER_WORK=""
if [ "$CLUSTER_FREE" = 1 ]; then
  CLUSTER_WORK="$(printf '%s' "$ITEMS_JSON" | jq -r --arg held "$HELD" '
    to_entries | map(select(.value.state == "waiting-cluster" and (.key as $i | $held | contains(" \($i) ") | not)))
    | sort_by(.value.seen) | .[] | "- #\(.key) on \(.value.branch) — run its cluster step"')" || exit 2
fi

ISSUES="$(gh_json issue list -R "$REPO" --label "$HANDOFF" --state open --limit 50 \
  --json number,title,url,labels)" || {
  echo "gh could not list issues on $REPO with label '$HANDOFF', twice:" >&2
  cat "$ERR" >&2
  exit 2
}

ISSUE_WORK="$(printf '%s' "$ISSUES" | jq -r --arg claimed "$CLAIMED" --arg info "$NEEDS_INFO" --arg held "$HELD" '
  map(select([.labels[].name] | (index($claimed) or index($info)) | not))
  | map(select(.number as $i | $held | contains(" \($i) ") | not))
  | reverse | .[]
  | "- #\(.number) \(.title)\n  \(.url)"
')" || exit 2

# Work a run started and never finished: claimed, no pull request to show for
# it, and no live run on it. The claim hides it from the hand-off list, and
# there is nothing open to review, so it is named here. The link between issue
# and pull request is the `Fixes #<n>` line every pull request body carries
# (CLAUDE.md → "Rules"). How often a run has died on it is said, because the
# second time it is released rather than tried again.
CLAIMED_ISSUES="$(gh_json issue list -R "$REPO" --label "$CLAIMED" --state open --limit 50 \
  --json number,title,url)" || {
  echo "gh could not list issues on $REPO with label '$CLAIMED', twice:" >&2
  cat "$ERR" >&2
  exit 2
}

RESUME_WORK="$(printf '%s' "$CLAIMED_ISSUES" | jq -r --argjson prs "$PRS" --arg held "$HELD" \
    --argjson items "$ITEMS_JSON" '
  map(select(.number as $n | ($prs | map(.body // "") | any(test("#\($n)(\\D|$)"))) | not))
  | map(select(.number as $i | $held | contains(" \($i) ") | not))
  | map(select(($items["\(.number)"].state // "") != "waiting-cluster"))
  | .[]
  | "- #\(.number) \(.title)\(($items["\(.number)"].abandoned // 0) as $a
      | if $a > 0 then " — a run died on it \($a) time(s)" else "" end)\n  \(.url)"
')" || exit 2

[ -z "$PR_WORK" ] && [ -z "$CLUSTER_WORK" ] && [ -z "$ISSUE_WORK" ] && [ -z "$RESUME_WORK" ] && exit 1

echo "Repository: $REPO"
echo "Take the first item below that \`run-state.sh start\` gives you, and that one alone; another run takes the next."
[ -n "$NOTE" ] && { echo; echo "$NOTE"; }
if [ -n "$PR_WORK" ]; then
  echo
  echo "Your open pull requests needing attention:"
  echo "$PR_WORK"
fi
if [ -n "$CLUSTER_WORK" ]; then
  echo
  echo "Waiting for the cluster, which is free now:"
  echo "$CLUSTER_WORK"
fi
if [ -n "$RESUME_WORK" ]; then
  echo
  echo "Claimed, with no pull request and no run on it — finish or release:"
  echo "$RESUME_WORK"
fi
if [ -n "$ISSUE_WORK" ]; then
  echo
  echo "Unclaimed issues labelled $HANDOFF, oldest first:"
  echo "$ISSUE_WORK"
fi
exit 0
