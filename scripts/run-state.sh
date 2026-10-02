#!/usr/bin/env bash
# run-state.sh — the one writer of the tick's state: which session works on
# which item, in which slot, and who holds the cluster.
#
# Up to `slots` runs work at once (default 3), one item each, each in a slot of
# its own: a worktree of the checkout at work/slots/<k>, kept between runs so
# its build output stays warm. A run takes an item and a slot when it starts
# and gives both back when it finishes; the branch, pushed, is what carries the
# work from one run to the next. The cluster is one, so whatever touches it
# runs under its own lock, taken for that step alone.
#
# The locks are directories under $LOCKS, on tmpfs: mkdir takes one atomically,
# and a restart — which stops every session and the cluster with it — wipes
# them all. Each holds an `owner` file naming its session and the boot it was
# taken in. A holder is dead when its boot is over, or when the runtime says
# its session is not running a turn: a lock never outlives the turn that took
# it. A runtime that does not answer frees nothing.
#
#   start <item> [branch]     take the item and a slot, put the slot on branch
#   phase <text>              before each long step: what, and since when
#   wait <pr>                 babysit: block up to ~9 minutes until the pull
#                             request needs the run (exit 0), nothing yet (3),
#                             or the run has babysat it for babysit_max_hours (4)
#   cluster                   take the cluster lock, or record waiting for it
#   cluster-done              give the cluster back
#   finish <outcome> [pr]     the run's last act, on every way out: refused
#                             until the work is pushed and reported on GitHub
#                             (below); then backs work/ up
#   sweep                     free the locks of dead holders (the precheck)
#   held                      the items live runs hold, one per line
#   live                      how many slots are held
#   quiet                     live runs silent for stuck_after_min, one a line
#   diagnosed                 the precheck let a diagnostic run through
#   show                      all of it, for a human
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/config.sh"
. "$HERE/lib/time.sh"

WORK="$HOME/work"
ITEMS="$WORK/items"
SLOTDIR="$WORK/slots"
GATE="$WORK/GATE.md"
LOG="$WORK/TICK.log"
LOCKS="${SD_LOCKS:-/dev/shm/software-developer}"
ME="${CLAUDE_CODE_SESSION_ID:-}"
BOOT="${SD_BOOT_ID:-$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)}"

N="$(cfg slots)"; case "$N" in '' | *[!0-9]* | 0) N=3 ;; esac
STUCK_MIN="$(cfg stuck_after_min)"; case "$STUCK_MIN" in '' | *[!0-9]*) STUCK_MIN=120 ;; esac
MAX_H="$(cfg babysit_max_hours)"; case "$MAX_H" in '' | *[!0-9]*) MAX_H=4 ;; esac
WAIT_FOR="${SD_WAIT_FOR:-540}"     # seconds a wait blocks: under the 10-minute tool limit
WAIT_POLL="${SD_WAIT_POLL:-60}"    # seconds between looks at the pull request

OWNER_KEYS="session boot since item slot phase phase_at"
ITEM_KEYS="item state branch slot pr session seen_at abandoned babysit_since round_at babysat_out updated_at"
GATE_KEYS="diagnosed_at diagnoses"

say() { echo "run-state: $*" >&2; }

# write <file> <from> <keys> [key=value ...] — <file> rewritten whole, tmp + mv,
# each key's value from the pairs when given, from <from> otherwise (/dev/null
# starts clean). A value of `-` drops the key.
write() {
  local file="$1" from="$2" keys="$3" k v pair tmp
  shift 3
  mkdir -p "$(dirname "$file")" || return 2
  tmp="$(mktemp "$(dirname "$file")/.$(basename "$file").XXXXXX")" || return 2
  {
    printf '# %s\n\nWritten by scripts/run-state.sh, never by hand.\n\n' "$(basename "$file" .md)"
    for k in $keys; do
      v="$(kv "$from" "$k")"
      for pair in "$@"; do
        [ "${pair%%=*}" = "$k" ] && v="${pair#*=}"
      done
      v="$(printf '%s' "$v" | tr '\n' ' ')"
      if [ -n "$v" ] && [ "$v" != - ]; then printf -- '- %s: %s\n' "$k" "$v"; fi
    done
  } > "$tmp" && mv -f "$tmp" "$file"
}

