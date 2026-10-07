# software-developer

A DAM [starter kit](https://github.com/dam-agents/dam/blob/main/docs/architecture/starter-kits.md):
an agent that takes an issue labelled for implementation, writes the change,
runs the repository's own checks in its sandbox, and drives the pull request
through review.

- [`kit.yaml`](kit.yaml) — what the platform creates: the connection it needs,
  its size, its schedule, and the sandbox it runs in.
- [`CLAUDE.md`](CLAUDE.md) — what the agent does on every run, and what it
  never does.
- [`docs/`](docs/) — the procedures `CLAUDE.md` sends it to when they apply.
- [`ONBOARDING.md`](ONBOARDING.md) — the first conversation, which asks the user
  what only they can answer.
- [`scripts/precheck.sh`](scripts/precheck.sh) — decides whether a run is worth
  waking the agent for, before any model is involved, and holds an occurrence
  back while the run before it is still working.
- [`scripts/run-state.sh`](scripts/run-state.sh) — which run works on which
  issue, in which slot, and who holds the exclusive lock; how a dead run's slot is
  found and freed ([`docs/runs.md`](docs/runs.md)).
- [`scripts/session-link.sh`](scripts/session-link.sh) — the link back to the
  run that wrote a change, which every pull request carries.
- [`scripts/work-backup.sh`](scripts/work-backup.sh) — backs `work/` up to a
  private repository of its own, and restores it on a fresh volume.
- [`scripts/harness/claude-code/`](scripts/harness/claude-code/) — the `Stop`
  hook that keeps a run from ending its turn while it still holds an issue,
  and the installer that registers it and links the skills: the bundled ones,
  and the repository's own at `work/.claude/skills`.
- [`scripts/verify-onboarding.sh`](scripts/verify-onboarding.sh) — checks an
  instance has the shape onboarding promises; every failure names its fix.
- [`scripts/audit.sh`](scripts/audit.sh) — the deterministic half of the
  weekly audit.
- [`scripts/tests/`](scripts/tests/) — offline tests for all of the above:
  `bash scripts/tests/run.sh`. CI runs them, and
  [`scripts/validate-definition.sh`](scripts/validate-definition.sh), on every
  pull request.

**Nothing here names a repository.** Which one to work on, which labels mean
what, and how to build and test it are asked during onboarding and recorded in
`work/CONFIG.md` on the instance; nor any tool: how a repository is set up,
tried out and recovered is that repository's own to document — its
`CLAUDE.md`, skills or contributing guide — and the agent follows it.

**Autonomous or interactive.** Onboarding asks first whether the agent
watches GitHub — implementing what carries the hand-off label and babysitting
its pull requests, unattended — or works only when you ask it in a chat, as a
developer you pair with (`mode` in `work/CONFIG.md`,
[`docs/direct-session.md`](docs/direct-session.md)). Interactive needs no
schedule and only the labels of a claim. Autonomous, both schedules are still
optional: onboarding asks whether to watch the hand-off label and whether to
run the weekly audit.

## The GitHub connection

The agent acts as whoever the connection belongs to, with everything that
account can reach. **Scope it to the repository the agent works on and nothing
else** — a GitHub App installed on that one repository, or a fine-grained token
limited to it — with read and write on contents, pull requests and issues. The
agent is told never to act on another repository; a connection that cannot is
what keeps that true when an issue body tries to talk it into one. The one
addition is the backup repository, when there is one: write on its contents.

Use a machine account rather than your own: otherwise the pull requests it
opens are indistinguishable from yours.

## Slack

Optional. Bind a channel to the agent in its settings and set `slack_channel`,
and it posts the moments a person acts on there — ready to merge, needs info,
blocked, the weekly audit ([`docs/notify.md`](docs/notify.md)).

It also grills there: open `let's grill <n>` in the channel, answer its
questions in the thread, and approve the breakdown; it files the sub-issues
under #`<n>` with the hand-off label, and the tick implements them
([`docs/grill.md`](docs/grill.md)). Anyone in the channel can grill, so bind
one only trusted people are in. The questions and drafts follow the
repository's own skills when `skill_grill` and `skill_file_issue` name them,
and the definition's defaults in `.agents/defaults/` otherwise.

## What it keeps on the instance

All under `work/`, none of it tracked here:

| File | Written by | Holds |
| --- | --- | --- |
| `CONFIG.md` | onboarding | the repository, labels, commands and bounds |
| `AGENTS.md`, `VERSION` | onboarding | a pointer to `CLAUDE.md`; the definition version this instance adopted |
| `items/<n>.md` | `scripts/run-state.sh` | per issue: branch, slot, state, when a run last started on it |
| `slots/<k>/` | `scripts/run-state.sh` | the worktrees runs work in, kept warm between runs |
| `also/<name>/<k>/` | `scripts/run-state.sh` | the same, of a repository `repos_also` names |
| `GATE.md` | the precheck, via `run-state.sh` | when it last let a diagnostic run through |
| `TICK.log` | `scripts/run-state.sh` | one line per closed run, append-only |
| `AUDIT.log` | the weekly audit | one line per audit: ok, warn and fail counts |

`CONFIG.md`, `AGENTS.md`, `VERSION` and the two logs are backed up to a
private repository of their own when `work_repo` names one; the rest is
rebuilt from GitHub — [`docs/persistence.md`](docs/persistence.md). The locks
live on tmpfs, outside `work/`, and a restart frees them.
