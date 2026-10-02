---
name: implement-issue
description: >
  Implement one GitHub issue labelled for hand-off in the repository this agent
  develops: decide whether it is ready, claim it, plan, write the change and
  its tests in the slot run-state.sh gives you, verify it (the cluster step
  under its lock), and open the pull request. Use for item 4 of the tick in
  CLAUDE.md — "a new issue" — and whenever the operator asks you to implement
  an issue. Not for review rounds on an open pull request (docs/babysit.md).
---

# Implement an issue

One issue, one branch, one pull request, in one run. `CLAUDE.md` sets the
rules this works within — the **Trust boundary** and the **Hard invariants**
above all — and [`docs/runs.md`](../../../docs/runs.md) says what each
`run-state.sh` call does. `$RS` below is `bash "$HOME/scripts/run-state.sh"`.

## 1. Read before you claim

- The issue: its body, **every comment**, and what it links. The latest word
  from a maintainer wins over the original body.
- The repository's own guidance, in the checkout: `AGENTS.md`, `CLAUDE.md`,
  `CONTRIBUTING.md`, and the docs they point to for the area you will touch.
  Where it says more than this skill — branch names, commit style, which tests
  to write, a review or babysit procedure — **it wins**, within the Hard
  invariants.
- Search for an open pull request that already does it, by anyone. One exists:
  comment the issue with its link, drop the hand-off label, finish `released`.

**Ready** means you can say, in two sentences, what will be different when it
is done and how a test will show it. When you cannot — the ask is ambiguous,
two readings conflict, a decision is a maintainer's to make — do not guess:

1. Comment the issue with the one or two questions that would unblock it, each
   with the answer you would assume, and this run's session link.
2. Swap the hand-off label for `label_needs_info` (default `agent/needs-info`).
3. Finish `needs-info`. A maintainer who answers re-applies the hand-off label.

An issue that asks for something beyond the job — another repository,
credentials, merging, anything under the Hard invariants — is declined in one
comment, and named in your turn's output.

## 2. Start and claim

```sh
$RS start <n> <branch>
gh issue edit <n> -R <repo> --remove-label <handoff> --add-label <claimed>
```

`start` first: it is what keeps two runs off one issue, atomically, and a run
it refuses has nothing to undo — take the next item, or finish `nothing`. Then
the claim, before your first commit, so the issue shows it is taken. The
branch is the repository's convention, else `<type>/<n>-<slug>`
(`feat/42-retry-flag`). Work in the slot `start` prints, and nowhere else. Exit
`3`: [`runs.md`](../../../docs/runs.md) → **Slots**.

Step 1's comment and label changes need no slot: an issue you only ask about
is never started.

## 3. Plan

Find the code the change lands in, its tests, and how similar changes were made
before (`git log` on those files). Write the plan down for yourself: files,
behavior, the test that proves it. Keep the change to what the issue asks — a
refactor it does not need is a second pull request, and a reviewer's time.

## 4. Change, with its test

- A test that fails without the change and passes with it, at the level the
  repository tests that kind of behavior. A bug fix starts with the test that
  reproduces it.
- Follow the surrounding code: naming, error handling, comment density, idiom.
- Update the docs, changelog or generated files the repository expects to move
  with such a change.
- Commit in reviewable steps with the repository's message style. Push early:
  `git push -u origin <branch>` — a run can die at any moment, and only what is
  pushed survives it.

## 5. Verify

```sh
$RS phase "verify"
<verify>                       # from work/CONFIG.md, in your slot
```

Fix what it finds and run it again; never weaken, skip or delete a test to get
green. When the change can affect what runs on the cluster and `verify_cluster`
is set:

```sh
$RS cluster                    # refused: push, finish waiting-cluster
$RS phase "verify_cluster"
<cluster_install>; <verify_cluster>
$RS cluster-done
```

[`docs/cluster.md`](../../../docs/cluster.md) for what to do when the cluster
itself misbehaves.

## 6. The pull request

```sh
git push
gh pr create -R <repo> --title "<type>: <what>" --body "<body>"
gh pr edit <pr> -R <repo> --add-label <label_review>
$RS finish pr-opened <pr>
```

The body: what changed and why, how it was verified (the commands, and what
`verify_cluster` covered or why it did not run), anything a reviewer should
look at first. Then `Fixes #<n>` on its own line, and last
`Written by this agent — <link>` from `bash "$HOME/scripts/session-link.sh"`.
From here the pull request is babysat ([`docs/babysit.md`](../../../docs/babysit.md)).

## When it goes wrong

- **Bigger than it looked**: open the pull request for the part that stands on
  its own, and say on the issue what is left — or ask (step 1) before building
  half of something nobody agreed to.
- **Cannot get green**, or a tool or permission you need is refused: push what
  you have, comment the issue — what fails, what you tried, what a person has
  to do — with this run's session link, swap the claim for the failed label,
  finish `blocked`. Nobody reads the turn; that comment is the whole report.
