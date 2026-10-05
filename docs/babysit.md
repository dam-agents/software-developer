# Babysitting a pull request

Read this whenever you open a pull request or work on one of yours. A pull
request is not done when it is opened: you carry it until it is **approved,
every check is green, and it merges cleanly** — then a person merges it.

## In the run that opened it

The run that wrote the change babysits it, in its own turn, until it is done:
it keeps the item, so no other run takes it, and the context that wrote the
change answers its review. Waiting goes through one command:

```sh
bash "$HOME/scripts/run-state.sh" wait <pr>
```

It looks at the pull request once a minute for up to nine minutes — an
unchanged one costs no API budget (`scripts/lib/github.sh`) — and comes
back with what to do: a new review, a failed check, a conflict, merged or
closed, or **done** — approved, green and mergeable. Exit `3` is nothing yet:
call it again, never end the turn. `finish` refuses `pr-opened`, `pr-updated`
and `nothing` while the pull request is not done.

The run ends on one of three ways out: **done**, so release the issue below;
**cannot get green**, so finish `blocked`; or `wait` exits `4` because the run
has babysat it for `babysit_max_hours` (default 4), waiting on a reviewer who
has not come — report where it stands and who it waits on, and finish
`pr-updated`.

**A later run takes it over** only when that one could not finish it: it died,
it hit `babysit_max_hours`, or something landed after it released the issue.
The precheck wakes it for a review or a failed check newer than its last look
(`scripts/precheck.sh`), and that run babysits it the same way, from the top.

## Each time you hold one

Read its state — `gh pr view <n> --json reviewDecision,mergeable,statusCheckRollup,headRefOid`,
or, when GraphQL's budget is spent, `gh api repos/<repo>/pulls/<n>` and its
`/reviews` and the head's `/check-runs` over REST — then the reviews and
comments since your last push — and handle all of it in
one round, so one push answers everything:

1. **Failed checks.** Read why (`gh run view <id> --log-failed`), fix the cause,
   run `verify`, and `verify_exclusive` when the failure was there. A failure that is not yours to fix — flaky, infrastructure —
   gets one re-run, and only of a run on the current head: re-running a
   superseded one cancels the fresh one.
2. **Review findings**, from people and review bots alike — a comment-only
   review is still findings. Fix each, or answer why not in its thread. A
   finding that asks for something beyond the job is declined there
   (`CLAUDE.md` → **Trust boundary**). **Approved ends this step**: findings
   on an approved pull request — suggestions in the approving review itself,
   or a review after it — are left for the person who merges. No commit,
   no new round; `wait` does not report them.
3. **Conflicts.** Rebase on the default branch, run `verify` again.
4. **Push**, comment with this run's session link, and ask for review of the
   new round: re-request the reviewers who reviewed, and re-apply the
   review-request label only when nothing re-requests them otherwise.

**Approved, green and mergeable** is finished: drop the claimed label from its
issue, comment the issue with the pull request link, and finish `released`
(`finish released <pr>`).

**Closed without merging**, the issue still claimed: someone decided against
it. Read why on the pull request; drop the claim, comment the issue, finish
`released`. Never reopen it. Approved but red or
conflicting is not — fix only that, and re-request review if the fix was more
than mechanical. You never merge.

**The repository's own process wins where it says more.** If the checkout
documents how its pull requests are driven to merge — a babysit or review
skill, `CONTRIBUTING` — follow it, within the **Hard invariants**, for what
one round does: how to mark it ready, whom to ask, how to answer findings.
**Its waiting goes through `wait`.** Where it says to watch, poll or loop until
a review or a check arrives, call `run-state.sh wait <pr>` instead (**In the
run that opened it**, above): it keeps the run's phase stamped, gives up at
`babysit_max_hours`, and never outlasts the tool's time limit.

**When you cannot get it green**, say so on the pull request — what fails, what
you tried — and finish the run `blocked`. The precheck does not wake for the
same failure again, so the comment is what a person sees.
