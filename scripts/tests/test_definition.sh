#!/usr/bin/env bash
# The definition agrees with itself: the places that name config keys and the
# places that name schedules say the same thing.
. "$(dirname "$0")/helpers.sh"
ROOT="$(cd "$SCRIPTS/.." && pwd)"

onb="$(sed -n '/^```markdown$/,/^```$/p' "$ROOT/ONBOARDING.md" | grep -oE '^- [a-z_]+:' |
  sed 's/^- //; s/:$//' | sort)"
known="$(sed -n '/^KNOWN="/,/"$/p' "$ROOT/scripts/verify-onboarding.sh" | sed 's/^KNOWN=//' |
  tr -d '"' | tr -s ' \n' '\n\n' | grep . | sort)"

CASE="the verifier knows exactly the keys onboarding writes"
[ -n "$onb" ] || fail "found no keys in ONBOARDING's example"
is "$known" "$onb" "KNOWN against ONBOARDING"

CASE="CLAUDE.md documents every key"
section="$(sed -n '/^## Runtime configuration/,/^## Run types/p' "$ROOT/CLAUDE.md")"
for k in $onb; do
  case "$section" in *"\`$k\`"*) ;; *) fail "\`$k\` is not in CLAUDE.md → Runtime configuration" ;; esac
done

CASE="every schedule's task points at a procedure that exists"
sed -n '/^schedules:/,$s/^    task: //p' "$ROOT/kit.yaml" | while read -r task; do
  h="$(printf '%s' "$task" | sed -n 's/.*CLAUDE\.md → "\([^"]*\)".*/\1/p')"
  [ -z "$h" ] || grep -qx "## $h" "$ROOT/CLAUDE.md" || echo "no '## $h' in CLAUDE.md: $task"
  for f in $(printf '%s' "$task" | grep -oE 'docs/[a-z-]+\.md'); do
    [ -f "$ROOT/$f" ] || echo "no $f: $task"
  done
done > "$TOOLS/tasks"
[ ! -s "$TOOLS/tasks" ] || fail "$(cat "$TOOLS/tasks")"

CASE="the audit checks every schedule the kit creates"
for n in $(sed -n '/^schedules:/,$s/^  - name: //p' "$ROOT/kit.yaml"); do
  grep -q "\`$n\`" "$ROOT/docs/audit.md" || fail "docs/audit.md does not name $n"
done

exit "$FAILED"
