#!/usr/bin/env bash
# run-state.sh — the one writer of the tick's state: which session works on
# which item, in which slot, and who holds the exclusive lock.
#
# Up to `slots` runs work at once (default 3), one item each, each in a slot of
# its own: a worktree of the checkout at work/slots/<k>, kept between runs so
# its build output stays warm. A run takes an item and a slot when it starts
# and gives both back when it finishes; the branch, pushed, is what carries the
# work from one run to the next. What `exclusive` names — a cluster, a
# database, a device — is one, so whatever touches it runs under a lock of its
# own, taken for those steps alone.
#
# The locks are directories under $LOCKS, on tmpfs: mkdir takes one atomically,
# and a restart — which stops every session, and most shared services — wipes
# them all. Each holds an `owner` file naming its session and the boot it was
# taken in. A holder is dead when its boot is over, or when the runtime says
# its session is not running a turn: a lock never outlives the turn that took
# it. A runtime that does not answer frees nothing.
#
#   start <item> [branch]     take the item and a slot, put the slot on branch
#   also <owner/name>         a worktree of another repository `repos_also`
#                             allows, beside the slot and on its branch
#   phase <text>              before each long step: what, and since when
#   wait <pr>...              babysit: block up to ~9 minutes until one of the
#                             item's pull requests needs the run (exit 0),
#                             nothing yet (3), or the run has babysat them for
#                             babysit_max_hours (4); a pr is #<n> in `repo`,
#                             <owner/name>#<n> elsewhere
#   lock                      take the exclusive lock, or record waiting for it
#   unlock                    give the exclusive lock back
#   finish <outcome> [pr]...  the run's last act, on every way out: refused
#                             until the work is pushed and reported on GitHub
#                             (below); then backs work/ up, and with
#                             slack_channel set says what to post (notify:)
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
. "$HERE/lib/github.sh"

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