# alive <session> — 0 running a turn · 1 not running, or unknown to the runtime
# · 2 the runtime did not answer
alive() {
  local out
  out="$(curl -fsS --max-time 5 --get \
    --data-urlencode "input={\"sessionId\":\"$1\"}" \
    "${PLATFORM_RUNTIME_URL:-}/api/trpc/sessions.list" 2>/dev/null)" || return 2
  out="$(printf '%s' "$out" | jq -r '.result.data.sessions | if type == "array" then (.[0].running // false) else "unknown" end' 2>/dev/null)"
  case "$out" in true) return 0 ;; false) return 1 ;; *) return 2 ;; esac
}

# dead <lock> — its holder is provably gone: another boot, or no turn running.
# A lock with no owner yet is being taken, unless it has been so for a minute.
dead() {
  local o="$1/owner"
  if [ ! -f "$o" ]; then [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null)" ]; return; fi
  [ "$(kv "$o" boot)" = "$BOOT" ] || return 0
  alive "$(kv "$o" session)"; [ $? -eq 1 ]
}

mine() { [ -n "$ME" ] && [ "$(kv "$1/owner" session 2>/dev/null)" = "$ME" ]; }

# take <lock> [key=value ...] — 0 taken (or already ours), 1 held by another
take() {
  local l="$LOCKS/$1"; shift
  mkdir -p "$LOCKS" || return 2
  if mkdir "$l" 2>/dev/null; then
    write "$l/owner" /dev/null "$OWNER_KEYS" "session=$ME" "boot=$BOOT" "since=$(now)" \
      "phase=started" "phase_at=$(now)" "$@"
    return 0
  fi
  mine "$l"
}
drop() { rm -rf "${LOCKS:?}/$1"; }

my_lock() {   # my_lock <prefix> — the name of my lock of that kind, if any
  local l
  for l in "$LOCKS/$1"*; do
    [ -d "$l" ] && mine "$l" && { basename "$l"; return 0; }
  done
  return 1
}

stamp() {   # stamp <phase> — on every lock this run holds
  local l
  for l in "$LOCKS"/*/; do
    l="${l%/}"
    [ -d "$l" ] && mine "$l" &&
      write "$l/owner" "$l/owner" "$OWNER_KEYS" "phase=$1" "phase_at=$(now)"
  done
  return 0
}

item_file() { echo "$ITEMS/$1.md"; }

log_line() {   # log_line <outcome> <session> <item> <slot> <pr> <since> [extra]
  local end mins=- a b
  end="$(now)"
  if a="$(epoch "$6")" && b="$(epoch "$end")"; then mins=$(( (b - a) / 60 )); fi
  printf '%s %s session=%s issue=%s slot=%s pr=%s minutes=%s%s\n' \
    "$end" "$1" "${2:--}" "${3:--}" "${4:--}" "${5:--}" "$mins" "${7:+ $7}" >> "$LOG"
}

need_session() {
  [ -n "$ME" ] || { say "no \$CLAUDE_CODE_SESSION_ID — the runtime cannot tell this run is alive, so it may not hold anything"; exit 2; }
}

REPO="$(cfg repo)"
case "$REPO" in */*/*) HOST="${REPO%%/*}"; SLUG="${REPO#*/}" ;; *) HOST=github.com; SLUG="$REPO" ;; esac
CLAIMED="$(cfg label_claimed)"; CLAIMED="${CLAIMED:-agent/in-progress}"
NEEDS_INFO="$(cfg label_needs_info)"; NEEDS_INFO="${NEEDS_INFO:-agent/needs-info}"
FAILED_LABEL="$(cfg label_failed)"; FAILED_LABEL="${FAILED_LABEL:-agent/failed}"

