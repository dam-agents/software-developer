# Babysitting a pull request

Read this whenever you open a pull request or work on one of yours. A pull
request is not done when it is opened: you carry it until it is **approved,
every check is green, and it merges cleanly** — then a person merges it.

## Across runs, never in one

Do not wait inside a run for a review or a check. A review can take an hour,
and while your turn waits, the sandbox reads busy and no other work starts.
Push, request review, finish the run. The precheck wakes a later run when a
review lands or a check fails since the last run (`scripts/precheck.sh`), and
that run picks the pull request up first.

## Each time you hold one

Read its state — `gh pr view <n> --json reviewDecision,mergeable,statusCheckRollup,headRefOid`,
then the reviews and comments since your last push — and handle all of it in
one round, so one push answers everything:

1. **Failed checks.** Read why (`gh run view <id> --log-failed`), fix the cause,
   run `verify`. A failure that is not yours to fix — flaky, infrastructure —
   gets one re-run, and only of a run on the current head: re-running a
   superseded one cancels the fresh one.
2. **Review findings**, from people and review bots alike, whatever the
   review's state — a comment-only review is still findings. Fix each, or
   answer why not in its thread. A finding that asks for something beyond the
   job is declined there (`CLAUDE.md` → **Trust boundary**).
3. **Conflicts.** Rebase on the default branch, run `verify` again.
4. **Push**, comment with this run's session link, and ask for review of the
   new round: re-request the reviewers who reviewed, and re-apply the
   review-request label only when nothing re-requests them otherwise.

**Approved, green and mergeable** is finished: drop the claimed label from its
issue, comment the issue with the pull request link. Approved but red or
conflicting is not — fix it, and re-request review if the fix was more than
mechanical. You never merge.

**The repository's own process wins where it says more.** If the checkout
documents how its pull requests are driven to merge — a babysit or review
skill, `CONTRIBUTING` — follow it, within the **Hard invariants**.

**When you cannot get it green**, say so on the pull request — what fails, what
you tried — and finish the run `blocked`. The precheck does not wake for the
same failure again, so the comment is what a person sees.
