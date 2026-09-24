# Changelog

**Migration instructions, not a change log.** Per version, the idempotent
**Upgrade** steps a deployed instance applies when it crosses that version —
what to run, update or change: schedules, config keys, state formats. Most
versions need nothing. What changed and why lives in the pull requests.

Applying the kit never touches an agent already created from it, so an instance
crosses a version only when its operator walks it through these steps, in the
direct session.

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
