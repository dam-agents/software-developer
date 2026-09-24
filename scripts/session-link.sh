#!/usr/bin/env bash
# Prints the platform link to the session this run is happening in — the line a
# pull request carries so a reviewer can read how it was written.
#
# The session id is the harness's own: the platform keeps whatever id the
# harness minted when it opened the session, so $CLAUDE_CODE_SESSION_ID is the
# session in the URL. A harness that does not export it still gets a working
# link, to the agent rather than to the run.
set -uo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib/config.sh"

APP="$(cfg app_url | sed -E 's#/+$##')"

if [ -z "$APP" ] || [ -z "${PLATFORM_AGENT_ID:-}" ]; then
  echo "no link: work/CONFIG.md names no app_url" >&2
  exit 1
fi

if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
  printf '%s/a/%s?s=%s\n' "$APP" "$PLATFORM_AGENT_ID" "$CLAUDE_CODE_SESSION_ID"
else
  printf '%s/a/%s\n' "$APP" "$PLATFORM_AGENT_ID"
fi