# ------------------------------------------------------------------- slots
CO=""
checkout() {
  local repo; repo="$(cfg repo)"
  CO="$WORK/${repo##*/}"
  [ -n "$repo" ] && [ -e "$CO/.git" ] || { say "no checkout at work/${repo##*/} — clone it first (CLAUDE.md → Runtime configuration)"; return 1; }
}

default_branch() {
  git -C "$CO" rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's#^origin/##' | grep . ||
    git -C "$CO" ls-remote --symref origin HEAD 2>/dev/null | sed -n 's#^ref: refs/heads/\([^[:space:]]*\).*#\1#p' | grep . ||
    echo main
}

# unsaved <dir> — what in a slot is not on GitHub yet: uncommitted changes, or
# commits no remote branch has. Prints a reason; empty means nothing is lost.
unsaved() {
  [ -e "$1/.git" ] || return 0
  if [ -n "$(git -C "$1" status --porcelain 2>/dev/null)" ]; then echo "uncommitted changes"; return 0; fi
  if [ -n "$(git -C "$1" log --oneline HEAD --not --remotes 2>/dev/null | head -1)" ]; then echo "commits not pushed"; fi
  return 0
}

# prepare <slot> <branch> — the slot on <branch>: the remote's tip when it has
# one, else new from the default branch. Ignored files — the build output —
# stay; untracked ones go, so nothing strays into the next item's commit.
# 1 failed · 3 something unsaved is in the way, and the run is to save it.
prepare() {
  local k="$1" b="$2" d="$SLOTDIR/$1" why other dflt
  mkdir -p "$SLOTDIR"
  git -C "$CO" fetch -q --prune origin 2>/dev/null || { say "git fetch failed in work/${CO##*/}"; return 1; }
  dflt="$(default_branch)"
  # the checkout itself stays on the default branch, kept current: its skills
  # are the ones every run loads (scripts/harness/claude-code/install.sh)
  if [ "$(git -C "$CO" symbolic-ref -q --short HEAD)" = "$dflt" ] && [ -z "$(unsaved "$CO")" ]; then
    git -C "$CO" merge -q --ff-only "origin/$dflt" 2>/dev/null || true
  fi
  if [ ! -e "$d/.git" ]; then
    git -C "$CO" worktree add -q --detach "$d" "origin/$dflt" 2>/dev/null ||
      { say "could not create slot $k at $d"; return 1; }
  fi
  why="$(unsaved "$d")"
  if [ -n "$why" ]; then
    say "slot $k has $why on $(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null) — a run that ended without pushing."
    say "In $d, commit and push it to its branch (or to wip/<issue> when it is not yours to finish), then start again."
    return 3
  fi
  # a branch is checked out in one worktree at a time: a free, saved slot that
  # still has it lets go of it
  for other in "$SLOTDIR"/*; do
    [ -d "$other" ] && [ "$other" != "$d" ] || continue
    [ "$(git -C "$other" rev-parse --abbrev-ref HEAD 2>/dev/null)" = "$b" ] || continue
    if [ -n "$(unsaved "$other")" ] || [ -d "$LOCKS/slot-$(basename "$other")" ]; then
      say "branch $b is checked out in $other, which is in use or holds unsaved work."
      return 3
    fi
    git -C "$other" switch -q --detach 2>/dev/null
  done
  if git -C "$CO" rev-parse -q --verify "refs/remotes/origin/$b" >/dev/null; then
    if git -C "$CO" rev-parse -q --verify "refs/heads/$b" >/dev/null &&
       [ -n "$(git -C "$CO" log --oneline "refs/heads/$b" --not --remotes | head -1)" ]; then
      say "local branch $b has commits not on origin — push them before starting on it."
      return 3
    fi
    git -C "$d" switch -q -C "$b" "origin/$b" || return 1
  elif git -C "$CO" rev-parse -q --verify "refs/heads/$b" >/dev/null; then
    git -C "$d" switch -q "$b" || return 1
  else
    git -C "$d" switch -q -c "$b" "origin/$dflt" || return 1
  fi
  git -C "$d" clean -fdq
}

# ------------------------------------------------------------------ verbs
cmd_start() {
  local item="${1:?item: the issue number}" branch="${2:-}" f k last held_by rc
  item="${item#\#}"
  need_session
  f="$(item_file "$item")"
  checkout || exit 1
  [ -n "$branch" ] || branch="$(kv "$f" branch)"
  [ -n "$branch" ] || { say "item #$item has no branch yet — give one: start $item <branch>"; exit 2; }

  cmd_sweep >/dev/null
  if ! take "item-$item" "item=$item"; then
    held_by="$(kv "$LOCKS/item-$item/owner" session)"
    say "item #$item is held by session $held_by, at \"$(kv "$LOCKS/item-$item/owner" phase)\" — take the next one."
    exit 1
  fi
  # a run holds one slot: one already ours (a second start) is reused; else the
  # item's last slot, whose build output is its own, then any free one
  k="$(my_lock slot- | sed 's/^slot-//')"
  if [ -z "$k" ]; then
    last="$(kv "$f" slot)"
    for k in $last $(seq 1 "$N"); do
      [ "$k" -ge 1 ] 2>/dev/null && [ "$k" -le "$N" ] && take "slot-$k" "item=$item" "slot=$k" && break
      k=""
    done
  fi
  if [ -z "$k" ]; then
    drop "item-$item"
    say "all $N slots are in use — nothing can start now."
    exit 1
  fi
  write "$LOCKS/slot-$k/owner" "$LOCKS/slot-$k/owner" "$OWNER_KEYS" "item=$item" "slot=$k"
  write "$LOCKS/item-$item/owner" "$LOCKS/item-$item/owner" "$OWNER_KEYS" "slot=$k"

  prepare "$k" "$branch"; rc=$?
  if [ "$rc" -ne 0 ]; then
    # 3 keeps the locks: the run saves what it found, then starts again
    [ "$rc" -eq 3 ] && { echo "slot $k: $SLOTDIR/$k"; exit 3; }
    drop "item-$item"; drop "slot-$k"; exit 1
  fi
  # the babysit clock is this run's own: a run that resumes the item starts it again
  write "$f" "$f" "$ITEM_KEYS" "item=$item" state=active "branch=$branch" "slot=$k" \
    "session=$ME" "seen_at=$(now)" babysit_since=- round_at=- babysat_out=- "updated_at=$(now)"
  echo "slot $k: $SLOTDIR/$k on $branch"
}

# A run babysits the pull request it opened until it is done — approved, green,
# mergeable — or cannot be, in its own turn: the item stays held, so no other
# run takes it, and the run that wrote the change answers its review. `wait`
# is how it waits without leaving the turn: one look a minute, up to WAIT_FOR,
# and back to the run the moment there is something to do. What counts as new
# is what came after the run last came back from a wait (round_at).
#
# pr_state <pr> <since> — prints the verdict line; 0 act on it, 3 nothing yet,
# 2 unreadable
pr_state() {
  local json
  json="$(gh pr view "$1" -R "$REPO" --json state,mergeable,reviewDecision,headRefOid,latestReviews,statusCheckRollup 2>/dev/null)" || return 2
  printf '%s' "$json" | jq -r --arg since "$2" --arg author "$(cfg author)" '
    ([.latestReviews[]? | select(.author.login != $author) | select(.submittedAt > $since)]) as $new
    | ([.statusCheckRollup[]? | (.conclusion // .state // "")]) as $all
    | ([.statusCheckRollup[]? | select((.conclusion // .state // "") | test("^(FAILURE|ERROR|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED|CANCELLED)$"))
        | select((.completedAt // .startedAt // "") > $since) | (.name // .context)]) as $failed
    | ([$all[] | select(test("^(SUCCESS|SKIPPED|NEUTRAL)$") | not)] | length == 0) as $green
    | if .state == "MERGED" then "act merged — the pull request is merged: release the issue"
      elif .state == "CLOSED" then "act closed — closed without merging: read why, release the issue"
      elif ($failed | length) > 0 then "act checks failed: \($failed | join(", "))"
      elif ($new | length) > 0 then "act reviewed by \([$new[].author.login] | unique | join(", ")) (\([$new[].state] | unique | join(", "))): resolve every finding"
      elif .mergeable == "CONFLICTING" then "act conflicts with the base branch: rebase"
      elif .reviewDecision == "APPROVED" and $green and .mergeable == "MERGEABLE" then "act done — approved, green and mergeable: release the issue"
      elif .reviewDecision == "APPROVED" and $green then "wait approved and green; GitHub is still computing mergeability"
      elif $green then "wait green, waiting for a review"
      else "wait checks running" end' 2>/dev/null || return 2
}

cmd_wait() {
  local pr="${1:?pr}" item f since start nowe waited verdict rc=3 last=""
  pr="${pr#\#}"
  need_session
  item="$(my_lock item- | sed 's/^item-//')"
  [ -n "$item" ] || { say "this session holds no item — call start first"; exit 1; }
  f="$(item_file "$item")"
  write "$f" "$f" "$ITEM_KEYS" "pr=$pr" "updated_at=$(now)"
  [ -n "$(kv "$f" babysit_since)" ] || write "$f" "$f" "$ITEM_KEYS" "babysit_since=$(now)" "round_at=$(kv "$LOCKS/item-$item/owner" since)"
  since="$(kv "$f" round_at)"
  start="$(date -u +%s)"
  if waited="$(epoch "$(kv "$f" babysit_since)")" && [ $(( (start - waited) / 3600 )) -ge "$MAX_H" ]; then
    write "$f" "$f" "$ITEM_KEYS" babysat_out=yes
    echo "timeout — babysat #$pr for ${MAX_H}h (babysit_max_hours). Report where it stands and who it waits on, then finish pr-updated: a later run takes it over when something lands."
    exit 4
  fi
  while :; do
    stamp "babysit #$pr: ${last:-looking}"
    verdict="$(pr_state "$pr" "$since")"; rc=$?
    if [ "$rc" -eq 0 ]; then
      case "$verdict" in
        act*) write "$f" "$f" "$ITEM_KEYS" "round_at=$(now)" "updated_at=$(now)"
              stamp "babysit #$pr: ${verdict#act }"
              echo "${verdict#act }"; exit 0 ;;
        *) last="${verdict#wait }" ;;
      esac
    else
      last="GitHub unreadable"
    fi
    nowe="$(date -u +%s)"
    [ $(( nowe - start + WAIT_POLL )) -le "$WAIT_FOR" ] || break
    sleep "$WAIT_POLL"
  done
  echo "nothing yet — $last. Call wait again; do not end the turn."
  exit 3
}

cmd_phase() {
  need_session
  my_lock slot- >/dev/null || { say "this session holds no slot — call start first"; exit 1; }
  stamp "${1:?phase text}"
}

cmd_cluster() {
  local item f
  need_session
  item="$(my_lock item- | sed 's/^item-//')"
  [ -n "$item" ] || { say "this session holds no item — call start first"; exit 1; }
  f="$(item_file "$item")"
  cmd_sweep >/dev/null
  if take cluster "item=$item"; then
    if [ -f "$LOCKS/cluster.dirty" ]; then
      echo "cluster: yours. Its last holder died mid-use: run cluster_uninstall before anything else (docs/cluster.md)."
      rm -f "$LOCKS/cluster.dirty"
    else
      echo "cluster: yours."
    fi
    write "$f" "$f" "$ITEM_KEYS" state=active "updated_at=$(now)"
    stamp cluster
    return 0
  fi
  write "$f" "$f" "$ITEM_KEYS" state=waiting-cluster "updated_at=$(now)"
  say "the cluster is held by session $(kv "$LOCKS/cluster/owner" session) for #$(kv "$LOCKS/cluster/owner" item), at \"$(kv "$LOCKS/cluster/owner" phase)\"."
  say "Push what you have and finish waiting-cluster: the precheck wakes this item once the cluster is free."
  exit 1
}

cmd_cluster_done() { if [ -d "$LOCKS/cluster" ] && mine "$LOCKS/cluster"; then drop cluster; fi; return 0; }

# ---------------------------------------------------------------- reports
# Nobody watches a run: what it did is known only from what it left on GitHub.
# So an item is given back only once the run has reported there — read here,
# never written (scripts detect, the agent acts). A report is a comment on the
# issue or its pull request, by `author`, written or edited since the run
# started, that carries this session's id — the session link does — or, for
# pr-opened, the pull request's own body. The labels must say the outcome.
#
# reported <item> <outcome> <pr> <since> — 0 reported · 1 missing, printed ·
# 2 GitHub could not be read
gh_get() { gh api --hostname "$HOST" "$@" 2>/dev/null; }
reported() {
  local item="$1" outcome="$2" pr="$3" since="$4" n="" author mine t got json labels missing=""
  author="$(cfg author)"; mine="$(cfg label_mine)"
  case "$item" in pr*) pr="${pr:-${item#pr}}" ;; *) n="$item" ;; esac
  if [ "$outcome" = pr-opened ]; then
    [ -n "$pr" ] || { echo "pr-opened names no pull request: finish pr-opened <pr>"; return 1; }
    json="$(gh_get "repos/$SLUG/pulls/$pr")" || return 2
    got="$(printf '%s' "$json" | jq -r --arg me "$ME" --arg n "$n" --arg a "$author" --arg mine "$mine" "$JQ_LOGIN"'
      [ (if .state == "open" then empty else "is not open" end),
        (if ($a == "" or (.user.login | login) == ($a | login)) then empty else "was not opened by \($a)" end),
        (if $mine == "" or any(.labels[]?; .name == $mine) then empty else "does not carry \($mine)" end),
        (if (.body // "") | contains($me) then empty else "carries no session link" end),
        (if $n == "" or ((.body // "") | test("(?i)(fix(es|ed)?|close[sd]?|resolve[sd]?) #\($n)(\\D|$)")) then empty
         else "does not say Fixes #\($n)" end)
      ] | join(", ")' 2>/dev/null)" || return 2
    [ -z "$got" ] || missing="pull request #$pr $got"
  else
    got=""
    for t in $n $pr; do
      json="$(gh_get "repos/$SLUG/issues/$t/comments?since=$since&per_page=100")" || return 2
      if printf '%s' "$json" | jq -e --arg me "$ME" --arg a "$author" \
          "$JQ_LOGIN"'any(.[]; ($a == "" or (.user.login | login) == ($a | login)) and ((.body // "") | contains($me)))' >/dev/null 2>&1; then
        got=1; break
      fi
    done
    [ -n "$got" ] || missing="no comment from this run on #${n:-$pr}${pr:+${n:+ or its pull request #$pr}} — say what you did, and what happens next, with this run's session link"
  fi
  if [ -n "$n" ]; then
    case "$outcome" in
      needs-info | blocked | released)
        json="$(gh_get "repos/$SLUG/issues/$n")" || return 2
        labels=" $(printf '%s' "$json" | jq -r '[.labels[]?.name] | join(" ")' 2>/dev/null) "
        case "$labels" in *" $CLAIMED "*) missing="${missing:+$missing; }#$n still carries $CLAIMED" ;; esac
        case "$outcome" in
          needs-info) case "$labels" in *" $NEEDS_INFO "*) ;; *) missing="${missing:+$missing; }#$n does not carry $NEEDS_INFO" ;; esac ;;
          blocked) case "$labels" in *" $FAILED_LABEL "*) ;; *) missing="${missing:+$missing; }#$n does not carry $FAILED_LABEL" ;; esac ;;
        esac ;;
    esac
  fi
  [ -z "$missing" ] && return 0
  echo "$missing"; return 1
}

cmd_finish() {
  local outcome="${1:?outcome}" pr="${2:-}" item slot since f state why rc report=""
  case "$outcome" in
    nothing | pr-opened | pr-updated | released | blocked | waiting-cluster | needs-info) ;;
    *) say "unknown outcome '$outcome'"; exit 2 ;;
  esac
  item="$(my_lock item- | sed 's/^item-//')"
  slot="$(my_lock slot- | sed 's/^slot-//')"
  since=""
  [ -n "$slot" ] && since="$(kv "$LOCKS/slot-$slot/owner" since)"
  [ -z "$since" ] && [ -n "$item" ] && since="$(kv "$LOCKS/item-$item/owner" since)"
  if [ -n "$slot" ]; then
    why="$(unsaved "$SLOTDIR/$slot")"
    if [ -n "$why" ]; then
      say "slot $slot has $why: push it to its branch first — only what is pushed survives this run."
      exit 1
    fi
  fi
  if [ -n "$item" ]; then
    f="$(item_file "$item")"
    [ -n "$pr" ] || pr="$(kv "$f" pr)"
    case "$outcome" in
      pr-opened | pr-updated | nothing)
        if [ -n "$pr" ] && [ "$(kv "$f" babysat_out)" != yes ]; then
          say "#$item has pull request #$pr, and a run keeps its pull request until it is done:"
          say "babysit it — bash \"\$HOME/scripts/run-state.sh\" wait $pr — and finish released once it is approved, green and mergeable,"
          say "blocked when it cannot get there, or pr-updated once wait says babysit_max_hours is up (docs/babysit.md)."
          exit 1
        fi ;;
    esac
    why="$(reported "$item" "$outcome" "$pr" "$since")"; rc=$?
    case "$rc" in
      0) ;;
      2) report=" report=unverified"; say "GitHub could not be read, so the report is unverified — the run is closed anyway, and the log says so." ;;
      *) say "not reported yet: $why."
         say "Nobody watches this run: GitHub is the only place its outcome is seen. Report there, then finish again."
         exit 1 ;;
    esac
  fi
  cmd_cluster_done
  if [ -n "$item" ]; then
    f="$(item_file "$item")"
    case "$outcome" in
      waiting-cluster | needs-info | released | blocked) state="$outcome" ;;
      *) state=parked ;;
    esac
    write "$f" "$f" "$ITEM_KEYS" "state=$state" ${pr:+"pr=$pr"} session=- babysit_since=- round_at=- babysat_out=- "updated_at=$(now)"
    [ -n "$pr" ] || pr="$(kv "$f" pr)"
  fi
  # a saved slot lets go of its branch, so the item's next run may take any slot
  if [ -n "$slot" ] && [ -z "$(unsaved "$SLOTDIR/$slot")" ]; then
    git -C "$SLOTDIR/$slot" switch -q --detach 2>/dev/null || true
  fi
  [ -n "$item" ] && drop "item-$item"
  [ -n "$slot" ] && drop "slot-$slot"
  log_line "$outcome" "$ME" "$item" "$slot" "$pr" "$since" "${report# }"
  # last, so the backup carries this run's TICK.log line
  bash "$HERE/work-backup.sh" persist >&2
  return 0
}

# Frees what dead holders left. A dead slot holder is an abandoned run: logged,
# and counted on its item, which the precheck then lists as half-done. A dead
# cluster holder leaves the cluster in whatever state its step reached.
cmd_sweep() {
  local l name o item f n
  [ -d "$LOCKS" ] || return 0
  for l in "$LOCKS"/*/; do
    l="${l%/}"; name="$(basename "$l")"
    [ -d "$l" ] || continue
    dead "$l" || continue
    o="$l/owner"; item="$(kv "$o" item)"
    case "$name" in
      cluster) touch "$LOCKS/cluster.dirty" ;;
      slot-*)
        if [ -n "$item" ]; then
          f="$(item_file "$item")"; n="$(kv "$f" abandoned)"
          write "$f" "$f" "$ITEM_KEYS" "item=$item" state=abandoned session=- \
            "abandoned=$(( ${n:-0} + 1 ))" "updated_at=$(now)"
          echo "#$item"
        fi
        log_line abandoned "$(kv "$o" session)" "$item" "$(kv "$o" slot)" - "$(kv "$o" since)" \
          "reason=\"session not running, last at '$(kv "$o" phase)'\""
        ;;
    esac
    rm -rf "$l"
  done
  return 0
}

