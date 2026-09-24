# The weekly audit

Every Friday, ungated. Read-only toward GitHub and repair-free: it says what is
wrong and whose move it is, and fixes nothing. It is not a work run — do not
build, claim, or call `run-state.sh start`.

## 1. The deterministic checks

Run `bash "$HOME/scripts/audit.sh"`. It runs `verify-onboarding.sh --live`
first, then the week in numbers from `work/TICK.log`, then the checks against
GitHub. Take its lines as they are: a `not measured` stays not measured, never
a zero.

## 2. What only you can check

- **Schedules.** With `list_schedules`: `software-developer-tick-10m` and
  `software-developer-audit-weekly` exist, the tick is enabled, and each
  matches `kit.yaml` — cron, `sessionMode`, precheck, task. The kit created
  them once and a later edit never reaches this agent, so a mismatch is drift
  only this check can find. Report it; changing a schedule is the operator's
  call, in the direct session.
- **Every abandoned and diagnostic run of the week.** Read the tail of its
  session's transcript, `~/.claude/projects/*/<session>.jsonl`, and say why it
  ended that way. Name each cause as the environment, your own mistake, or a
  definition bug. A definition bug deserves an issue on the definition's
  repository: say so, for the operator to file — you never act on a repository
  other than `repo`.
- **A sample of the week's work.** Up to three pull requests you opened or
  updated: `Fixes #<n>` and the session line are in the body, the review label
  was applied, nothing outside `repo` was touched.

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

Then its line in `work/AUDIT.log`:

```sh
printf '%s ok=%s warn=%s red=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" OK WARN RED >> "$HOME/work/AUDIT.log"
```
