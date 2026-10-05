---
name: file-issue
description: The definition's default for turning a grilled issue into sub-issues, used when work/CONFIG.md names no `skill_file_issue`. Draft each sub-issue so one pull request can implement it unattended; files only after approval in the thread. Read from docs/grill.md and docs/slack.md, which set the limits.
---

# Draft sub-issues

Each sub-issue is a work order for a run that has only the issue to go on: it
cannot ask the thread, and it does exactly what the issue says.

1. **Cut along pull requests.** One sub-issue is one pull request that can be
   reviewed and merged alone. Split where the order matters, and say in each
   which ones must land first.
2. **Search for duplicates** — `gh issue list --repo <repo> --search "<words>"
   --state all` with a few wordings. A match: say so in the breakdown, and
   leave the choice to the people.
3. **Each body:**
   - **Context** — why, in a sentence or two, and `Part of #<n>`.
   - **What to do** — the behaviour wanted, with the decisions the grill made
     that apply to it, stated as decisions, not as a transcript.
   - **Out of scope** — what a run might do and must not.
   - **Done when** — checks a reviewer can tick: behaviour, tests, docs.
   - **Depends on** — the sub-issues that land first, if any.
4. Keep file paths and function names out unless the decision was about them:
   the run finds the code; the issue says what it must do.
5. **Title** — an imperative that names the change, under 70 characters.
