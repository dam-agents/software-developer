#!/usr/bin/env bash
# helpers.sh — sandbox and assertions shared by the test files. Sourced.
set -u

TESTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "$TESTS/.." && pwd)"
export PATH="$TESTS/bin:$PATH"
FAILED=0

# A mise shim resolves its tool through config under $HOME, which the sandbox
# replaces, so link the real binary once while $HOME is still the real one.
TOOLS="$(mktemp -d)"
trap 'rm -rf "$TOOLS"' EXIT
unshimmed() {
  local d IFS=:
  for d in $PATH; do
    case "$d" in */shims*) continue ;; esac
    [ -x "$d/$1" ] && { echo "$d/$1"; return 0; }
  done
  mise which "$1" 2>/dev/null
}
case "$(command -v jq)" in
  */shims/*) real="$(unshimmed jq)" && ln -s "$real" "$TOOLS/jq" ;;
esac
export PATH="$TESTS/bin:$TOOLS:$PATH"

# sandbox — a fresh $HOME with a configured work/ and an empty stub trace
sandbox() {
  export HOME; HOME="$(mktemp -d)"
  export STUB_DIR="$HOME"
  mkdir -p "$HOME/work" "$HOME/.claude/projects/-home-agent-work"
  cat > "$HOME/work/CONFIG.md" <<'CFG'
Set up during onboarding.

- repo: acme/widgets
- author: dev-bot
- app_url: https://platform.example.com
- label_handoff: agent/implement
- label_claimed: agent/in-progress
- label_failed: agent/failed
- label_review: code-guardian-review
- verify: mise run check
- cluster: none
- stuck_after_min: 120

## Bounds

- Nothing under deploy/ is ours to change.
CFG
  export SD_LOCKS="$HOME/locks" SD_BOOT_ID=boot-1
  unset STUB_RUNNING STUB_RUNTIME_DOWN STUB_STATUS STUB_PRS STUB_HANDOFF STUB_CLAIMED STUB_LOGIN STUB_PUSH STUB_REACH \
    STUB_LABELS STUB_PR_FAIL STUB_BACKUP_CONFIG STUB_WORK_PUSH STUB_COMMENTS STUB_PULL STUB_ISSUE CLAUDE_CODE_SESSION_ID PRECHECK_PROBE \
    WORK_BACKUP_REMOTE WORK_BACKUP_LOCAL
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

# onboarded — the rest of what onboarding leaves: the definition checked out at
# $HOME and committed, the sentinel, work/AGENTS.md, work/VERSION, the clone
onboarded() {
  local repo; repo="$(cd "$SCRIPTS/.." && pwd)"
  cp "$repo/.gitignore" "$repo/VERSION" "$repo/kit.yaml" "$HOME/"
  mkdir -p "$HOME/.agents/skills/implement-issue" && : > "$HOME/.agents/skills/implement-issue/SKILL.md"
  ln -s ../.agents/skills "$HOME/.claude/skills"
  git init -q "$HOME" && git -C "$HOME" add -A &&
    git -C "$HOME" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false \
      commit -qm definition 2>/dev/null
  date -u +%Y-%m-%dT%H:%M:%SZ > "$HOME/.software-developer-onboarded"
  printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"%s"}]}]}}' \
    "$HOME/scripts/harness/claude-code/enforce-finish.sh" > "$HOME/.claude/settings.json"
  echo "# pointer" > "$HOME/work/AGENTS.md"
  cp "$HOME/VERSION" "$HOME/work/VERSION"
  git init -q "$HOME/work/widgets" &&
    git -C "$HOME/work/widgets" remote add origin https://github.com/acme/widgets
}

verify() { OUT="$(bash "$SCRIPTS/verify-onboarding.sh" "$@" 2>"$HOME/err")"; RC=$?; }

# lock <name> key=value ... — a lock as run-state.sh would leave it
lock() {
  local l="$SD_LOCKS/$1"; shift
  mkdir -p "$l"
  { printf '# owner\n\n'; for p in "boot=boot-1" "$@"; do printf -- '- %s: %s\n' "${p%%=*}" "${p#*=}"; done; } > "$l/owner"
}

# item <n> key=value ... — a work/items/<n>.md
item() {
  local n="$1"; shift
  mkdir -p "$HOME/work/items"
  { printf '# %s\n\n- item: %s\n' "$n" "$n"; for p in "$@"; do printf -- '- %s: %s\n' "${p%%=*}" "${p#*=}"; done; } \
    > "$HOME/work/items/$n.md"
}

# origin — work/widgets cloned from a local bare origin with one commit on main
origin_checkout() {
  local seed; seed="$(mktemp -d)"
  git init -q --bare -b main "$HOME/widgets.git"
  git init -q -b main "$seed/s" && echo hello > "$seed/s/README.md" && echo dist/ > "$seed/s/.gitignore"
  git -C "$seed/s" add -A
  git -C "$seed/s" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -qm init
  git -C "$seed/s" push -q "$HOME/widgets.git" main; rm -rf "$seed"
  rm -rf "$HOME/work/widgets"
  git clone -q "$HOME/widgets.git" "$HOME/work/widgets"
}
gitc() { git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@"; }

precheck() { OUT="$(cd "$HOME/work" && bash "$SCRIPTS/precheck.sh" 2>"$HOME/err")"; RC=$?; }
state() { OUT="$(bash "$SCRIPTS/run-state.sh" "$@" 2>"$HOME/err")"; RC=$?; }
field() { . "$SCRIPTS/lib/config.sh"; kv "$HOME/work/$1" "$2"; }

fail() { echo "  ✗ $CASE: $*" >&2; FAILED=1; }
is() { [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }
has() { case "$1" in *"$2"*) ;; *) fail "$3: no '$2' in: $(printf '%s' "$1" | head -c 300)" ;; esac; }
lacks() { case "$1" in *"$2"*) fail "$3: unexpected '$2'" ;; esac; }
no_gh() { [ ! -s "$HOME/gh.calls" ] || fail "made GitHub calls: $(cat "$HOME/gh.calls")"; }
done_() { rm -rf "$HOME"; }