cmd_held() {
  local l
  for l in "$LOCKS"/item-*; do [ -d "$l" ] && basename "$l" | sed 's/^item-//'; done
  return 0
}
cmd_live() {
  local l n=0
  for l in "$LOCKS"/slot-*; do [ -d "$l" ] && n=$((n + 1)); done
  echo "$n"
}

# A live run silent past stuck_after_min: no phase stamp, and its transcript —
# which moves on every tool call — has not moved either
cmd_quiet() {
  local l o s best e t f nowe
  nowe="$(date -u +%s)"
  for l in "$LOCKS"/slot-*; do
    [ -d "$l" ] || continue
    o="$l/owner"; s="$(kv "$o" session)"; best=0
    for t in "$(kv "$o" since)" "$(kv "$o" phase_at)"; do
      e="$(epoch "$t")" && [ "$e" -gt "$best" ] && best="$e"
    done
    f="$(find "$HOME/.claude/projects" -maxdepth 2 -name "$s.jsonl" 2>/dev/null | head -1)"
    [ -n "$f" ] && e="$(mtime "$f")" && [ "$e" -gt "$best" ] && best="$e"
    [ $(( (nowe - best) / 60 )) -ge "$STUCK_MIN" ] &&
      echo "session $s, slot $(kv "$o" slot), #$(kv "$o" item), at \"$(kv "$o" phase)\" since $(kv "$o" phase_at)"
  done
  return 0
}

