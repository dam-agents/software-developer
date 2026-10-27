# A slot's own Environment

Only when `verify_environment` in `work/CONFIG.md` names a command: the check
a pull request must pass, run in a platform Environment of the slot's own
instead of on something every slot shares. Each slot has its own, so the check
runs beside the other slots' with no lock, and `exclusive` stays out unless
something else is still shared ([exclusive.md](exclusive.md)).

- **One per slot, named `slot-<n>`**, the slot `run-state.sh start` printed.
  Like the slot, it is a warm cache: what the last run left is the last
  branch's, and the command sets it up for yours.
- **Made on first use, reused after.** `list_environments` first; missing, or
  gone at its expiry, make it with `create_environment`, with the endpoints the
  repository's instructions name for this, and `expires` at the platform's
  default. Which endpoints, and how a check runs in one, is the repository's to
  document, as the exclusive's setup is.
- **Run it** in the slot, in the background like `verify`: `$RS phase
  "verify_environment"`, then the command with `{environment}` replaced by the
  name.
- **It sleeps** after the platform's idle time, keeping its disk, and wakes on
  the next use; while a command holds its link open, neither machine sleeps.
- **Refused** — a container agent, Environments off, or the agent's limit
  reached (`slots` above it): report it on the issue and finish `blocked`, as
  for any tool you are refused.
- **On GitHub, its name and what ran**, never its address: an Environment's
  address is an internal host.