default_branch() {   # default_branch [checkout]
  local co="${1:-$CO}"
  git -C "$co" rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's#^origin/##' | grep . ||
    git -C "$co" ls-remote --symref origin HEAD 2>/dev/null | sed -n 's#^ref: refs/heads/\([^[:space:]]*\).*#\1#p' | grep . ||
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

# prepare <slot> <branch> [checkout base] — the slot on <branch>: the remote's tip when it has
# one, else new from the default branch. Ignored files — the build output —
# stay; untracked ones go, so nothing strays into the next item's commit.
# 1 failed · 3 something unsaved is in the way, and the run is to save it.
# Another repository's worktrees are <base>/<slot> of its own checkout (also).
prepare() {
  local k="$1" b="$2" co="${3:-$CO}" base="${4:-$SLOTDIR}" d why other dflt
  d="$base/$k"
  mkdir -p "$base"
  git -C "$co" fetch -q --prune origin 2>/dev/null || { say "git fetch failed in ${co#"$WORK"/}"; return 1; }
  dflt="$(default_branch "$co")"
  # the checkout itself stays on the default branch, kept current: its skills
  # are the ones every run loads (scripts/harness/claude-code/install.sh)
  if [ "$(git -C "$co" symbolic-ref -q --short HEAD)" = "$dflt" ] && [ -z "$(unsaved "$co")" ]; then
    git -C "$co" merge -q --ff-only "origin/$dflt" 2>/dev/null || true
  fi
  if [ ! -e "$d/.git" ]; then
    git -C "$co" worktree add -q --detach "$d" "origin/$dflt" 2>/dev/null ||
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
  for other in "$base"/*; do
    [ -d "$other" ] && [ "$other" != "$d" ] || continue
    [ "$(git -C "$other" rev-parse --abbrev-ref HEAD 2>/dev/null)" = "$b" ] || continue
    if [ -n "$(unsaved "$other")" ] || [ -d "$LOCKS/slot-$(basename "$other")" ]; then
      say "branch $b is checked out in $other, which is in use or holds unsaved work."
      return 3
    fi
    git -C "$other" switch -q --detach 2>/dev/null
  done
  if git -C "$co" rev-parse -q --verify "refs/remotes/origin/$b" >/dev/null; then
    if git -C "$co" rev-parse -q --verify "refs/heads/$b" >/dev/null &&
       [ -n "$(git -C "$co" log --oneline "refs/heads/$b" --not --remotes | head -1)" ]; then
      say "local branch $b has commits not on origin — push them before starting on it."
      return 3
    fi
    git -C "$d" switch -q -C "$b" "origin/$b" || return 1
  elif git -C "$co" rev-parse -q --verify "refs/heads/$b" >/dev/null; then
    git -C "$d" switch -q "$b" || return 1
  else
    git -C "$d" switch -q -c "$b" "origin/$dflt" || return 1
  fi
  git -C "$d" clean -fdq
}

# ours <item> — whether the item is this agent's to work on, read off GitHub.
# Agents that share the login share the claimed label too: with `label_mine`
# set, a claim is ours only when it carries that beside it, and an issue an
# open pull request names is ours only when that pull request is. Prints why
# not; 0 ours · 1 another's · 2 GitHub could not be read
ours() {
  local item="$1" author mine json why
  author="$(cfg author)"; mine="$(cfg label_mine)"
  [ -n "$author" ] || author="$(gh_get user --jq .login)" || return 2
  case "$item" in
    pr*)
      json="$(gh_get "repos/$SLUG/pulls/${item#pr}")" || return 2
      why="$(printf '%s' "$json" | jq -r --arg a "$author" --arg mine "$mine" "$JQ_LOGIN"'
        if (.user.login | login) != ($a | login) then "pull request #\(.number) was opened by \(.user.login)"
        elif $mine != "" and (any(.labels[]?; .name == $mine) | not) then "pull request #\(.number) does not carry \($mine)"
        else empty end' 2>/dev/null)" || return 2 ;;
    *)
      json="$(gh_get "repos/$SLUG/issues/$item")" || return 2
      why="$(printf '%s' "$json" | jq -r --arg claimed "$CLAIMED" --arg mine "$mine" '
        [.labels[]?.name] as $l
        | if $mine != "" and ($l | index($claimed)) and ($l | index($mine) | not)
          then "it carries \($claimed) without \($mine): another agent'"'"'s claim" else empty end' 2>/dev/null)" || return 2
      if [ -z "$why" ]; then
        json="$(gh_get --paginate "repos/$SLUG/pulls?state=open&per_page=100")" || return 2
        json="$(printf '%s' "$json" | jq -s 'add // []')" || return 2
        why="$(printf '%s' "$json" | jq -r --arg n "$item" --arg a "$author" --arg mine "$mine" --arg root "$SLUG" "$JQ_LOGIN$JQ_REFS"'
          map(select(.body | issue_refs($root; $root) | index($n)))
          | map(select(((.user.login | login) == ($a | login) and ($mine == "" or any(.labels[]?; .name == $mine))) | not))
          | first // empty | "pull request #\(.number), not ours, names it"' 2>/dev/null)" || return 2
      fi ;;
  esac
  [ -z "$why" ] && return 0
  echo "$why"; return 1
}

# Another repository's checkout and worktrees: work/<name>, and its worktree
# for slot <k> at work/also/<name>/<k>. pr_split <pr> — "<slug> <number>".
also_dirs() { local d; for d in "$WORK"/also/*/"$1"; do [ -e "$d/.git" ] && echo "$d"; done; return 0; }
pr_split() {
  local r="${1#\#}"
  case "$r" in
    */*\#*) r="${r%%\#*} ${r##*\#}" ;;
    *) r="$SLUG $r" ;;
  esac
  case "${r##* }" in '' | *[!0-9]*) say "'$1' is not a pull request: #<n>, or <owner/name>#<n>"; return 1 ;; esac
  echo "$r"
}

# ------------------------------------------------------------------ verbs
cmd_start() {
  local item="${1:?item: the issue number}" branch="${2:-}" f k last held_by rc why
  item="${item#\#}"
  need_session
  f="$(item_file "$item")"
  checkout || exit 1
  [ -n "$branch" ] || branch="$(kv "$f" branch)"
  [ -n "$branch" ] || { say "item #$item has no branch yet — give one: start $item <branch>"; exit 2; }

  why="$(ours "$item")"; rc=$?
  case "$rc" in
    1) say "#$item is not ours: $why — leave it, and take the next one."; exit 1 ;;
    2) say "GitHub could not be read, so whose #$item is was not measured — start nothing on it now."; exit 1 ;;
  esac
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

# The work comes from an issue of `repo`, and may need changing elsewhere too:
# one more repository a run takes beside its slot, in a worktree of its own on
# the slot's branch, made from a checkout cloned the first time.
cmd_also() {
  local slug="${1:?owner/name}" k b co name rc
  need_session
  k="$(my_lock slot- | sed 's/^slot-//')"
  [ -n "$k" ] || { say "this session holds no slot — call start first"; exit 1; }
  slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]')"
  [ "$slug" != "$(printf '%s' "$SLUG" | tr '[:upper:]' '[:lower:]')" ] || { echo "$slug is \`repo\`: the slot is $SLOTDIR/$k"; exit 0; }
  cfg_allows "$slug" || { say "$slug is neither \`repo\` nor named by \`repos_also\` — only the operator adds it, in the direct session."; exit 1; }
  name="${slug##*/}"; co="$WORK/$name"
  if [ -e "$co/.git" ]; then
    git -C "$co" remote get-url origin 2>/dev/null | tr '[:upper:]' '[:lower:]' | grep -q "[/:]$slug\(\.git\)\?$" ||
      { say "work/$name is a checkout of $(git -C "$co" remote get-url origin 2>/dev/null), not $slug"; exit 1; }
  else
    gh repo clone "$HOST/$slug" "$co" -- -q 2>/dev/null || { say "could not clone $slug into work/$name"; exit 1; }
  fi
  b="$(git -C "$SLOTDIR/$k" symbolic-ref -q --short HEAD)" || { say "slot $k is on no branch"; exit 1; }
  prepare "$k" "$b" "$co" "$WORK/also/$name"; rc=$?
  [ "$rc" -eq 0 ] || exit "$rc"
  stamp "also $slug"
  echo "also $slug: $WORK/also/$name/$k on $b"
}

