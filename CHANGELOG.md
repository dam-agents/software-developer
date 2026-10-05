# Changelog

**Migration instructions, not a change log.** Per version, the idempotent
**Upgrade** steps a deployed instance applies when it crosses that version —
what to run, update or change: schedules, config keys, state formats. Most
versions need nothing. What changed and why lives in the pull requests.

Applying the kit never touches an agent already created from it, so an instance
crosses a version only when its operator walks it through these steps, in the
direct session.

## 3.1.1 — 2026-10-05

**Approved ends the review.** A review on an approved pull request — the
suggestions in the approving review, or one that comes after it — no longer
starts another round: `run-state.sh wait` says done once it is approved, green
and mergeable, and only a failed check or a conflict brings a run back to it
(`docs/babysit.md`). The precheck never wakes a run for an approved pull
request, whatever lands on it after: it waits for the person who merges.

**Upgrade:** nothing.

## 3.1.0 — 2026-10-05

**Grilling in Slack.** With `slack_channel` set, `let's grill <n>` in that
channel starts a grill of issue #`<n>`: one question per reply in the thread,
each with a recommended answer, until the decisions are made. Then a breakdown
into sub-issues, and once the thread plainly approves it, they are filed under
#`<n>` with the hand-off label, and the decisions go on #`<n>`. Anyone in the
channel may grill. A grill thread is the one work order besides the hand-off
label (`CLAUDE.md` → **Trust boundary**). It may only read, ask, and file what
it approved: no code, no other label, no other repository (`docs/grill.md`).

The questions and drafts follow the repository's own skills when
`skill_grill` and `skill_file_issue` name them. Otherwise they follow the
definition's defaults in `.agents/defaults/`, which are kept out of
`.agents/skills` so that they never shadow the repository's skills.

**Upgrade:**

1. With `slack_channel` set, grilling is on from now on. Tell the operator,
   and check that only trusted people are in the channel.
2. Optional, with the operator: look in `work/.claude/skills` for the
   repository's own grill and issue-filing skills, and name them
   (`- skill_grill: <dir>`, `- skill_file_issue: <dir>`).
3. `bash "$HOME/scripts/verify-onboarding.sh" --live`.

## 3.0.0 — 2026-10-05

The definition serves any repository, and assumes no cluster, platform or
tool. The cluster became **the exclusive lock**: `exclusive` names, in plain
words, whatever every slot shares and one uses at a time — a cluster, a
database, a device — and every use of it takes the lock, trying a change out
as much as testing it. `verify_exclusive` is the check on it a pull request
must pass. How to set it up, try it and recover it is the repository's to
document; the definition no longer knows. `run-state.sh cluster` and
`cluster-done` are `lock` and `unlock`, the outcome `waiting-cluster` is
`waiting-lock`, and `docs/cluster.md` is `docs/exclusive.md`. `label_review`
is optional. Both schedules are optional: `schedules` lists the ones the
operator wants, onboarding asks, and the audit checks them against it.

**Upgrade:**

1. Wait until no run is in flight (`list_schedules` shows the tick idle, or
   pause it): a run still on 2.x calls `run-state.sh cluster`, which is gone.
2. In `work/CONFIG.md`, with the operator: with `cluster: required`, write
   `- exclusive: <what is shared, in plain words>`, and `verify_cluster` as
   `verify_exclusive`, preceded by the setup from `cluster_install` when it
   does not set itself up. Then delete `cluster`, `cluster_install`,
   `cluster_uninstall`, `cluster_delete` and `verify_cluster` — and rewrite
   any `## Bounds` sentence that names one of them with the command itself.
   What those commands knew and the repository does not document — how to
   recover it — is a change to suggest for the repository's own
   instructions; **operator only**, unless they hand it over as an issue.
3. Ask the operator which schedules to keep. Write
   `- schedules: <tick audit | tick | audit | none>`, and with
   `toggle_schedule` switch each one to match (`list_schedules` first).
