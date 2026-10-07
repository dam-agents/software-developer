#!/usr/bin/env bash
# repo-allowed.sh: `repo` always, `repos_also` only as written, nothing else.
. "$(dirname "$0")/helpers.sh"

allowed() { bash "$SCRIPTS/repo-allowed.sh" "$1" >/dev/null 2>&1 && echo yes || echo no; }

CASE="without repos_also, repo alone"; sandbox
is "$(allowed acme/widgets)" yes "repo"
is "$(allowed ACME/Widgets)" yes "repo, other case"
is "$(allowed acme/gadgets)" no "a sibling"

CASE="repos_also: names and owner/*"; sandbox
echo "- repos_also: Beta/*, gamma/one" >> "$HOME/work/CONFIG.md"
mkdir -p "$HOME/beta/x"; cd "$HOME" || exit 1   # a path the pattern must not expand to
is "$(allowed beta/gadgets)" yes "any of beta"
is "$(allowed gamma/one)" yes "a named one"
is "$(allowed gamma/two)" no "an unnamed sibling"
is "$(allowed evil/beta)" no "the owner as a name"
is "$(allowed beta/)" no "no name"
is "$(allowed beta/a/b)" no "too deep"
is "$(allowed beta)" no "no slash"

exit "$FAILED"
