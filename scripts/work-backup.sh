#!/usr/bin/env bash
# work-backup.sh — backs work/ up to `work_repo` and restores it from there.
# The one script that commits and pushes (docs/self-modification.md §4), and
# only to that repository.
#
#   persist   work/ -> commit -> push; run-state.sh finish calls it last
#   restore   the backup -> work/, on a fresh volume (ONBOARDING.md)
#
# What travels is work/'s own top-level files: CONFIG.md, the logs, VERSION,
# AGENTS.md. Never a directory — the checkout and its worktrees live on GitHub
# already — never a dotfile, and never RUN.md or GATE.md, which describe this
# sandbox's processes and mean nothing on another one. A README.md or LICENSE
# belongs to the backup repository itself, and stays there untouched.
#
# All git happens in a clone on tmpfs, never in work/: the home volume is
# virtiofs over NFS, and a .git there corrupts under concurrent runs
# (docs/persistence.md). work/ is only read by persist and only written by
# restore. The clone is scratch — wiped on restart, re-seeded from the remote
# on every call — so nothing authoritative ever lives in it.
#
# persist always exits 0: a missed backup is retried by the next run, and the
# state is still in work/. It refuses a snapshot that deletes CONFIG.md or
# shortens an append-only log the backup holds: that work/ was never restored,
# and pushing it would bury the history. WORK_BACKUP_ALLOW_DELETE=1 is the
# operator saying the loss is intended.
#
# restore exits 0 restored and verified · 2 nothing to restore (no work_repo,
# an empty remote, or one without CONFIG.md) · 1 failed.
set -u

MODE="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib/config.sh"

WORK="$HOME/work"
LOCAL="${WORK_BACKUP_LOCAL:-/dev/shm/software-developer-work}"
LOCK="$LOCAL.lock"
LOCK_TTL_MIN=10
BRANCH="${WORK_BACKUP_BRANCH:-main}"
RETRIES=3
PROTECTED="CONFIG.md"
APPEND_ONLY="TICK.log AUDIT.log"

say() { echo "work-backup: $*"; }
end() { [ "$MODE" = restore ] && exit "$1"; exit 0; }

case "$MODE" in persist | restore) ;; *) echo "usage: $0 persist|restore" >&2; exit 2 ;; esac

WORK_REPO="$(cfg work_repo)"
if [ -z "$WORK_REPO" ]; then
  say "no work_repo in work/CONFIG.md — work/ is not backed up."
  end 2
