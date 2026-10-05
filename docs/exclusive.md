# The exclusive lock

Only when `exclusive` in `work/CONFIG.md` names something: what every slot
shares and only one may use at a time — a cluster, a database, a device, a
port. The definition knows nothing more about it than that.

**Everything that touches it runs under `run-state.sh lock`**, which one item
holds at a time ([runs.md](runs.md) → **The exclusive lock**): trying a change
out on it, debugging on it, and `verify_exclusive`, the check on it a pull
request must pass. A command that installs or resets it replaces what another
slot put there.

**How to set it up, try a change out on it, and recover it is the
repository's**, in its own instructions — its `CLAUDE.md`, its skills, its
contributing guide — and in what `## Bounds` says. Follow them; where they say
nothing, rebuilding from the repository's own setup beats hand-patching a
broken state, which gives you a result you cannot trust.

**Every holder starts from its own branch.** What the last holder left is not
yours: set it up for your branch before you use it, and when `lock` says the
last holder died mid-use, bring it back to a known state first.

The platform describes this sandbox in `/etc/AGENTS.md` — what is installed,
what persists across a restart, how to start the container runtime. Read it
rather than duplicating it here.
