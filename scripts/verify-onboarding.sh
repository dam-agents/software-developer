#!/usr/bin/env bash
# verify-onboarding.sh [--config|--live] — does this instance have the shape onboarding
# promises? Every FAIL names its fix. app/src/developer/verify.ts.
exec "$BASH" "$(dirname "$0")/../bin/sd" verify "$@"
