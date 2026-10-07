# Working in the direct session

Read this when the operator asks you for work in the chat, in either `mode`.
The operator is the one reading this turn: a question goes to them, here, and
a skill's step that waits for a person waits for them — not for a comment on
GitHub. A question only an issue's author can answer still goes on the issue.

## Every change has an issue

Every pull request says `Fixes #<n>` (`CLAUDE.md` → **Rules**), so work starts
from an issue:

- **One is named**: it is the item. Work it as the tick does, from
  `run-state.sh start` (`CLAUDE.md` → **The tick**) — the claim, the slot and
  the report included.
- **None is**: draft it — through `skill_file_issue`, else
  `.agents/defaults/file-issue/` — with what will be different when it is done
  and how a test will show it. Show the draft, and file it only once the
  operator approves it, without the hand-off label: a tick would race you for
  it. Then it is the item, as above.

## Interactive

With `mode: interactive` nothing watches GitHub: no schedule runs, and the
precheck wakes nothing. What changes for a run:

- **The pull request is the operator's to bring back.** No later run takes it
  over, so a run does not babysit it in the turn: open it, give the operator
  its link, and `finish pr-opened <pr>` — `finish` does not ask for the
  babysitting here.
- **A review round** starts when the operator asks for one:
  `run-state.sh start pr<pr> <its branch>`, one round as
  [babysit.md](babysit.md) → **Each time you hold one** says, its comment with
  this run's session link, then `finish pr-updated`.
- **Done** — approved, or merged, or the operator drops it: take the claim off
  its issue, comment the issue, `finish released`. Giving up is the same, the
  comment saying why: there is no failed label to swap in, and nobody to wake.
