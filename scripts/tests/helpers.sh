#!/usr/bin/env bash
# helpers.sh — sandbox and assertions shared by the test files. Sourced.
set -u

TESTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "$TESTS/.." && pwd)"
export PATH="$TESTS/bin:$PATH"
FAILED=0

# sandbox — a fresh $HOME with a configured work/ and an empty stub trace
sandbox() {
  export HOME; HOME="$(mktemp -d)"
  export STUB_DIR="$HOME"
  mkdir -p "$HOME/work" "$HOME/.claude/projects/-home-agent-work"
  printf -- '- repo: acme/widgets\n- author: dev-bot\n- label_handoff: agent/implement\n- label_claimed: agent/in-progress\n- app_url: https://platform.example.com\n' \
    > "$HOME/work/CONFIG.md"
  unset STUB_STATUS STUB_PRS STUB_HANDOFF STUB_CLAIMED CLAUDE_CODE_SESSION_ID
  export PLATFORM_RUNTIME_URL="http://127.0.0.1:9" PLATFORM_FIRE_AT="2026-09-24T10:20:00Z"
}

# ago <minutes> — an ISO-UTC time that many minutes back
ago() {
  local t=$(( $(date -u +%s) - $1 * 60 ))
  date -u -d "@$t" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$t" +%Y-%m-%dT%H:%M:%SZ
}

# touch_ago <file> <minutes>
touch_ago() {
  local t=$(( $(date -u +%s) - $2 * 60 ))
  touch -d "@$t" "$1" 2>/dev/null || touch -t "$(date -r "$t" +%Y%m%d%H%M.%S)" "$1"
}

record() {   # record key=value ... — a work/RUN.md as run-state.sh would write it
  { printf '# RUN\n\n'; for p in "$@"; do printf -- '- %s: %s\n' "${p%%=*}" "${p#*=}"; done; } \
    > "$HOME/work/RUN.md"
}

precheck() { OUT="$(cd "$HOME/work" && bash "$SCRIPTS/precheck.sh" 2>"$HOME/err")"; RC=$?; }
state() { OUT="$(bash "$SCRIPTS/run-state.sh" "$@" 2>"$HOME/err")"; RC=$?; }
field() { . "$SCRIPTS/lib/config.sh"; kv "$HOME/work/$1" "$2"; }

fail() { echo "  ✗ $CASE: $*" >&2; FAILED=1; }
is() { [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }
has() { case "$1" in *"$2"*) ;; *) fail "$3: no '$2' in: $(printf '%s' "$1" | head -c 300)" ;; esac; }
lacks() { case "$1" in *"$2"*) fail "$3: unexpected '$2'" ;; esac; }
no_gh() { [ ! -s "$HOME/gh.calls" ] || fail "made GitHub calls: $(cat "$HOME/gh.calls")"; }
done_() { rm -rf "$HOME"; }
