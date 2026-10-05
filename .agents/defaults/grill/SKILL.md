---
name: grill
description: The definition's default for grilling an issue in a Slack thread, used when work/CONFIG.md names no `skill_grill`. Interview the people in the thread about the issue until every decision it needs is made, one question at a time, each with your recommended answer. Read from docs/grill.md, which sets the limits.
---

# Grill an issue

The issue is the plan; the thread is where it gets decided. Your job is to find
every decision it leaves open, and get each one made.

1. **Read first.** The issue, its comments and linked issues, and the code it
   touches on the default branch. Whatever the code or the repository's docs
   answer, do not ask — say what you found.
2. **Map the decisions.** What the change is for, who it is for, what is in
   and out of scope, the behaviour at each edge, what it breaks or migrates,
   how it is tested, and the order it can land in. Resolve them in the order
   they depend on each other.
3. **One question per reply.** Each one states the decision, the options that
   matter, and **your recommended answer, with why**. Ask the people to
   answer, change it, or say "your call". Then stop: the answer is the next
   turn.
4. **Challenge.** An answer that contradicts the code, an earlier answer or
   the repository's own vocabulary: say so, plainly, before moving on.
5. **Done** when nothing open is left that changes what gets built, or when
   the people say so. Post the decisions, one line each, and move on to the
   breakdown (`docs/grill.md` → **Breakdown**).
