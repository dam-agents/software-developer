# The cluster

Only when `cluster: required` in `work/CONFIG.md`; the three commands below are
its `cluster_install`, `cluster_uninstall` and `cluster_delete`, and
`verify_cluster` is what runs on it.

**Every one of them runs under `run-state.sh cluster`**, which one item holds
at a time ([runs.md](runs.md) → **The cluster**). One cluster serves every
slot, and an install or an end-to-end suite replaces what is on it — a test
run's install over another branch's, its data reset under another's suite.

`IS_SANDBOX` is already set for you, so the repository's own cluster tasks drive
the k3s running here instead of looking for a VM manager.

Three different things can be wrong, and they have different fixes.

- **No cluster.** Just run `cluster_install`: it creates the cluster when there
  is none, then installs the platform onto it. k3s stops whenever the sandbox
  restarts, which is normal and needs no investigating.
- **Diverged platform install.** A failed migration, a conflicting CRD, state
  that no longer matches the branch: run `cluster_uninstall`, then
  `cluster_install`. That pair only touches what the chart put there and leaves
  k3s alone, which is why it is safe to reach for. Never hand-patch a diverged
  install — it is cheaper to rebuild than to reason about, and a half-fixed one
  gives you a test result you cannot trust.
- **Wedged cluster.** Rare, and only when the pair cannot fix it:
  `cluster_delete`, then `cluster_install`, which builds it back. You lose
  every cached image with it, so try the pair first.

**Every holder installs its own branch.** What the last holder left there is
not yours: install before you run `verify_cluster`, and when you are told the
last holder died mid-use, `cluster_uninstall` first.

The platform describes this sandbox in `/etc/AGENTS.md` — what is installed,
what persists, how to start the container runtime. Read it rather than
duplicating it here.
