#!/usr/bin/env bash
# audit.sh — the deterministic half of the weekly audit (docs/audit.md).
#
# Read-only toward GitHub and repair-free: it prints `ok`/`warn`/`FAIL` lines
# and the week in numbers, and the agent adds the checks only it can make
# (schedules over MCP, the cause behind each abandoned run) before reporting.
#
# It runs verify-onboarding.sh --live first — the structure, the access and the
# precheck's health are exactly what an instance nobody watches drifts out of.
set -u
export LC_ALL=C

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/config.sh"
WORK="$HOME/work"
LOG="$WORK/TICK.log"

bash "$HERE/verify-onboarding.sh" --live

WEEK_AGO=$(( $(date -u +%s) - 7 * 86400 ))
CUTOFF="$(date -u -d "@$WEEK_AGO" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$WEEK_AGO" +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "== the week"

# The week's lines of TICK.log. Every line starts with a fixed-width UTC time,
# so a string comparison orders them; a line that does not was already failed
# by verify-onboarding.sh.
week() {
  [ -f "$LOG" ] || return 0
  while read -r ts rest; do
    [ "$ts" \> "$CUTOFF" ] && printf '%s %s\n' "$ts" "$rest"
  done < "$LOG"
}
WEEK="$(week)"

if [ -z "$WEEK" ]; then
  echo "runs: none closed this week"
else
  printf '%s\n' "$WEEK" | cut -d' ' -f2 | sort | uniq -c | sed -E 's/^ *([0-9]+) (.*)/\2: \1/' |
    tr '\n' ' ' | sed -E 's/ $//; s/^/runs: /'
  echo
  mins="$(printf '%s\n' "$WEEK" | grep -oE 'minutes=[0-9]+' | cut -d= -f2 | sort -n)"
  if [ -n "$mins" ]; then
    n="$(printf '%s\n' "$mins" | wc -l | tr -d ' ')"
    echo "minutes per run: median $(printf '%s\n' "$mins" | sed -n "$(( (n + 1) / 2 ))p"), longest $(printf '%s\n' "$mins" | tail -1)"
  fi
fi

a="$(printf '%s\n' "$WEEK" | grep -c ' abandoned ')"
[ "$a" = 0 ] && echo "ok   runs.abandoned — none" ||
  echo "warn runs.abandoned — $a run(s) ended without closing their record: $(printf '%s\n' "$WEEK" | grep ' abandoned ' | grep -oE 'session=[^ ]+' | tr '\n' ' ')"
d="$(printf '%s\n' "$WEEK" | grep -c ' diagnostic ')"
[ "$d" = 0 ] && echo "ok   runs.diagnostic — the sandbox never read stuck" ||
  echo "warn runs.diagnostic — $d diagnostic run(s): the sandbox read stuck"

REPO="$(cfg repo)"; AUTHOR="$(cfg author)"
if [ -n "$REPO" ] && [ -n "$AUTHOR" ]; then
  # Your pull requests waiting on review for more than a week. A listing that
  # failed is "not measured", never "none".
  json="$(gh pr list -R "$REPO" --author "$AUTHOR" --state open --limit 100 \
    --json number,createdAt,reviewDecision 2>/dev/null)"
  if [ $? -ne 0 ] || ! stale="$(printf '%s' "$json" | jq -er --arg cutoff "$CUTOFF" \
      '[.[] | select(.createdAt < $cutoff and .reviewDecision != "APPROVED") | "#\(.number)"] | join(" ")' 2>/dev/null)"; then
    echo "warn prs.waiting — not measured: could not list pull requests"
  elif [ -z "$stale" ]; then
    echo "ok   prs.waiting — none older than a week without approval"
  else
    echo "warn prs.waiting — older than a week, not approved: $stale"
  fi

  # Work a run left claimed with no pull request: the precheck's own resume
  # list, read without a gate and without claiming. Exit 1 means no work at
  # all; anything past it means the probe could not look.
  probe="$(cd "$WORK" && PRECHECK_PROBE=1 bash "$HERE/precheck.sh" 2>/dev/null)"
  case $? in
    0 | 1)
      resume="$(printf '%s\n' "$probe" | sed -n '/^Claimed by a run that never opened/,/^$/p' |
        grep -oE '^- #[0-9]+' | sed 's/^- //' | tr '\n' ' ' | sed -E 's/ $//')"
      [ -z "$resume" ] && echo "ok   issues.orphaned — no claimed issue without a pull request" ||
        echo "warn issues.orphaned — claimed, no pull request: $resume" ;;
    *) echo "warn issues.orphaned — not measured: the precheck could not read GitHub" ;;
  esac
fi

nfs="$(find "$WORK" -name '.nfs*' 2>/dev/null | wc -l | tr -d ' ')"
[ "$nfs" = 0 ] && echo "ok   volume.nfs — no silly-rename leftovers" ||
  echo "warn volume.nfs — $nfs .nfs* file(s) under work/: something deleted a file still held open"

# The platform seeds $HOME by init and fetch, so origin/HEAD may not exist: ask
# the remote which branch is its default.
branch="$(git -C "$HOME" ls-remote --symref origin HEAD 2>/dev/null | sed -n 's#^ref: refs/heads/\([^[:space:]]*\).*#\1#p')"
if [ -n "$branch" ] && git -C "$HOME" fetch -q origin "$branch" 2>/dev/null; then
  latest="$(git -C "$HOME" show "FETCH_HEAD:VERSION" 2>/dev/null | head -1)"
  here="$(head -1 "$HOME/VERSION" 2>/dev/null)"
  if [ -z "$latest" ]; then echo "warn definition.version — not measured: $branch has no VERSION"
  elif [ "$latest" = "$here" ]; then echo "ok   definition.version — $here, the latest"
  else echo "warn definition.version — checked out $here, latest $latest: docs/persistence.md → Definition version & upgrade"; fi
else
  echo "warn definition.version — not measured: could not fetch the definition"
fi
