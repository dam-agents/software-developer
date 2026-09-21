#!/usr/bin/env bash
# Runs once, in ~/work, right after the agent is created and before its first
# session opens. Keep it short: it has a 15-minute ceiling and the onboarding
# conversation waits behind it. Anything slow belongs in the first tick, where
# it is visible and can be retried — the toolchain installs itself on first use
# anyway.
set -euo pipefail

REPO="${SOFTWARE_DEVELOPER_REPO:-dam-agents/dam}"
DEST="$HOME/work/$(basename "$REPO")"

if [ ! -d "$DEST/.git" ]; then
  echo "Cloning $REPO into $DEST"
  git clone --filter=blob:none "https://github.com/$REPO" "$DEST"
fi

# mise refuses to read a config directory it has not been told to trust, and the
# first run that hits one would otherwise stop to ask.
mise trust "$DEST" >/dev/null 2>&1 || true

echo "Bootstrap done. The repository is at $DEST."
