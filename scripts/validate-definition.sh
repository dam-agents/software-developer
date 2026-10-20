#!/usr/bin/env bash
# validate-definition.sh [dir] — read-only structural validation of this definition.
# app/src/factory/validate.ts.
exec "$BASH" "$(dirname "$0")/../bin/sd" validate-definition "$@"
