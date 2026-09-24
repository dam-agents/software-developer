# The cluster

`IS_SANDBOX` is already set for you, so the repository's own cluster tasks drive
the k3s running here instead of looking for a VM manager.

Two different things can be wrong, and they have different fixes.

- **No cluster.** Just run the install command: it creates the cluster when
  there is none, then installs the platform onto it. k3s stops whenever the
  sandbox restarts, which is normal and needs no investigating.
- **Diverged platform install.** A failed migration, a conflicting CRD, state
  that no longer matches the branch: run the uninstall command and then the
  install command from `work/CONFIG.md`. That pair only touches what the chart
  put there and leaves k3s alone, which is why it is safe to reach for. Never
  hand-patch a diverged install — it is cheaper to rebuild than to reason
  about, and a half-fixed one gives you a test result you cannot trust.
- **Wedged cluster.** Rare, and only when the uninstall/install pair cannot fix
  it: delete the cluster, then install — which builds it back. You lose every
  cached image with it, so try the pair first.
- **Switching branches means rebuilding.** You may have several pull requests
  open, but the cluster serves the branch you are verifying right now.

The platform describes this sandbox in `/etc/AGENTS.md` — what is installed,
what persists, how to start the container runtime. Read it rather than
duplicating it here.