fi
case "$WORK_REPO" in */*/*) REF="$WORK_REPO" ;; *) REF="github.com/$WORK_REPO" ;; esac
REMOTE="${WORK_BACKUP_REMOTE:-https://$REF}"

# carried <dir> — the top-level files that travel, one name per line
carried() {
  find "$1" -mindepth 1 -maxdepth 1 -type f ! -name '.*' ! -name RUN.md ! -name GATE.md \
    ! -name README.md ! -name LICENSE \
    -exec basename {} \; 2>/dev/null | sort
}

git_() { git -C "$LOCAL" -c user.name=software-developer \
  -c user.email=software-developer@agents.local -c commit.gpgsign=false "$@"; }

# mkdir is atomic; a lock older than the TTL is a crashed persist's, and is
# taken over by rename, which only one taker can win
HELD=0
lock() {
  if mkdir "$LOCK" 2>/dev/null; then HELD=1; return 0; fi
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin "+$LOCK_TTL_MIN" 2>/dev/null)" ] &&
     mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null; then
    rm -rf "$LOCK.stale.$$"
    mkdir "$LOCK" 2>/dev/null && { HELD=1; return 0; }
  fi
  return 1
}
unlock() { [ "$HELD" = 1 ] && rm -rf "$LOCK"; HELD=0; }
trap unlock EXIT
trap 'exit 1' INT TERM

# seed — the clone, on the remote's tip, or a new repository when the remote
# has no branch yet (the first backup)
seed() {
  if ! git -C "$LOCAL" rev-parse --git-dir >/dev/null 2>&1; then
    rm -rf "$LOCAL"
    git init -q "$LOCAL" && git -C "$LOCAL" remote add origin "$REMOTE" || return 1
  fi
  git -C "$LOCAL" remote set-url origin "$REMOTE"
  if git -C "$LOCAL" fetch -q origin "$BRANCH" 2>/dev/null; then
    git -C "$LOCAL" checkout -q -f -B "$BRANCH" FETCH_HEAD || return 1
  elif git -C "$LOCAL" ls-remote origin >/dev/null 2>&1; then
    git -C "$LOCAL" checkout -q -f --orphan "$BRANCH" 2>/dev/null || true
    git -C "$LOCAL" rm -rq --cached . 2>/dev/null || true
  else
    return 1
  fi
  return 0
}

# lines <file> — its line count, 0 when missing
lines() { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }

persist() {
  local attempt=0 f gone
  lock || { say "another persist is running — skipping; the next run backs up what it misses."; return 0; }
  while [ "$attempt" -lt "$RETRIES" ]; do
    attempt=$((attempt + 1))
    seed || { say "could not reach $REF (attempt $attempt)."; continue; }

    gone=""
    if [ "${WORK_BACKUP_ALLOW_DELETE:-0}" != 1 ]; then
      for f in $PROTECTED; do
        [ -f "$LOCAL/$f" ] && [ ! -f "$WORK/$f" ] && gone="$gone $f"
      done
      for f in $APPEND_ONLY; do
        [ "$(lines "$WORK/$f")" -lt "$(lines "$LOCAL/$f")" ] && gone="$gone $f"
      done
    fi
    if [ -n "$gone" ]; then
      say "refused: work/ would lose${gone} the backup holds — it looks unrestored; restore it first (docs/persistence.md → Backup)."
      return 0
    fi

    # mirror: what left work/ leaves the backup, what is in work/ is copied in
    carried "$LOCAL" | while read -r f; do rm -f "$LOCAL/$f"; done
    carried "$WORK" | while read -r f; do cp "$WORK/$f" "$LOCAL/$f"; done
    git_ add -A || continue
    if git_ diff --cached --quiet; then say "nothing to back up."; return 0; fi
    git_ commit -qm "chore(work): back up work/ $(date -u +%Y-%m-%dT%H:%M:%SZ)" || continue
    if git_ push -q origin "HEAD:refs/heads/$BRANCH" 2>/dev/null; then
      say "backed up to $REF."; return 0
    fi
    say "push to $REF rejected (attempt $attempt) — retrying from its new tip."
  done
  say "gave up after $RETRIES attempts; work/ is intact and the next run retries."
  return 0
}

restore() {
  local f n=0 bad=0 heads w=0
  while ! lock; do
    w=$((w + 1)); [ "$w" -ge 5 ] && break
    sleep 1
  done
  if ! heads="$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null)"; then
    say "could not reach $REF — work/ left as it is."; return 1
  fi
  [ -n "$heads" ] || { say "$REF is empty — nothing to restore."; return 2; }
  rm -rf "$LOCAL"
  git clone -q --branch "$BRANCH" "$REMOTE" "$LOCAL" 2>/dev/null ||
    { say "could not clone $REF — work/ left as it is."; return 1; }
  [ -f "$LOCAL/CONFIG.md" ] || { say "$REF holds no CONFIG.md — nothing to restore."; return 2; }
  mkdir -p "$WORK" || return 1
  while read -r f; do
    [ -n "$f" ] || continue
    n=$((n + 1))
    cp "$LOCAL/$f" "$WORK/$f" && cmp -s "$LOCAL/$f" "$WORK/$f" || bad=$((bad + 1))
  done <<EOF
$(carried "$LOCAL")
EOF
  if [ "$bad" -eq 0 ]; then say "restored $n file(s) from $REF."; return 0; fi
  say "restore incomplete: $bad of $n file(s) did not arrive intact."; return 1
}

"$MODE"
end $?
