#!/usr/bin/env bash
# repo-allowed.sh <owner/name> — exit 0 when the direct session may act on the
# repository (`repo`, or one `repos_also` names), 1 when not, and says which.
# Run it before the first clone, push, issue or comment anywhere but `repo`.
set -uo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib/config.sh"

[ $# -eq 1 ] || { echo "usage: repo-allowed.sh <owner/name>" >&2; exit 2; }
if cfg_allows "$1"; then
  echo "allowed: $1"
else
  echo "not allowed: $1 — neither \`repo\` nor named by \`repos_also\` in work/CONFIG.md" >&2
  exit 1
fi
