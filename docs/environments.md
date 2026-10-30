# An issue's own Environment

Only when `verify_environment` in `work/CONFIG.md` names a command: the check
a pull request must pass, run in a platform Environment of the issue's own
instead of on something every slot shares. Each issue has its own, so the check
runs beside the other slots' with no lock, and `exclusive` stays out unless
something else is still shared ([exclusive.md](exclusive.md)).

- **One per issue, named `issue-<n>`**, made on the issue's first
  `verify_environment` and kept until its pull request is merged or closed. It
  belongs to the issue, not to the slot: a run in any slot reuses it, and a
  freed slot leaves it running for the reviewer. What the last run left is the
  last push's, and the command sets it up for yours.
- **Made on first use.** `list_environments` first; missing, make it with
  `create_environment`, with the endpoints the repository's instructions name
  for this, and `expires` at the platform's default. How a check runs in one is
  the repository's to document, as the exclusive's setup is.
- **Run it** in the slot, in the background like `verify`: `$RS phase
  "verify_environment"`, then the command with `{environment}` replaced by the
  name, then `run-state.sh checked verify_environment <result> [cause]`.
- **Set up once, then narrow.** Its setup — building and installing into the
  Environment — is paid once per push, not per attempt: while you hunt a
  failure, rerun only the failing test against the warm Environment, or
  reproduce it by hand in it and read its logs with timestamps. The whole
  command runs once more, last, on the final commit, and that run is the one
  `checked` records. A setup that fails is fixed before anything reruns.
  Where the repository's own tooling can do less — install only what changed,
  skip an install that is already current, run one test or one file, rebuild
  one component — use it, as its skills and task help say: never deploy the
  same commit twice, and never rebuild what did not change.
- **Linked from its pull request.** The body carries, on lines of their own,
  `Environment: <its first endpoint's address>` and
  `<!-- environment: issue-<n> -->`, so a reviewer opens the change and the
  scripts find whose it is. Opening it takes the owner's access list, as the
  session link does: the address is the one internal host a body may carry.
- **Kept alive while the pull request waits**: each round moves its expiry on
  with `update_environment` (`expires` at the platform's default), so it never
  lapses under a reviewer.
- **Deleted when its pull request is done** — merged or closed: before
  `finish released`, `delete_environment issue-<n>`. The weekly audit names
  any Environment whose issue has no open pull request left.
- **The agent's limit reached:** delete the Environment of the oldest pull
  request of yours that is approved, say so on that pull request in one line,
  and make yours. None approved: report it on the issue and finish `blocked`.
- **It sleeps** after the platform's idle time, keeping its disk, and wakes on
  the next use; while a command holds its link open, neither machine sleeps.
- **Refused** — a container agent, Environments off: report it on the issue and
  finish `blocked`, as for any tool you are refused.
