#!/usr/bin/env bash
# Wires this definition into Claude Code. Idempotent; keeps every other hook,
# setting and skill. On another harness it says so and exits 0. What it wires
# takes effect from the next session.
#
#   Stop hook        enforce-finish.sh, in ~/.claude/settings.json
#   our skills       ~/.claude/skills -> ~/.agents/skills, where the bundled
#                    skills live beside the platform's; left alone when the
#                    platform already links it
#   repo skills      work/.claude/skills -> the checkout's own skills. A run's
#                    working directory is work/, and Claude Code loads project
#                    skills from there alone, so without the link a run never
#                    sees the repository's skills. The checkout's CLAUDE.md
#                    files need nothing: they load as its files are read.
set -u
if [ "${CLAUDECODE:-}" != 1 ] && [ -z "${FORCE_INSTALL:-}" ]; then
  echo "not the Claude Code harness — nothing installed"
  exit 0
fi
command -v jq >/dev/null 2>&1 || { echo "jq missing — nothing installed"; exit 1; }
. "$(cd "$(dirname "$0")/../.." && pwd)/lib/config.sh"
RC=0

# ---------------------------------------------------------------- Stop hook
SETTINGS="$HOME/.claude/settings.json"
HOOK="$HOME/scripts/harness/claude-code/enforce-finish.sh"
mkdir -p "$(dirname "$SETTINGS")"
[ -s "$SETTINGS" ] || echo '{}' > "$SETTINGS"
if jq -e --arg h "$HOOK" '[.hooks.Stop[]?.hooks[]?.command] | index($h)' "$SETTINGS" >/dev/null 2>&1; then
  echo "Stop hook: already installed"
else
  tmp="$(mktemp)"
  if jq --arg h "$HOOK" '.hooks //= {} | .hooks.Stop = ((.hooks.Stop // []) + [{hooks: [{type: "command", command: $h, timeout: 15}]}])' \
      "$SETTINGS" > "$tmp"; then
    mv "$tmp" "$SETTINGS"; echo "Stop hook: installed -> $HOOK"
  else
    rm -f "$tmp"; echo "Stop hook: could not update $SETTINGS — left unchanged"; RC=1
  fi
fi

# --------------------------------------------------------------- our skills
if [ -e "$HOME/.claude/skills" ] || [ -L "$HOME/.claude/skills" ]; then
  echo "our skills: ~/.claude/skills already there"
else
  ln -s ../.agents/skills "$HOME/.claude/skills" && echo "our skills: linked ~/.claude/skills -> ~/.agents/skills"
fi
[ -f "$HOME/.claude/skills/implement-issue/SKILL.md" ] ||
  { echo "our skills: implement-issue does not resolve through ~/.claude/skills"; RC=1; }

# -------------------------------------------------------------- repo skills
REPO="$(cfg repo)"; NAME="${REPO##*/}"; LINK="$HOME/work/.claude/skills"
SRC=""
for d in .claude/skills .agents/skills; do
  [ -n "$NAME" ] && [ -d "$HOME/work/$NAME/$d" ] && { SRC="$d"; break; }
done
if [ -z "$SRC" ]; then
  echo "repo skills: ${NAME:-no checkout} ships none"
elif [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "repo skills: $LINK exists and is not a link — left alone; move it aside and run this again"; RC=1
else
  mkdir -p "$HOME/work/.claude"
  ln -sfn "../$NAME/$SRC" "$LINK" &&
    echo "repo skills: linked work/.claude/skills -> $NAME/$SRC ($(ls "$LINK" | wc -l | tr -d ' ') skills)"
fi
exit "$RC"
