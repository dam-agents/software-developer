#!/usr/bin/env bash
# work-backup.sh persist|restore — work/ to and from `work_repo` (docs/persistence.md → Backup).
# app/src/developer/backup.ts.
exec "$BASH" "$(dirname "$0")/../bin/sd" work-backup "$@"
