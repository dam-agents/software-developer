# software-developer

A DAM [starter kit](https://github.com/dam-agents/dam/blob/main/docs/architecture/starter-kits.md):
an agent that takes an issue labelled for implementation, writes the change,
runs the repository's own checks against a cluster in its sandbox, and drives
the pull request through review.

- [`kit.yaml`](kit.yaml) — what the platform creates: the connection it needs,
  its size, its schedule, and the sandbox it runs in.
- [`CLAUDE.md`](CLAUDE.md) — what the agent does on every run.
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
