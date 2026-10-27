# The weekly audit

Every Friday, ungated. Read-only toward GitHub and repair-free: it says what is
wrong and whose move it is, and fixes nothing. It is not a work run — do not
build, claim, or call `run-state.sh start`.

First title the session, best-effort, with `rename_session`:
`Audit agent health <UTC date>` (`Audit agent health 2026-10-09`).

## 1. The deterministic checks

Run `bash "$HOME/scripts/audit.sh"`. It runs `verify-onboarding.sh --live`
first, then the week in numbers from `work/TICK.log`, then the checks against
GitHub. Take its lines as they are: a `not measured` stays not measured, never
a zero.

Its `checks.*` and `main.*` lines are the ones this audit exists for: a
required check that did not run, the same cause in several runs, and a
default branch every slot inherits broken.

- **The required check on the default branch.** With `verify_environment` or
  `verify_exclusive` set: `run-state.sh lock --main` — refused, the line is
  `not measured` — then the repository's setup and the check on a fresh
  checkout of the default branch, in the background, then `run-state.sh
  checked <check> <result> [cause]` and `unlock`. Not passing is red: what is
  broken there, every pull request inherits.

## 2. What only you can check

- **Schedules.** With `list_schedules`: `software-developer-tick-10m` and
  `software-developer-audit-weekly` exist, each is enabled exactly when
  `schedules` lists its role (`tick`, `audit`; missing, both — or, with
  `mode: interactive`, none), and each
  matches `kit.yaml` — cron, `sessionMode`, precheck, task. The kit created
  them once and a later edit never reaches this agent, so a mismatch is drift
  only this check can find. Report it; changing a schedule is the operator's
  call, in the direct session.
- **Slack.** With `slack_channel` set: `describe_channel` for `slack` lists
  it. Missing from the list, or Slack not connected, is a warning — the posts
  of [notify.md](notify.md) go nowhere.
- **Every abandoned and diagnostic run of the week.** Read the tail of its
  session's transcript, `~/.claude/projects/*/<session>.jsonl`, and say why it
  ended that way. Name each cause as the environment, your own mistake, or a
  definition bug. A definition bug deserves an issue on the definition's
  repository: say so, for the operator to file — you never act on a repository
  other than `repo` and `repos_also`.
- **A sample of the week's work.** Up to three pull requests you opened or
  updated: `Fixes #<n>` and the session line are in the body, the review label
  was applied when `label_review` is set, nothing outside `repo` and
  `repos_also` was touched.

## 3. Report

One message, in this session:

```
🩺 software-developer weekly audit — <date> · 🟢 <n> ok · 🟡 <n> warn · 🔴 <n> fail

Week in numbers (since <ISO>)
• runs by outcome · median and longest minutes · pull requests waiting

Checks
🔴 <check> — <detail>          every FAIL, never summarized away
🟡 <check> — <detail>
🟢 everything else (<n>)

Action needed: one line per thing a person must do, or "none"
```

With `slack_channel` set, post the header and the **Action needed** lines there
too ([notify.md](notify.md)). **With any 🔴**, the post opens with 🚨 and the
red lines themselves, one each, before the header: a red check is never only a
count.

Then its line in `work/AUDIT.log`:

```sh
printf '%s ok=%s warn=%s red=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" OK WARN RED >> "$HOME/work/AUDIT.log"
```