cmd_diagnosed() {
  local n; n="$(kv "$GATE" diagnoses)"
  write "$GATE" "$GATE" "$GATE_KEYS" "diagnosed_at=$(now)" "diagnoses=$(( ${n:-0} + 1 ))"
  printf '%s diagnostic slots=%s\n' "$(now)" "$(cmd_live)" >> "$LOG"
}

cmd_show() {
  local l
  echo "slots: $(cmd_live) of $N in use"
  for l in "$LOCKS"/*/; do
    l="${l%/}"; [ -d "$l" ] || continue
    printf '%s: ' "$(basename "$l")"; grep -E '^- ' "$l/owner" 2>/dev/null | tr '\n' ' '; echo
  done
  [ -f "$LOCKS/cluster.dirty" ] && echo "cluster: dirty — its last holder died mid-use"
  for l in "$ITEMS"/*.md; do
    [ -f "$l" ] || continue
    printf '#%s: ' "$(basename "$l" .md)"; grep -E '^- ' "$l" | grep -v '^- item:' | tr '\n' ' '; echo
  done
  return 0
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  phase) shift; cmd_phase "$@" ;;
  wait) shift; cmd_wait "$@" ;;
  cluster) cmd_cluster ;;
  cluster-done) cmd_cluster_done ;;
  finish) shift; cmd_finish "$@" ;;
  sweep) cmd_sweep ;;
  held) cmd_held ;;
  live) cmd_live ;;
  quiet) cmd_quiet ;;
  diagnosed) cmd_diagnosed ;;
  show) cmd_show ;;
  *)
    echo "usage: run-state.sh start|phase|wait|cluster|cluster-done|finish|sweep|held|live|quiet|diagnosed|show" >&2
    exit 2
    ;;
esac
