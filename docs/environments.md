# An issue's own Environment

When `verify_environment` or `demo_environment` in `work/CONFIG.md` names a
command, an issue gets a platform Environment of its own, `issue-<n>`. One per
issue, whichever keys are set: the install is paid once, and one Environment
serves both uses.

- **`demo_environment`** installs the branch into it, for a person to try the
  change and for its screenshots. It is no check: nothing it does holds a pull
  request back from review. Made only for a change a person can see in the
  running app — the UI, or behavior the UI shows — or one labelled
  `label_ui_review`, and only when it can be shown there **for real**: the
  install holds a working example of what the change is about, made through
  the app as a person would make it — the objects it lists, the state it
  shows — so the link opens on the change itself. A demo that needs its data
  faked in the page (the install cannot make it: a service it lacks, an
  Environment inside an Environment) is no demo: make none, or delete the one
  made for it, and say in one line of the body why there is none.
  Screenshots taken some other way are marked as such where they stand.
- **`verify_environment`** is the check a pull request must pass, run there
  instead of on something every slot shares, so it runs beside the other
  slots' with no lock, and `exclusive` stays out unless something else is still
  shared ([exclusive.md](exclusive.md)). With both set, it runs against the
  install `demo_environment` made — write it to skip its own install — and
  the same Environment is then the demo.

## Its life

- **One per issue, named `issue-<n>`**, made on the issue's first use and kept until its pull request is merged or closed. It
  belongs to the issue, not to the slot: a run in any slot reuses it, and a
  freed slot leaves it running for the reviewer. What the last run left is the
  last push's, and the command sets it up for yours.
- **Made on first use**, after `run-state.sh room`: it says to reuse it, to
  make it (`create_environment`, with the endpoints the repository's
  instructions name for this, and `expires` at the platform's default), or what
  to delete first (**At the limit**, below). How a check runs in one is the
  repository's to document, as the exclusive's setup is.
- **Run it** in the slot, in the background like `verify`, `{environment}`
  replaced by the name: `$RS phase "demo_environment"` and its command, then
  `$RS phase "verify_environment"` and that one, then `run-state.sh checked
  verify_environment <result> [cause]`. A demo alone is made once the pull
  request is ready for review, never before it; one that fails to install, or
  finds no room, is one line in the body, and a later round tries again.
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
  scripts find whose it is. For a demo, they open a `## Demo` section that
  also holds screenshots taken in it and two to four steps to try the change
  there — how to sign in, where the example is — that work for a person who
  opens the link cold; a round that changes what a person sees takes them
  again. Opening it takes the owner's access list, as the
  session link does: the address is the one internal host a body may carry.
- **Kept alive while the pull request waits**: each round moves its expiry on
  with `update_environment` (`expires` at the platform's default), so it never
  lapses under a reviewer.
- **Deleted when its pull request is done** — merged or closed: before
  `finish released`, `delete_environment issue-<n>`. The weekly audit names
  any Environment whose issue has no open pull request left.
- **It sleeps** after the platform's idle time, keeping its disk, and wakes on
  the next use; while a command holds its link open, neither machine sleeps.
- **Refused** — a container agent, Environments off: report it on the issue and
  finish `blocked`, as for any tool you are refused. Refused for the limit
  after `room` said there was room: run `room` again.

## At the limit

The platform lets the agent hold `environments_max` (default 5: the install's
setting, which the agent cannot change), and every Environment counts. With all
held, `room` names the one cheapest to take back, oldest first within each:

1. one **no open pull request links**: its pull request is done;
2. a **draft no run holds** — blocked, held back, set aside: `room` on resume
   makes it anew, at the cost of one setup;
3. an **approved pull request's that needs no review in it**: not labelled
   `label_ui_review`;
4. an **approved one's whose review is done**, labelled `label_ui_review`.

Without `label_ui_review`, every pull request counts as one a person reviews
in its Environment. Never taken: one a run works on now, a parked draft's, a
ready pull request's still in review. Delete it, say so on its pull request in
one line, and make yours; a later round there makes it again.

**None to take back, for a demo alone** (no `verify_environment`): the pull
request goes without one — one line in its body says so — and a later round
runs `room` again. **With `verify_environment`:** `room` marks the item `waiting-env` and prints what
frees one — each pull request holding an Environment, to review or to merge.
Push, say on the issue it waits for an Environment, and finish `waiting-env`;
the precheck lists it again once one is free. With `slack_channel` set, `room`
says to post that list ([notify.md](notify.md)), once a day while the same pull
requests hold them.