# A run babysits the pull request it opened until it is done — approved, green,
# mergeable — or cannot be, in its own turn: the item stays held, so no other
# run takes it, and the run that wrote the change answers its review. `wait`
# is how it waits without leaving the turn: one look a minute, up to WAIT_FOR,
# and back to the run the moment there is something to do. What counts as new
# is what came after the run last came back from a wait (round_at). Approved
# ends the review: a review on an approved pull request is not a round, only
# a failed check or a conflict is — or a review the REST fallback could not
# weigh against the decision.
#
# Each look reads the pull request, its reviews and its head's checks over REST
# with the ETags of the look before (lib/github.sh → cget): unchanged is four
# free 304s. Only a change costs the GraphQL read `gh pr view` makes, whose
# review decision is the one that counts; its verdict is kept for the next
# unchanged look. GraphQL refused, the verdict is read off the REST answers,
# whose decision is approximate, so it never says done.
#
# pr_state <slug> <pr> <since> <dir> — prints the verdict line, `act …` or
# `wait …`; 0 read · 2 unreadable
pr_state() {
  local slug="$1" json changed=0 sha k verdict
  shift
  mkdir -p "$3"
  if cget "$3" pull "$HOST" "repos/$slug/pulls/$1"; then changed=1; else [ $? -eq 1 ] || changed=2; fi
  sha="$(jq -r '.head.sha // empty' "$3/pull.json" 2>/dev/null)"
  [ -n "$sha" ] || changed=2
  if [ "$changed" != 2 ]; then
    for k in "reviews pulls/$1/reviews?per_page=100" "checks commits/$sha/check-runs?per_page=100" "status commits/$sha/status"; do
      if cget "$3" "${k%% *}" "$HOST" "repos/$slug/${k#* }"; then changed=1; else [ $? -eq 1 ] || { changed=2; break; }; fi
    done
  fi
  if [ "$changed" = 0 ] && [ -s "$3/verdict" ]; then cat "$3/verdict"; return 0; fi
  rm -f "$3/verdict"
  if json="$(gh pr view "$1" -R "$HOST/$slug" --json state,mergeable,reviewDecision,headRefOid,latestReviews,statusCheckRollup 2>/dev/null)"; then
    :
  elif [ "$changed" != 2 ]; then
    json="$(jq -n --slurpfile pull "$3/pull.json" --slurpfile reviews "$3/reviews.json" \
      --slurpfile checks "$3/checks.json" --slurpfile status "$3/status.json" \
      '{pull: $pull[0], reviews: $reviews[0], checks: $checks[0], status: $status[0]}' 2>/dev/null |
      jq "$JQ_LOGIN$JQ_REST_PR" 2>/dev/null)" || return 2
  else
    return 2
  fi
  verdict="$(printf '%s' "$json" | jq -r --arg since "$2" --arg author "$(cfg author)" "$JQ_LOGIN"'
    ([.latestReviews[]? | select((.author.login | login) != ($author | login)) | select(.submittedAt > $since)]) as $new
    | ([.statusCheckRollup[]? | (.conclusion // .state // "")]) as $all
    | ([.statusCheckRollup[]? | select((.conclusion // .state // "") | test("^(FAILURE|ERROR|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED|CANCELLED)$"))
        | select((.completedAt // .startedAt // "") > $since) | (.name // .context)]) as $failed
    | ([$all[] | select(test("^(SUCCESS|SKIPPED|NEUTRAL)$") | not)] | length == 0) as $green
    | if .state == "MERGED" then "act merged — the pull request is merged: release the issue"
      elif .state == "CLOSED" then "act closed — closed without merging: read why, release the issue"
      elif ($failed | length) > 0 then "act checks failed: \($failed | join(", "))"
      elif ($new | length) > 0 and (.reviewDecision != "APPROVED" or .approximate) then "act reviewed by \([$new[].author.login] | unique | join(", ")) (\([$new[].state] | unique | join(", "))): resolve every finding"
      elif .mergeable == "CONFLICTING" then "act conflicts with the base branch: rebase"
      elif .reviewDecision == "APPROVED" and $green and .approximate then "wait approved by its reviews and green; GitHub'"'"'s review decision is unreadable (GraphQL), so not yet done"
      elif .reviewDecision == "APPROVED" and $green and .mergeable == "MERGEABLE" then "act done — approved, green and mergeable: release the issue"
      elif .reviewDecision == "APPROVED" and $green then "wait approved and green; GitHub is still computing mergeability"
      elif $green then "wait green, waiting for a review"
      else "wait checks running" end' 2>/dev/null)" || return 2
  printf '%s\n' "$verdict"
  case "$verdict" in wait*) printf '%s' "$json" | jq -e '.approximate' >/dev/null 2>&1 || printf '%s\n' "$verdict" > "$3/verdict" ;; esac
}

# An item's work may be several pull requests, one a repository: wait looks at
# them all, comes back for the first that needs the run, and says done only
# once every one is approved, green and mergeable — or merged.
cmd_wait() {
  [ $# -ge 1 ] || { say "usage: wait <pr>..."; exit 2; }
  local item f since start nowe waited verdict rc=3 last="" ref refs="" labels="" i n done_n act
  need_session
  item="$(my_lock item- | sed 's/^item-//')"
  [ -n "$item" ] || { say "this session holds no item — call start first"; exit 1; }
  for ref in "$@"; do
    ref="$(pr_split "$ref")" || exit 2
    set -- $ref
    [ "$1" = "$SLUG" ] && refs="$refs $2" || refs="$refs $1#$2"
  done
  refs="${refs# }"
  f="$(item_file "$item")"
  write "$f" "$f" "$ITEM_KEYS" "pr=$refs" "updated_at=$(now)"
  [ -n "$(kv "$f" babysit_since)" ] || write "$f" "$f" "$ITEM_KEYS" "babysit_since=$(now)" "round_at=$(kv "$LOCKS/item-$item/owner" since)"
  since="$(kv "$f" round_at)"
  start="$(date -u +%s)"
  seen="$(mktemp -d)" || exit 2
  trap 'rm -rf "$seen"' EXIT
  for ref in $refs; do case "$ref" in *\#*) labels="$labels $ref" ;; *) labels="$labels #$ref" ;; esac; done
  labels="${labels# }"
  if waited="$(epoch "$(kv "$f" babysit_since)")" && [ $(( (start - waited) / 3600 )) -ge "$MAX_H" ]; then
    write "$f" "$f" "$ITEM_KEYS" babysat_out=yes
    echo "timeout — babysat $labels for ${MAX_H}h (babysit_max_hours). Report where it stands and who it waits on, then finish pr-updated: a later run takes it over when something lands."
    exit 4
  fi
  n="$(echo $refs | wc -w)"
  while :; do
    stamp "babysit $labels: ${last:-looking}"
    i=0; done_n=0; act=""; last=""
    for ref in $refs; do
      i=$((i + 1))
      # shellcheck disable=SC2046 # "<slug> <n>", checked above
      set -- $(pr_split "$ref")
      verdict="$(pr_state "$1" "$2" "$since" "$seen/$i")"; rc=$?
      [ "$n" -gt 1 ] && ref="$(echo $labels | cut -d' ' -f"$i"): " || ref=""
      if [ "$rc" -ne 0 ]; then
        last="${last:+$last; }${ref}GitHub unreadable"
        continue
      fi
      case "$verdict" in
        "act done"* | "act merged"*) done_n=$((done_n + 1)); [ "$n" -gt 1 ] || act="${verdict#act }" ;;
        act*) [ -n "$act" ] || act="$ref${verdict#act }" ;;
        *) last="${last:+$last; }$ref${verdict#wait }" ;;
      esac
    done
    [ -z "$act" ] && [ "$n" -gt 1 ] && [ "$done_n" -eq "$n" ] &&
      act="done — every pull request is approved, green and mergeable, or merged: release the issue"
    if [ -n "$act" ]; then
      write "$f" "$f" "$ITEM_KEYS" "round_at=$(now)" "updated_at=$(now)"
      stamp "babysit $labels: $act"
      echo "$act"; exit 0
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

cmd_lock() {
  local item f
  need_session
  item="$(my_lock item- | sed 's/^item-//')"
  [ -n "$item" ] || { say "this session holds no item — call start first"; exit 1; }
  f="$(item_file "$item")"
  cmd_sweep >/dev/null
  if take exclusive "item=$item"; then
    if [ -f "$LOCKS/exclusive.dirty" ]; then
      echo "lock: yours. Its last holder died mid-use: bring what exclusive names back to a known state before anything else (docs/exclusive.md)."
      rm -f "$LOCKS/exclusive.dirty"
    else
      echo "lock: yours."
    fi
    write "$f" "$f" "$ITEM_KEYS" state=active "updated_at=$(now)"
    stamp lock
    return 0
  fi
  write "$f" "$f" "$ITEM_KEYS" state=waiting-lock "updated_at=$(now)"
  say "the exclusive lock is held by session $(kv "$LOCKS/exclusive/owner" session) for #$(kv "$LOCKS/exclusive/owner" item), at \"$(kv "$LOCKS/exclusive/owner" phase)\"."
  say "Push what you have and finish waiting-lock: the precheck wakes this item once the lock is free."
  exit 1
}

cmd_unlock() { if [ -d "$LOCKS/exclusive" ] && mine "$LOCKS/exclusive"; then drop exclusive; fi; return 0; }

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
  local item="$1" outcome="$2" prs="$3" since="$4" n="" author mine t got json labels missing="" ref closes=""
  author="$(cfg author)"; mine="$(cfg label_mine)"
  case "$item" in pr*) prs="${prs:-${item#pr}}" ;; *) n="$item" ;; esac
  if [ "$outcome" = pr-opened ]; then
    [ -n "$prs" ] || { echo "pr-opened names no pull request: finish pr-opened <pr>..."; return 1; }
    for ref in $prs; do
      ref="$(pr_split "$ref")" || return 1
      set -- $ref
      json="$(gh_get "repos/$1/pulls/$2")" || return 2
      got="$(printf '%s' "$json" | jq -r --arg me "$ME" --arg n "$n" --arg a "$author" --arg mine "$mine" \
          --arg root "$SLUG" --arg here "$1" "$JQ_LOGIN$JQ_REFS"'
        (($here | ascii_downcase) != ($root | ascii_downcase)) as $other
        | [ (if .state == "open" then empty else "is not open" end),
          (if ($a == "" or (.user.login | login) == ($a | login)) then empty else "was not opened by \($a)" end),
          (if $mine == "" or any(.labels[]?; .name == $mine) then empty else "does not carry \($mine)" end),
          (if (.body // "") | contains($me) then empty else "carries no session link" end),
          (if $n == "" or (.body | issue_refs($root; $here) | index($n)) then empty
           elif $other then "does not say Fixes or Part of \($root)#\($n)"
           else "does not say Fixes #\($n)" end)
        ] | join(", ")' 2>/dev/null)" || return 2
      [ "$1" = "$SLUG" ] && t="#$2" || t="$1#$2"
      [ -z "$got" ] || missing="${missing:+$missing; }pull request $t $got"
      [ -z "$n" ] || ! printf '%s' "$json" | jq -e --arg n "$n" --arg root "$SLUG" --arg here "$1" \
        "$JQ_REFS"'.body | closes_refs($root; $here) | index($n)' >/dev/null 2>&1 || closes=1
    done
    [ -z "$n" ] || [ -n "$closes" ] ||
      missing="${missing:+$missing; }none of them says Fixes #$n — the one in $SLUG does, or else one of the others, as Fixes $SLUG#$n"
  else
    got=""
    for t in ${n:+"$n"} $prs; do
      ref="$(pr_split "$t")" || return 1
      set -- $ref
      json="$(gh_get "repos/$1/issues/$2/comments?since=$since&per_page=100")" || return 2
      if printf '%s' "$json" | jq -e --arg me "$ME" --arg a "$author" \
          "$JQ_LOGIN"'any(.[]; ($a == "" or (.user.login | login) == ($a | login)) and ((.body // "") | contains($me)))' >/dev/null 2>&1; then
        got=1; break
      fi
    done
    [ -n "$got" ] || missing="no comment from this run on #${n:-$prs}${prs:+${n:+ or its pull request $prs}} — say what you did, and what happens next, with this run's session link"
  fi
  if [ -n "$n" ]; then
    case "$outcome" in
      needs-info | blocked | released)
        json="$(gh_get "repos/$SLUG/issues/$n")" || return 2
        labels=" $(printf '%s' "$json" | jq -r '[.labels[]?.name] | join(" ")' 2>/dev/null) "
        case "$labels" in *" $CLAIMED "*) missing="${missing:+$missing; }#$n still carries $CLAIMED" ;; esac
        # the claim is the pair: giving it up drops both
        if [ -n "$mine" ]; then case "$labels" in *" $mine "*) missing="${missing:+$missing; }#$n still carries $mine" ;; esac; fi
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
  local outcome="${1:?outcome}" pr="${*:2}" item slot since f state why rc report="" d
  case "$outcome" in
    nothing | pr-opened | pr-updated | released | blocked | waiting-lock | needs-info) ;;
    *) say "unknown outcome '$outcome'"; exit 2 ;;
  esac
  item="$(my_lock item- | sed 's/^item-//')"
  slot="$(my_lock slot- | sed 's/^slot-//')"
  since=""
  [ -n "$slot" ] && since="$(kv "$LOCKS/slot-$slot/owner" since)"
  [ -z "$since" ] && [ -n "$item" ] && since="$(kv "$LOCKS/item-$item/owner" since)"
  if [ -n "$slot" ]; then
    for d in "$SLOTDIR/$slot" $(also_dirs "$slot"); do
      why="$(unsaved "$d")"
      if [ -n "$why" ]; then
        say "${d#"$WORK"/} has $why: push it to its branch first — only what is pushed survives this run."
        exit 1
      fi
    done
  fi
  if [ -n "$item" ]; then
    f="$(item_file "$item")"
    [ -n "$pr" ] || pr="$(kv "$f" pr)"
    case "$outcome" in
      pr-opened | pr-updated | nothing)
        # interactive, the operator holds the pull request: no later run would
        # take it over, so it is theirs to bring back (docs/direct-session.md)
        if [ -n "$pr" ] && [ "$(kv "$f" babysat_out)" != yes ] && [ "$(cfg_mode)" != interactive ]; then
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
  cmd_unlock
  if [ -n "$item" ]; then
    f="$(item_file "$item")"
    case "$outcome" in
      waiting-lock | needs-info | released | blocked) state="$outcome" ;;
      *) state=parked ;;
    esac
    write "$f" "$f" "$ITEM_KEYS" "state=$state" ${pr:+"pr=$pr"} session=- babysit_since=- round_at=- babysat_out=- "updated_at=$(now)"
    [ -n "$pr" ] || pr="$(kv "$f" pr)"
  fi
  # a saved slot lets go of its branch, so the item's next run may take any slot
  if [ -n "$slot" ]; then
    for d in "$SLOTDIR/$slot" $(also_dirs "$slot"); do
      [ -z "$(unsaved "$d")" ] && git -C "$d" switch -q --detach 2>/dev/null || true
    done
  fi
  [ -n "$item" ] && drop "item-$item"
  [ -n "$slot" ] && drop "slot-$slot"
  log_line "$outcome" "$ME" "$item" "$slot" "$(echo $pr | tr ' ' ,)" "$since" "${report# }"
  # last, so the backup carries this run's TICK.log line
  bash "$HERE/work-backup.sh" persist >&2
  # a moment a person acts on: the agent posts it, a script never does
  if [ -n "$(cfg slack_channel)" ]; then
    case "$outcome" in
      released) [ -z "$pr" ] || say "notify: if #$pr is still open, post that it is ready to merge to slack_channel $(cfg slack_channel) (docs/notify.md)" ;;
      needs-info | blocked) say "notify: post this $outcome to slack_channel $(cfg slack_channel) (docs/notify.md)" ;;
    esac
  fi
  return 0
}

