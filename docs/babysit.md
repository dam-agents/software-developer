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
| **Parked** | a person's: a review, a merge | the item alone | ends; a waiter wakes the session |

**Park** once the round is pushed and reported and a person moves next:

```sh
bash "$HOME/scripts/run-state.sh" park <pr>...
bash "$HOME/scripts/run-state.sh" wait --park      # as a background task
```

`park` refuses until the slot is pushed and this round's comment is on the pull
request, like `finish`. Then it gives the slot and the exclusive lock back —
nothing shared waits on a person — and marks the item `in-review`, or
`awaiting-merge` once every pull request is approved. Start its waiter as the
harness's own background task (Claude Code: `run_in_background`) and end the
turn: the Stop hook lets a parked turn end once its waiter runs.

**The waiter** looks at the pull requests once a minute — an unchanged one
costs nothing (`app/src/factory/github.ts`) — for up to two hours. It exits
when one needs you: a review, **a person's comment** in the conversation or on
a line, a failed check, a conflict, or the merge. The harness hands its output
to the session as a new turn: `start` the item again — it takes a slot, back
to Held — and handle what woke you, in the next section. Exit `3` is two hours
of nothing: start it again, and end the turn. **A person typing in the
session** wakes it the same way: `start` the item.

**A short wait** — checks that finish in minutes — needs no parking:
`run-state.sh wait <pr>...` blocks up to nine minutes in the turn, the slot
kept. Exit `3` is nothing yet: call it again. `wait` refuses while you hold the
exclusive lock: `unlock` first.

An item with pull requests in more than one repository parks and waits on them
all ([runs.md](runs.md) → **Other repositories**), and is merged only once
every one is.

**A restart kills the waiter.** In the direct session, book a wake-up too, so
the same session comes back: `schedule_once` with `inSession: "continue"`, a
little over two hours ahead, then `run-state.sh booked <its time> <its id>`.
Woken by the waiter first, delete the booking (`start` reminds you). A
scheduled run may not change the platform's schedules (`CLAUDE.md` → **Hard
invariants**): its waiter alone holds the item. After a restart, **the sweep
asks the session to start it again**: it finds the parked item with nothing
left to wake it, sends its session a message (`send_session_message`), and
holds the item fifteen minutes for it. The message is a turn there: start the
waiter again, as it says, and end the turn — it looks from your last round on,
so what landed meanwhile wakes you at once. The message not queued, or no
waiter in time, **a later run takes it over** — the precheck lists it like a
run that stopped, and a fresh session babysits it from the top, from the branch
and the pull request. `TICK.log` says which happened — `messaged`, then
`resumed … cause=waiter|booking|operator`, or `cause=fresh prev=<session>` —
and the weekly audit counts them.

## The required check

A change on `verify_exclusive_paths` goes to review only once
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
   `COLLABORATOR` — is still a round; anyone else's is not, and the waiter
   does not wake for it. A push may dismiss the approval: then re-request it.
3. **Conflicts.** Rebase on the default branch, run `verify` again.
4. **Push**, comment with this run's session link, and ask for review of the
   new round: re-request the reviewers who reviewed, and re-apply the
   review-request label only when nothing re-requests them otherwise. Then
   park it, above.

**Approved, green and mergeable** is parked `awaiting-merge`: with
`slack_channel` set, `park` says to post that it is ready to merge
([notify.md](notify.md)). Red or conflicting meanwhile: fix only that, and
re-request review if the fix was more than mechanical. You never merge.

**Merged** is finished: drop the claim from its issue, comment the issue with
the pull request link, and finish `released` (`finish released <pr>`).

**Closed without merging**, the issue still claimed: someone decided against
it. Read why on the pull request; drop the claim, comment the issue, finish
`released`. Never reopen it.

**The repository's own process wins where it says more.** If the checkout
documents how its pull requests are driven to merge — a babysit or review
skill, `CONTRIBUTING` — follow it, within the **Hard invariants**, for what
one round does: how to mark it ready, whom to ask, how to answer findings.
**Its waiting goes through `park` and `wait`.** Where it says to watch, poll or
loop until a review or a check arrives, park instead (**Held, then parked**,
above): it frees what other runs need, and the waiter brings the session back.

**When you cannot get it green**, say so on the pull request — what fails, what
you tried — and finish the run `blocked`. The precheck does not wake for the
same failure again, so the comment is what a person sees.
