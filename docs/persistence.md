# The definition, its version, and `work/`

Read this when the operator asks for your version or an update, or for a change
to this definition itself.

## Two places, never mixed

| Path | Kind | Holds |
| --- | --- | --- |
| `$HOME` | the definition, a git checkout (`origin`) | `kit.yaml`, `CLAUDE.md`, `AGENTS.md`, `ONBOARDING.md`, `README.md`, `VERSION`, `CHANGELOG.md`, `.gitignore`, `docs/`, `scripts/`, `.github/` |
| `$HOME/work` | runtime state, a plain directory | `CONFIG.md`, `AGENTS.md`, `VERSION`, `RUN.md`, `GATE.md`, `TICK.log`, `AUDIT.log`, and the target repository's checkout |

`work/` itself is never a git repository: the home volume is virtiofs over NFS,
and a `.git` that concurrent runs change there corrupts — `Stale file handle`,
`.nfs*` leftovers. The one repository under it is the target's checkout, which
is safe for the same reason there is one cluster: one run touches it at a time.

The `.gitignore` at `$HOME` is an allowlist, so `work/` and the home's secrets
(`.ssh`, `.claude`, `.config`) are invisible to the definition. **Never
`git clean` in `$HOME`**, and never `git add` outside the paths in the table.

## No backup, by design

Nothing under `work/` is backed up. Every fact about the work lives on GitHub —
labels, branches, pull requests — and the tick rebuilds its own bookkeeping
from nothing: a missing `RUN.md` is no run in flight. The one file that cannot
be reconstructed is `CONFIG.md`, and losing it costs one onboarding
conversation: delete `$HOME/.software-developer-onboarded` and follow
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
definition is made in the direct session, only when the operator asks, never
from a scheduled run, and always as a pull request on the definition's own
repository — the one repository beside `repo` you may act on, and only this way:

```sh
git -C "$HOME" checkout -b "<type>/<short-slug>" FETCH_HEAD
git -C "$HOME" add -- kit.yaml CLAUDE.md AGENTS.md ONBOARDING.md README.md VERSION CHANGELOG.md .gitignore docs scripts .github
git -C "$HOME" commit -m "<type>: <what changed>"
git -C "$HOME" push -u origin "<type>/<short-slug>"
(cd "$HOME" && gh pr create --title "<title>" --body "<what and why>")
```

Your part ends at the pull request; a person merges. When the connection is
scoped to `repo` alone, as README asks, the push is refused: write the change
to `/tmp/definition.patch` with `git -C "$HOME" diff`, show it, and hand it to
the operator instead. Either way, return `$HOME` to where it was with
`git -C "$HOME" checkout -` — the platform may have seeded it detached.
