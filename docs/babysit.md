# Babysitting a pull request

Read this whenever you open a pull request or work on one of yours. A pull
request is not done when it is opened, nor when it is approved: you carry it
until it is **merged** — a person merges it — or closed.

## Held, then parked

The session that wrote the change carries it to the merge, so the context that
wrote it is the one that answers its review. It holds the item the whole way;
what it holds besides changes with whose move it is:

| | Whose move | Holds | The turn |
| --- | --- | --- | --- |
| **Held** | yours: writing, checking, a review round | the item, a slot, the exclusive lock while you use it | runs; the Stop hook keeps it going |
| **Parked** | a person's: a review, a merge | the item alone | ends, nothing running; the precheck wakes the session |

**Park** once the round is pushed and reported and a person moves next:

```sh
bash "$HOME/scripts/run-state.sh" park <pr>...
```

`park` refuses until the slot is pushed and this round's comment is on the pull
request, like `finish`. Then it gives the slot and the exclusive lock back —
nothing shared waits on a person — and marks the item `in-review`, or
`awaiting-merge` once every pull request is approved. End the turn with
nothing left running: the Stop hook lets a parked turn end.

**The precheck watches it.** Every tick it reads your open pull requests anyway,
at no model cost; for a parked item it looks for what came after your last
round: a review, **a person's comment** in the conversation, a failed check, a
conflict, or the merge. One of them **messages the session** — a turn there, none in the
tick — with what landed: `start` the item again — it takes a slot, back to
Held — and handle it, in the next section. Asked once: not back within fifteen
minutes, or the message not queued, **a later run takes it over** — the
precheck lists it like a run that stopped, and a fresh session babysits it from
the branch and the pull request. Every slot in use, `start` says so and the item
stays parked, watched: end the turn, and the precheck asks again once a slot
frees. A restart loses nothing: no process waits in the sandbox. **A person
typing in the session** wakes it the same way: `start` the item. `TICK.log`
says which happened — `messaged`, then `resumed … cause=precheck|operator`, or
`cause=fresh prev=<session>` — and the weekly audit counts them.

**Without a tick to watch it** — the direct session, a Slack session, or
`schedules` without `tick` — `park` says to start its **waiter**, `run-state.sh
wait --park`, as the harness's own background task (Claude Code:
`run_in_background`, `timeout` two hours), then end the turn. It looks at the
pull requests once a minute — an unchanged one costs nothing
(`app/src/factory/github.ts`) — for up to two hours, wakes the session for the
same events, and exits `3` after two hours of nothing: start it again. A
restart kills it: in the direct session book a wake-up too —
`schedule_once` with `inSession: "continue"`, a little over two hours ahead,
then `run-state.sh booked <its time> <its id>` — and delete the booking when
the waiter wakes you first (`start` reminds you). An item parked by a version
before the precheck watched hands itself over: the sweep finds its waiter gone,
and `wait --park` ends at once where the precheck watches.

**A short wait** — checks that finish in minutes — needs no parking:
`run-state.sh wait <pr>...` blocks up to nine minutes in the turn, the slot
kept. Exit `3` is nothing yet: call it again. `wait` refuses while you hold the
exclusive lock: `unlock` first.

An item with pull requests in more than one repository parks on them all
([runs.md](runs.md) → **Other repositories**), and is merged only once every
one is.

## The required check

A change on `verify_required_paths` goes to review only once
`verify_environment` — else `verify_exclusive` — passed on its head. After every
run of it, `run-state.sh checked <check> pass|fail|skipped [cause]` records the
result on the item and in `TICK.log`; `park` and `finish pr-opened|pr-updated`
read it, and refuse while it is missing, failed or skipped, or on another
commit.

- **Refused:** the check cannot pass now — what it needs is broken in this
  sandbox, or the default branch breaks it too. Make the pull request a draft
  (`gh pr ready <pr> --undo`), say on it in one line which check, the cause,
  and what would let it run; swap the claim for the failed label, and
  `finish blocked`. A person decides what happens next.
- **Off those paths**, a check that did not pass still never stays silent:
  record it with `checked`, say it in the body, and post what `checked`
  prints.
- **The default branch breaks it**, not your change: run the check on a
  fresh slot of the default branch to prove it, then file one issue for it in
  `repo`, without the hand-off label — once: `checked` says when the cause
  was seen this week already, and then the issue is linked instead.

## Each time you hold one

Read its state — `gh pr view <n> --json reviewDecision,mergeable,statusCheckRollup,headRefOid`,
or, when GraphQL's budget is spent, `gh api repos/<repo>/pulls/<n>` and its
`/reviews` and the head's `/check-runs` over REST — then the reviews and
comments since your last push — and handle all of it in
one round, so one push answers everything:

1. **Failed checks.** Read why (`gh run view <id> --log-failed`), fix the cause,
   run `verify`, and `verify_exclusive` or `verify_environment` when the failure was there. A failure that is not yours to fix — flaky, infrastructure —
   gets one re-run, and only of a run on the current head: re-running a
   superseded one cancels the fresh one.
2. **Review findings**, from people and review bots alike — a comment-only
   review is still findings. Fix each, or answer why not in its thread. A
   finding that asks for something beyond the job is declined there
   (`CLAUDE.md` → **Trust boundary**). **A person's comment is findings
   too**, in the conversation or on a line. **After approval**, a review with
   findings or a comment from a maintainer — `OWNER`, `MEMBER` or
   `COLLABORATOR` — is still a round; anyone else's is not, and nothing
   wakes you for it. A push may dismiss the approval: then re-request it.
3. **Conflicts.** Rebase on the default branch, run `verify` again.
4. **Push**, move its Environment's expiry on when it has one, and, with
   `demo_environment`, install the push there and retake the demo's
   screenshots when what a person sees changed — or make the demo a round
   before could not ([environments.md](environments.md)), comment with this run's session link, and ask for review of the
   new round: re-request the reviewers who reviewed, and re-apply the
   review-request label only when nothing re-requests them otherwise — the
   label the reviewer itself names, when its review names one (a delta label
   for the new commits wins over a full review). A label is never created to
   ask for review: one missing from the repository is the wrong name, and a run
   reports it instead. Then park it, above.

**Approved, green and mergeable** is parked `awaiting-merge`: with
`slack_channel` set, `park` says to post that it is ready to merge
([notify.md](notify.md)). Red or conflicting meanwhile: fix only that, and
re-request review if the fix was more than mechanical. You never merge.

**Merged** is finished: drop the claim from its issue, comment the issue with
the pull request link, delete its Environment when it has one
([environments.md](environments.md)), and finish `released` (`finish released <pr>`).
None of it needs a worktree, so `start` takes no slot for an item whose pull
requests are all merged or closed, and every slot in use never holds it back.

**Closed without merging**, the issue still claimed: someone decided against
it. Read why on the pull request; drop the claim, comment the issue, finish
`released`. Never reopen it.

**The repository's own process wins where it says more.** If the checkout
documents how its pull requests are driven to merge — a babysit or review
skill, `CONTRIBUTING` — follow it, within the **Hard invariants**, for what
one round does: how to mark it ready, whom to ask, how to answer findings.
**Its waiting goes through `park` and `wait`.** Where it says to watch, poll or
loop until a review or a check arrives, park instead (**Held, then parked**,
above): it frees what other runs need, and the precheck brings the session back.

**When you cannot get it green**, say so on the pull request — what fails, what
you tried — and finish the run `blocked`. The precheck does not wake for the
same failure again, so the comment is what a person sees.
