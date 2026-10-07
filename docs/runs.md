# Runs, slots and the exclusive lock

Read this when `run-state.sh` refuses you, when a slot holds something you did
not expect, or when the precheck says a run died. The script is the one writer
of this state; this page says what it does, so you can tell what it told you.

## Runs side by side

Each tick starts a fresh session whenever the precheck finds work and a free
slot, so up to `slots` runs (default 3) work at once, one item each. Nothing
queues them: the platform runs fresh sessions concurrently. What keeps them
apart is three kinds of lock, taken atomically on tmpfs:

| Lock | Taken by | Held for |
| --- | --- | --- |
| item `<n>` | `start <n>` | the run — no two runs on one issue |
| slot `<k>` | `start <n>` | the run — one worktree, one run |
| exclusive | `lock` | the steps on what `exclusive` names; `unlock` or `finish` gives it back |

An item is held until its pull request is done, not until it is opened: the run
that opens it babysits it with `run-state.sh wait <pr>`
([babysit.md](babysit.md)), and that is why it keeps its slot meanwhile.

**A lock never outlives the turn that took it.** A holder is dead when the
runtime says its session is not running a turn, or when the sandbox restarted
since it was taken (a restart wipes tmpfs, and stops what ran in the sandbox). The
precheck sweeps dead holders before every tick. A runtime that does not answer
frees nothing: a guess could hand a live run's slot to another.

## Slots

`work/slots/<k>` are worktrees of the checkout, created on first use and never
removed: what they keep is the build output, so the next item does not rebuild
from nothing. `start` puts its slot on the item's branch — the remote's tip
when there is one, else new from the default branch — and `git clean -fd`
removes untracked files there, never ignored ones. It prefers the slot the item
last used. `finish` detaches a saved slot, so the branch is free for any slot
next time.

**`start` takes only what is ours.** Before any lock or slot, it reads the
item on GitHub and exits `1` when another agent has it: a claim without
`label_mine` (when set), or an open pull request naming the issue that is not
ours — another author's, or without `label_mine`. A `pr<n>` item must be ours
the same way. GitHub unreadable, it refuses too. Leave such an
item untouched — no comment — and take the next.

**`start` never throws work away.** It exits `3`, and keeps the locks, when:

- the slot holds uncommitted changes or commits no remote has — a run that died
  before pushing. In that slot, commit and push them to their branch; when that
  branch is not the item you came for, push to `wip/<issue>` and say so on that
  issue. Then `start` again.
- your branch has local commits not on origin, or is checked out in a slot
  that is in use or unsaved: save or push them the same way.

A build that passes on a warm slot can fail from nothing. CI builds from
nothing, so that shows on the pull request; when it does, `git clean -fdx` in
your slot and build again before believing either result.

## Items

`work/items/<n>.md` is a cache the script keeps per issue: its branch, last
slot, pull request, state, when a run last started on it (`seen_at`), and how
often a run died on it (`abandoned`). It is local to this sandbox and never
pushed — not to `repo`, not to the backup. What is true lives in the labels,
branches and pull requests on GitHub; a missing or deleted file costs nothing
but a warm slot. The precheck uses it to

- wake a pull request only for a review or failed check newer than `seen_at`,
  whichever run looked at it last;
- list an item `waiting-lock` once the lock is free;
- say how often a run died on a claimed issue — the second time, release it.

## The exclusive lock

What `exclusive` names serves every slot, and anything that touches it —
setting it up, trying a change out, a suite run against it — changes what
every other branch would see. So: `verify` first, in your slot, without the
lock; then `run-state.sh lock`.

- **Granted:** do what needs it at once — `verify_exclusive`, and whatever
  trying the change out takes — then `run-state.sh unlock`. Told the last
  holder died mid-use: bring it back to a known state first
  ([exclusive.md](exclusive.md)).
- **In the direct session** too: a command on it run by hand, outside the
  lock, lands under some run's suite.
- **Refused:** another item holds it. Commit and push what you have, and
  finish `waiting-lock`. Do not wait in the turn: a later run picks the item
  up as soon as the lock is free.

## Reports

Nobody reads a scheduled run's turn, so every run ends with its outcome on
GitHub, and `finish` checks that it is there before it gives the item back.
It reads, never writes:

- **Every outcome:** nothing unpushed in the slot.
- **`pr-opened`:** the pull request is open, opened by `author`, says
  `Fixes #<n>`, carries this run's session link, and `label_mine` when set.
- **Every other outcome:** a comment by `author` on the issue or its pull
  request, written or edited since this run started, carrying this run's
  session id — the link from `session-link.sh` does; without `app_url`, write
  `Session <id>`.
- **`needs-info`, `blocked`, `released`:** the claim is off the issue — the
  claimed label, and `label_mine` when set;
  `needs-info` carries `label_needs_info`, `blocked` the failed label.

Refused, it says what is missing: post it, then `finish` again. GitHub that
cannot be read does not keep the run open: it closes, and its `TICK.log` line
says `report=unverified`.

**A report says what a person needs, in a few lines:** what this run did, where
the item stands, what happens next and who acts — the agent on its next run, a
reviewer, the issue's author. A pull request's own round comment
([babysit.md](babysit.md)) is that report. For outcomes that have nothing else
to post — `waiting-lock`, `nothing`, a resumed run's progress — keep one
status comment per issue and edit it in place rather than adding a new one:
its first line `<!-- software-developer:status -->`, then the state and this
run's link.

## A dead run

The precheck names the item a dead run left, and lists it again. Its slot keeps
whatever it wrote; its branch has whatever it pushed. Resume from there: that
is why every run pushes before it finishes, and why `start` refuses to switch
a slot holding unsaved work.

Every slot held and none of the holders showing a sign of life — no phase
stamp, no transcript write — for `stuck_after_min` lets a diagnostic run
through ([diagnostic-run.md](diagnostic-run.md)).
