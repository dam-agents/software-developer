# Changelog

**Migration instructions, not a change log.** Per version, the idempotent
**Upgrade** steps a deployed instance applies when it crosses that version —
what to run, update or change: schedules, config keys, state formats. Most
versions need nothing. What changed and why lives in the pull requests.

Applying the kit never touches an agent already created from it, so an instance
crosses a version only when its operator walks it through these steps, in the
direct session.

## 2.1.0 — 2026-10-02

The repository's own skills load in every run: onboarding links
`work/.claude/skills` to the checkout's skills, because a run works from
`work/` and Claude Code loads project skills from there alone. The checkout
itself is kept on its default branch, fast-forwarded by `run-state.sh start`,
so the linked skills stay current. A step of theirs that waits for a person
goes through GitHub instead.

**Upgrade:**

1. Run `bash "$HOME/scripts/harness/claude-code/install.sh"`, and show the
   operator the skills it linked.
2. Re-run `bash "$HOME/scripts/verify-onboarding.sh" --live`: it now checks
   `harness.skills` and `harness.repo_skills`.

## 2.0.0 — 2026-10-02

Up to `slots` runs (default 3) now work at once, one issue each, each in a
worktree of its own under `work/slots/` that stays warm between runs. Only the
cluster is one at a time, under a lock of its own, so a pull request waiting
on review holds nothing. The locks live on tmpfs, and a holder is freed only
when the runtime says its session is not running a turn, or the sandbox
restarted. `work/RUN.md` is gone; `work/items/<n>.md` caches each issue's
branch, slot and state (`docs/runs.md`). New issues are implemented through
the bundled `implement-issue` skill; an issue too unclear to implement goes to
`agent/needs-info`. No run ends unreported: `finish` refuses until the work is
pushed and reported on the issue or its pull request, and a `Stop` hook keeps
the turn from ending before that. `work/` can be backed up to a private `work_repo`
(`docs/persistence.md` → **Backup**), through `scripts/work-backup.sh`.

**Upgrade:**

1. Wait until no run is in flight (`list_schedules` shows the tick idle, or
   pause it), then delete `work/RUN.md`, and `work/GATE.md` if it holds a
   `busy_since` line.
2. List the checkout's worktrees (`git -C "$HOME/work/<name>" worktree list`).
   For each one outside `work/slots/`: push anything unsaved to its branch,
   then `git worktree remove` it — never `--force` on unsaved work; ask the
   operator about that.
3. Split `verify` with the operator: what runs without a cluster stays in
   `verify`; what needs the cluster — an end-to-end suite, anything that
   reinstalls or resets it — becomes `verify_cluster`. Leave `verify_cluster`
   out when nothing needs the cluster.
4. Create the needs-info label on `repo` once the operator agrees to its name
   (`gh label create agent/needs-info -R <repo>`), and add
   `- label_needs_info: <name>` to `work/CONFIG.md` when it is not the default.
5. Offer the backup to the operator: it needs a private repository they
   create (suggest `<owner>/<agent>-work`), and write on its contents for the
   connection — **operator only**. For a yes, add `- work_repo: <owner/name>`
   to `work/CONFIG.md`, then run `bash "$HOME/scripts/work-backup.sh" persist`
   and check that it says `backed up`.
6. Register the `Stop` hook: `bash "$HOME/scripts/harness/claude-code/install.sh"`.
   It takes effect from the next session.
7. Re-run `bash "$HOME/scripts/verify-onboarding.sh" --live` and apply every
   fix: it now checks the slots, the items, the needs-info label, the `Stop`
   hook, the push to `work_repo`, and that the runtime lists sessions.

## 1.2.0 — 2026-10-01

The kit sets `PLATFORM_SANDBOX=1`, so a repository's own tooling can tell it
runs in a DAM sandbox and adapt (e.g. install its cluster without a mesh); the
definition no longer asks for a mesh-less `cluster_install`. The kit also
creates the agent with the `all` egress preset (`egressPreset` in `kit.yaml`).

**Upgrade:**

1. **Operator only:** add the environment variable `PLATFORM_SANDBOX=1` to
   this agent's settings, and apply the *Allow all* egress preset. `kit.yaml` is
   read only at create, so an existing agent does not get either otherwise.
2. Once the agent's environment has `PLATFORM_SANDBOX=1` and the repository's
   tooling honors it, drop any mesh-less flag (e.g. ` -- --no-mesh`) from
   `cluster_install` in `work/CONFIG.md` — confirm with the operator first.

## 1.1.1 — 2026-10-01

A new rule in `CLAUDE.md` → **Rules**: at most three worktrees beside the
checkout, each removed once its pull request is merged or closed.

**Upgrade:**

1. List the checkout's worktrees (`git -C "$HOME/work/<name>" worktree list`)
   and remove each whose pull request is merged or closed, with
   `git worktree remove` — never `--force` on one with uncommitted changes;
   ask the operator about those.

## 1.1.0 — 2026-10-01

Pull requests are babysat to approved and green (`docs/babysit.md`); the
precheck now also wakes a run for any new review and for newly failed checks.
The kit requires addressed credential injection (`requireConnectionAddress` in
`kit.yaml`).

**Upgrade:**

1. **Operator only:** turn on *Inject only into addressed requests* in this
   agent's settings (needs a platform that has it). `kit.yaml` is read only at
   create, so an existing agent does not get it otherwise. Saving restarts the
   agent's gateway.
2. Run `bash "$HOME/scripts/verify-onboarding.sh" --live` and apply every fix.

## 1.0.0 — 2026-09-24

The first versioned release. An instance created before it has no version of
its own; it crosses into this one from whatever its kit created.

**Upgrade:**

1. Replace the tick's schedule. Delete `developer-tick`, then create
   `software-developer-tick-10m` with the cron, `sessionMode: fresh`, precheck
   and task from `kit.yaml`. A schedule's session mode cannot change in place,
   and the old one left behind would keep firing beside the new.
2. Create `software-developer-audit-weekly` from `kit.yaml`.
3. Bring `work/` to onboarding's shape (`ONBOARDING.md` → 3. Write it down):
   seed `work/AGENTS.md`; add to `work/CONFIG.md` whichever of `app_url` (ask
   the operator), `verify`, `cluster` (with `cluster_install`,
   `cluster_uninstall` and `cluster_delete` when it is `required`) and
   `stuck_after_min` are missing; and move what you must never touch under a
   `## Bounds` heading, as plain sentences.
4. Give each of your open pull requests a `Fixes #<n>` line for its issue. The
   precheck now pairs claimed issues with pull requests through that line, and
   lists every claimed issue without one as abandoned work.
5. `head -1 "$HOME/VERSION" > "$HOME/work/VERSION"`, then run
   `bash "$HOME/scripts/verify-onboarding.sh" --live` and apply every fix it
   names.
6. Nothing to seed for `work/RUN.md`, `GATE.md` or `TICK.log` — the first claim
   creates them.
