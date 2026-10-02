#!/usr/bin/env bash
# work-backup.sh: what travels, what never does, and a backup that is never
# overwritten by a work/ that was not restored.
. "$(dirname "$0")/helpers.sh"

# backed — a sandbox whose work_repo is a local bare repository
backed() {
  sandbox
  echo "- work_repo: acme/widgets-work" >> "$HOME/work/CONFIG.md"
  git init -q --bare "$HOME/remote.git"
  export WORK_BACKUP_REMOTE="$HOME/remote.git" WORK_BACKUP_LOCAL="$HOME/shm/clone"
  mkdir -p "$HOME/shm"
}
backup() { OUT="$(bash "$SCRIPTS/work-backup.sh" "$@" 2>&1)"; RC=$?; }
remote_files() { git -C "$HOME/remote.git" ls-tree --name-only main 2>/dev/null | tr '\n' ' '; }
remote_commits() { git -C "$HOME/remote.git" rev-list --count main 2>/dev/null || echo 0; }

CASE="without work_repo, nothing is backed up"; sandbox
unset WORK_BACKUP_REMOTE
backup persist
is "$RC" 0 "persist exit"
has "$OUT" "no work_repo" "says so"
backup restore
is "$RC" 2 "restore exit"
done_

CASE="persist carries work/'s files, and nothing else"; backed
echo "1 line" > "$HOME/work/TICK.log"; echo v > "$HOME/work/VERSION"
echo "- run_state: idle" > "$HOME/work/RUN.md"; echo "- busy_since: x" > "$HOME/work/GATE.md"
echo tmp > "$HOME/work/.RUN.md.abc"; mkdir -p "$HOME/work/widgets/.git"; echo x > "$HOME/work/widgets/f"
echo stray > "$HOME/work/notes.txt"
backup persist
is "$RC" 0 "exit"
has "$OUT" "backed up" "pushed"
is "$(remote_files)" ".gitignore CONFIG.md TICK.log VERSION " "only the allowlist travels"
git -C "$HOME/remote.git" show main:.gitignore | grep -qx '/\*' || fail "the backup's .gitignore does not shut everything out"
[ ! -e "$HOME/work/.git" ] || fail "made work/ a git repository"
backup persist
has "$OUT" "nothing to back up" "an unchanged work/ pushes nothing"
is "$(remote_commits)" 1 "commits"
echo "2 line" >> "$HOME/work/TICK.log"; rm "$HOME/work/VERSION"
backup persist
is "$(remote_commits)" 2 "a change is a new commit"
is "$(remote_files)" ".gitignore CONFIG.md TICK.log " "a file gone from work/ leaves the backup"
done_

CASE="a work/ that was never restored does not overwrite the backup"; backed
printf 'a\nb\n' > "$HOME/work/TICK.log"
backup persist
echo a > "$HOME/work/TICK.log"
backup persist
is "$RC" 0 "exit"
has "$OUT" "refused" "refused"
has "$OUT" "TICK.log" "names the log"
is "$(remote_commits)" 1 "nothing pushed"
WORK_BACKUP_ALLOW_DELETE=1 backup persist
is "$(remote_commits)" 2 "the operator may allow it"
done_

CASE="persist builds on the tip another push left, never forces over it"; backed
echo a > "$HOME/work/TICK.log"; backup persist
other="$(mktemp -d)"; git clone -q -b main "$HOME/remote.git" "$other/c"
echo "9.9.9" > "$other/c/VERSION"
git -C "$other/c" add VERSION
git -C "$other/c" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -qm other
git -C "$other/c" push -q origin HEAD:main; rm -rf "$other"
printf 'a\nb\n' > "$HOME/work/TICK.log"; backup persist
is "$(remote_commits)" 3 "on top of the other push"
done_

CASE="restore brings work/ back from the backup"; backed
printf 'a\nb\n' > "$HOME/work/TICK.log"; echo "1.0.0" > "$HOME/work/VERSION"
backup persist
cp "$HOME/work/CONFIG.md" "$HOME/config.saved"
rm -f "$HOME/work/TICK.log" "$HOME/work/VERSION"; rm -rf "$HOME/shm/clone"
echo "- work_repo: acme/widgets-work" > "$HOME/work/CONFIG.md"
backup restore
is "$RC" 0 "exit"
has "$OUT" "restored 3 file(s)" "verified"
cmp -s "$HOME/work/CONFIG.md" "$HOME/config.saved" || fail "CONFIG.md differs"
is "$(cat "$HOME/work/VERSION")" "1.0.0" "VERSION"
done_

CASE="the backup repository's own README and LICENSE stay"; backed
seedc="$(mktemp -d)"; git init -q -b main "$seedc/c"; echo readme > "$seedc/c/README.md"; echo l > "$seedc/c/LICENSE"
git -C "$seedc/c" add -A
git -C "$seedc/c" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -qm init
git -C "$seedc/c" push -q "$HOME/remote.git" HEAD:main; rm -rf "$seedc"
backup restore
is "$RC" 2 "a repository with no CONFIG.md holds no backup"
[ ! -f "$HOME/work/README.md" ] || fail "restored the repository's README"
backup persist
is "$(remote_files)" ".gitignore CONFIG.md LICENSE README.md " "kept beside the backup"
done_

CASE="a credential in a carried file stops the push"; backed
echo "- note: token = ghp_$(printf 'a%.0s' $(seq 36))" >> "$HOME/work/CONFIG.md"
backup persist
is "$RC" 0 "exit"
has "$OUT" "refused: what looks like a credential is in CONFIG.md" "names the file"
lacks "$OUT" "ghp_" "never prints the match"
is "$(remote_commits)" 0 "nothing pushed"
done_

CASE="restore from an empty or unreachable remote"; backed
backup restore
is "$RC" 2 "empty remote"
WORK_BACKUP_REMOTE="$HOME/nowhere.git" backup restore
is "$RC" 1 "unreachable"
WORK_BACKUP_REMOTE="$HOME/nowhere.git" backup persist
is "$RC" 0 "persist never fails the run"
done_

CASE="finish backs up the run's log line"; backed
CLAUDE_CODE_SESSION_ID=sess-a state finish nothing
is "$RC" 0 "exit"
has "$(cat "$HOME/err")" "backed up" "persisted"
git -C "$HOME/remote.git" show main:TICK.log | grep -q ' nothing session=sess-a ' || fail "no log line in the backup"
done_

exit "$FAILED"
