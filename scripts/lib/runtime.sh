#!/usr/bin/env bash
# runtime.sh — what the platform runtime says about a session. Sourced, never
# run; run-state.sh and the Stop hook share it.
#
# A session is attended when its operator is in it: the direct chat
# (`regular`), or a scheduled or Slack session the operator has typed into —
# its history holds a person's message after the prompt that started it. Only
# an unattended session is held by the Stop hook or reaped when idle.

# session <id> — "<running> <type>" (e.g. "false schedule_cron"); prints
# nothing for a session unknown to the runtime; fails when it does not answer
session() {
  local out
  out="$(curl -fsS --max-time 5 --get --data-urlencode "input={\"sessionId\":\"$1\"}" \
    "${PLATFORM_RUNTIME_URL:-}/api/trpc/sessions.list" 2>/dev/null)" || return 1
  printf '%s' "$out" | jq -r '.result.data.sessions | if type != "array" then error
    else .[0] // empty | "\(.running == true) \(.type // "")" end' 2>/dev/null || return 1
}

# joined <id> — 0 when the session's history holds a person's message after its
# first: what the harness and the platform inject (interrupts, resumed turns,
# sub-agent and task notifications, Slack turns) does not count. A history the
# runtime does not give is no proof of anything: 1.
joined() {
  curl -fsS --max-time 5 --get --data-urlencode "input={\"sessionId\":\"$1\"}" \
    "${PLATFORM_RUNTIME_URL:-}/api/trpc/sessions.history" 2>/dev/null |
    jq -e '[.result.data.frames[] | fromjson? | .params.update
        | select(.sessionUpdate? == "user_message_chunk")]
      | (.[0].messageId) as $first | map(select(.messageId != $first) | .content.text // "")
      | map(select(test("^\\s*(<how-to-respond>|<turn-interrupted>|<agent-message|<task-notification>|<system-reminder>|\\[Request interrupted|A sub-agent you spawned)") or test("^\\s*$") | not))
      | length > 0' >/dev/null 2>&1
}

# attended <id> <type> — the operator is in it (see the top of this file)
attended() { [ "$2" = regular ] || joined "$1"; }
