#!/usr/bin/env bash
# Back up the game's save data (worlds, accounts, snapshots) into a dated
# tarball, and keep the newest N. Snapshots protect against bad edits; this
# protects against the disk itself dying — point EVANS_BACKUP_DIR at another
# drive or machine if you can.
#
# Run it nightly with cron:
#   0 3 * * *  /path/to/EvansGame/tools/backup.sh
#
# Or with a systemd timer alongside the game service (see tools/evansgame.service).
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_DIR="${EVANS_DATA_DIR:-data}"
BACKUP_DIR="${EVANS_BACKUP_DIR:-backups}"
KEEP="${EVANS_BACKUP_KEEP:-14}"

if [ ! -d "$DATA_DIR" ]; then
  echo "nothing to back up: $DATA_DIR does not exist" >&2
  exit 0
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/evans-data-$STAMP.tar.gz"
tar -czf "$OUT" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"

# Keep only the newest $KEEP backups.
ls -1t "$BACKUP_DIR"/evans-data-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

echo "backed up $DATA_DIR -> $OUT ($(du -h "$OUT" | cut -f1))"
