# Agent entry point

This repository is an **agent definition**, not an application. Read
**[`CLAUDE.md`](CLAUDE.md)** first, under any harness: it names what a scheduled
run does, in what order, and the rules that hold for all of them.

Reading order:

1. **[`CLAUDE.md`](CLAUDE.md)** — always, before anything else.
2. **`work/CONFIG.md`** — the repository, labels and commands this instance was
   set up with. Written during onboarding; never guessed.
3. **[`ONBOARDING.md`](ONBOARDING.md)** — only on a fresh instance with no
   `$HOME/.software-developer-onboarded` marker.

`/etc/AGENTS.md`, which the platform ships in the image, describes the sandbox
itself — what is installed, what survives a restart, how to start the cluster
and the container runtime. It is not repeated here.

This file is a pointer, not a copy: nothing here overrides `CLAUDE.md`.
