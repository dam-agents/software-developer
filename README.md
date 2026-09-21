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

The repository it works on is not fixed here. It is asked for during onboarding
and recorded in `work/CONFIG.md` on the instance, with `dam-agents/dam` as the
default.
