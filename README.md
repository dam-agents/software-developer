# software-developer

A DAM [starter kit](https://github.com/dam-agents/dam/blob/main/docs/architecture/starter-kits.md):
an agent that takes an issue labelled for implementation, writes the change,
runs the repository's own checks against a cluster in its sandbox, and drives
the pull request through review.

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
- [`scripts/run-state.sh`](scripts/run-state.sh) — the record of the run in
  flight (`work/RUN.md`), which is how the next tick tells a run still working
  from one that died.
- [`scripts/session-link.sh`](scripts/session-link.sh) — the link back to the
  run that wrote a change, which every pull request carries.
- [`scripts/tests/`](scripts/tests/) — offline tests for all of the above:
  `bash scripts/tests/run.sh`.

**Nothing here names a repository.** Which one to work on, which labels mean
what, and how to build and test it are asked during onboarding and recorded in
`work/CONFIG.md` on the instance. The kit was written for the platform's own
development and its suggested labels come from there, but it is not built
around it.

## The GitHub connection

The agent acts as whoever the connection belongs to, with everything that
account can reach. **Scope it to the repository the agent works on and nothing
else** — a GitHub App installed on that one repository, or a fine-grained token
limited to it — with read and write on contents, pull requests and issues. The
agent is told never to act on another repository; a connection that cannot is
what keeps that true when an issue body tries to talk it into one.

Use a machine account rather than your own: otherwise the pull requests it
opens are indistinguishable from yours.

## What it keeps on the instance

All under `work/`, none of it tracked here:

| File | Written by | Holds |
| --- | --- | --- |
| `CONFIG.md` | onboarding | the repository, labels, commands and bounds |
| `RUN.md` | `scripts/run-state.sh` | the run in flight: its session, phase and since when |
| `GATE.md` | the precheck, via `run-state.sh` | how long the sandbox has read busy, and the last diagnostic run |
| `TICK.log` | `scripts/run-state.sh` | one line per closed run, append-only |
