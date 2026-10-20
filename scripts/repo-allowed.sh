#!/usr/bin/env bash
# repo-allowed.sh <owner/name> — exit 0 when the repository is `repo` or one `repos_also` names.
# Run it before the first clone, push, issue or comment anywhere but `repo`.
exec "$BASH" "$(dirname "$0")/../bin/sd" repo-allowed "$@"
