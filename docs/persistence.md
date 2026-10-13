# The definition, its version, and `work/`

Read this when the operator asks for your version or an update, or for a change
to this definition itself.

## Two places, never mixed

| Path | Kind | Holds |
| --- | --- | --- |
| `$HOME` | the definition, a git checkout (`origin`) | `kit.yaml`, `CLAUDE.md`, `AGENTS.md`, `ONBOARDING.md`, `README.md`, `VERSION`, `CHANGELOG.md`, `.gitignore`, `docs/`, `scripts/`, `.github/`, `.agents/skills/implement-issue/`, `.agents/defaults/` |
| `$HOME/work` | runtime state, a plain directory, backed up to `work_repo` | `CONFIG.md`, `AGENTS.md`, `VERSION`, `GATE.md`, `TICK.log`, `AUDIT.log`, `items/`, `slots/`, `also/`, `locks/`, and the checkouts of `repo` and any `repos_also` |

`work/` itself is never a git repository: the home volume is virtiofs over NFS,
and a `.git` that concurrent runs change there corrupts — `Stale file handle`,
`.nfs*` leftovers. The one repository under it is the target's checkout, which
is safe for the same reason as the exclusive lock: one run touches it at a time.

The `.gitignore` at `$HOME` is an allowlist, so `work/` and the home's secrets
(`.ssh`, `.claude`, `.config`) are invisible to the definition. **Never
`git clean` in `$HOME`**, and never `git add` outside the paths in the table.

## Backup

Every fact about the work lives on GitHub — labels, branches, pull requests —
and the tick rebuilds its own bookkeeping from nothing: a missing item file is
an item no run has started on yet, and a lock (`work/locks`) is only ever held by a live turn. What nothing rebuilds is `CONFIG.md`, and the history in
`TICK.log` and `AUDIT.log`. With `work_repo` set, those travel to a private
repository of their own through `scripts/work-backup.sh`, which pushes straight
to its default branch — a repository of data, never of changes for review, and
the only one a script pushes to. Its header says exactly what travels, and why
the git never happens in `work/` itself. Only the files it names travel — the
backup's `.gitignore` shuts out everything else — and a file that looks like it
holds a credential stops the push:

- **persist** — `run-state.sh finish` runs it last, so every closed run is
  backed up. In the direct session, run it after you change `CONFIG.md`:
  `bash "$HOME/scripts/work-backup.sh" persist`. It never fails the run: a
  backup it could not push is retried by the next one. It refuses a `work/`
  that would delete `CONFIG.md` or shorten a log the backup holds — a volume
  nobody restored. Restore it; `WORK_BACKUP_ALLOW_DELETE=1` only when the
  operator means the loss.
- **restore** — onboarding runs it on a fresh volume (`ONBOARDING.md` → **2.
  Ask**). Exit `0` restored · `2` nothing there to restore · `1` failed: stop,
  and never write a new `CONFIG.md` over a backup that exists.

The weekly audit checks that the backup holds the current `CONFIG.md`.
Without `work_repo` there is no backup: a lost `CONFIG.md` costs one onboarding
conversation — delete `$HOME/.software-developer-onboarded` and follow
`ONBOARDING.md`. Until then the precheck finds no repository and declines every
tick, and the weekly audit reports the missing keys.

## Definition version & upgrade

`VERSION` is the definition's version; `work/VERSION` is the one this instance
last adopted. Scheduled runs never act on versions — the audit only reports
drift. Acting happens in the direct session: when the operator asks, and before
any change to the definition (self-modification.md §8).

**Check** — the platform seeds `$HOME` by init and fetch, so ask the remote
which branch is its default rather than trusting `origin/HEAD`:

```sh
branch="$(git -C "$HOME" ls-remote --symref origin HEAD | sed -n 's#^ref: refs/heads/\([^[:space:]]*\).*#\1#p')"
git -C "$HOME" fetch -q origin "$branch"
git -C "$HOME" show FETCH_HEAD:VERSION | head -1   # latest
head -1 "$HOME/VERSION"                            # checked out
head -1 "$HOME/work/VERSION"                       # adopted
```

Checked out behind latest: tell the operator both versions, and update only
when they ask. Adopted behind checked out: migrate now. All equal: up to date.

**Update** a clean checkout by fast-forward, which discards nothing:

```sh
git -C "$HOME" status --porcelain            # must be empty — otherwise stop and ask
git -C "$HOME" merge --ff-only FETCH_HEAD \
  || git -C "$HOME" reset --hard FETCH_HEAD  # only a diverged checkout; say that it was
```

**Migrate** from adopted to checked out:

1. Apply the `CHANGELOG.md` **Upgrade** blocks of every version crossed, oldest
   first. The steps are idempotent, so re-running a partial attempt is safe; a
   step only the operator can do is put to them, never guessed at.
2. Collect every off-by-default feature the crossed versions offer and ask the
   operator once, in one message. Write the key only for a yes.
3. Run `bash "$HOME/scripts/verify-onboarding.sh" --live` and apply every fix.
4. Only after all of it succeeded, write the new version to `work/VERSION`. A
   failed step leaves `work/VERSION` alone, so the next check offers it again.

## Evolving the definition

**First read [self-modification.md](self-modification.md).** A change to this
definition is made when the operator asks in the direct session, or a person
asks in Slack ([self-modification.md](self-modification.md)), never from a
scheduled run, and always as a pull request on the definition's
own repository — beside `repo` and `repos_also`, the one repository you may act
on. No issue and no hand-off label: the pull request is opened directly.

Work in a clone of its own, never in `$HOME`: the instructions you run on must
not change under you, and the harness refuses edits to them.

```sh
d="$(mktemp -d)"; git clone "$(git -C "$HOME" remote get-url origin)" "$d"
git -C "$d" checkout -b "<type>/<short-slug>"
# edit in "$d", run §9's checks there
git -C "$d" add -- kit.yaml CLAUDE.md AGENTS.md ONBOARDING.md README.md VERSION CHANGELOG.md .gitignore docs scripts .github .agents/skills/implement-issue .agents/defaults
git -C "$d" commit -m "<type>: <what changed>"
git -C "$d" push -u origin "<type>/<short-slug>"
(cd "$d" && gh pr create --title "<title>" --body "<what and why>")
```

Your part ends at the pull request; a person merges, and `$HOME` takes it at
the next **Update**. When the connection refuses the push, write the change to
`/tmp/definition.patch` with `git -C "$d" diff`, show it, and hand it to the
operator instead.