# Frees what dead holders left. A dead slot holder is an abandoned run: logged,
# and counted on its item, which the precheck then lists as half-done. A dead
# lock holder leaves what `exclusive` names in whatever state its step reached.
cmd_sweep() {
  local l name o item f n
  [ -d "$LOCKS" ] || return 0
  for l in "$LOCKS"/*/; do
    l="${l%/}"; name="$(basename "$l")"
    [ -d "$l" ] || continue
    dead "$l" || continue
    o="$l/owner"; item="$(kv "$o" item)"
    case "$name" in
      exclusive) touch "$LOCKS/exclusive.dirty" ;;
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
  [ -f "$LOCKS/exclusive.dirty" ] && echo "exclusive: dirty — its last holder died mid-use"
  for l in "$ITEMS"/*.md; do
    [ -f "$l" ] || continue
    printf '#%s: ' "$(basename "$l" .md)"; grep -E '^- ' "$l" | grep -v '^- item:' | tr '\n' ' '; echo
  done
  return 0
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  also) shift; cmd_also "$@" ;;
  phase) shift; cmd_phase "$@" ;;
  wait) shift; cmd_wait "$@" ;;
  lock) cmd_lock ;;
  unlock) cmd_unlock ;;
  finish) shift; cmd_finish "$@" ;;
  sweep) cmd_sweep ;;
  held) cmd_held ;;
  live) cmd_live ;;
  quiet) cmd_quiet ;;
  diagnosed) cmd_diagnosed ;;
  show) cmd_show ;;
  *)
    echo "usage: run-state.sh start|also|phase|wait|lock|unlock|finish|sweep|held|live|quiet|diagnosed|show" >&2
    exit 2
    ;;
esac