4. `bash "$HOME/scripts/work-backup.sh" persist`, then re-run
   `bash "$HOME/scripts/verify-onboarding.sh" --live`: it fails a retired key
   and checks `exclusive`, `verify_exclusive` and `schedules`. Item files
   still saying `waiting-cluster` are read as `waiting-lock`; leave them.

## 2.4.0 — 2026-10-05

Slack posts, off by default: with the new, optional `slack_channel` set, a run
posts the moments a person acts on — a pull request ready to merge, an issue
that needs info, a blocked one — and the weekly audit its summary
(`docs/notify.md`). `finish` says when to post; the post comes after it and
never holds a run open. Missing, nothing changes.

**Upgrade:**

1. Offer Slack posts to the operator. Only for a yes, and only when
   `describe_channel` for `slack` lists chats: add `- slack_channel: <chat id>`
   to `work/CONFIG.md`, then `bash "$HOME/scripts/work-backup.sh" persist`.
   No Slack connected: **operator only** — bind a channel in the agent's
   settings first.
2. Re-run `bash "$HOME/scripts/verify-onboarding.sh" --live`: it now checks
   `config.slack_channel`.

## 2.3.0 — 2026-10-02

GitHub reads spend less of the API budget, and survive GraphQL's running out:
an app installation's hourly GraphQL budget is shared by every agent on it, and
once spent, the precheck failed every tick. The precheck now reads its whole
list in one GraphQL request, and over REST, a budget of its own, when GraphQL
refuses — saying so in the list it hands the run. `run-state.sh wait` reads the
pull request with conditional REST requests, free while nothing changed, and
spends a GraphQL read only on a change; with GraphQL refused it decides from
REST alone, but never that a pull request is done. The shared reads live in the
new `scripts/lib/github.sh`.

**Upgrade:** none.

## 2.2.0 — 2026-10-02

An `author` other agents share — a GitHub App's bot — no longer makes their
pull requests read as yours: with the new, optional `label_mine` set, every pull
request this agent opens carries that label, and the precheck, the audit and
`finish pr-opened` count only those. Missing, nothing changes. Logins now
compare in any of GitHub's spellings (`name[bot]`, `app/name`, any case), and
`verify-onboarding.sh --live` reports an app identity's login and permissions
as not measured instead of failing them.

**Upgrade:**

1. Only if `author` is an identity other agents act as too: agree a label with
   the operator, create it on `repo` (operator-only if the connection cannot),
   add `- label_mine: <label>` to `work/CONFIG.md`, and put the label on every
   open pull request of `author` that is this agent's (its body carries
   `Written by this agent`). Then
   `bash "$HOME/scripts/work-backup.sh" persist`.
2. Re-run `bash "$HOME/scripts/verify-onboarding.sh" --live`: it now checks
   `live.label_mine`, and `live.mine` for an app.

## 2.1.0 — 2026-10-02

The repository's own skills load in every run: onboarding links
`work/.claude/skills` to the checkout's skills, because a run works from
`work/` and Claude Code loads project skills from there alone. The checkout
itself is kept on its default branch, fast-forwarded by `run-state.sh start`,
so the linked skills stay current. A step of theirs that waits for a person
goes through GitHub instead.

The run that opens a pull request now babysits it in its own turn until it is
approved, green and mergeable, or cannot be: `run-state.sh wait <pr>` blocks up
to nine minutes at a time for the next thing to do, and `finish` refuses
`pr-opened`, `pr-updated` and `nothing` until then. The item stays held, so no
new tick takes it. A run gives it up after `babysit_max_hours` (default 4);
the precheck's new-run babysitting remains for that, and for runs that died.

**Upgrade:**

1. Add `- babysit_max_hours: 4` to `work/CONFIG.md` (or leave it out for the
   default), and run `bash "$HOME/scripts/harness/claude-code/install.sh"`;
   show the operator the skills it linked.
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
