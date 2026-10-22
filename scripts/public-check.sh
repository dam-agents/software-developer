#!/usr/bin/env bash
# public-check.sh [file…] — exit 1 when a text bound for GitHub holds a private shape. app/src/developer/public.ts.
exec "$BASH" "$(dirname "$0")/../bin/sd" public-check "$@"
