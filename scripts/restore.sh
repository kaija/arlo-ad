#!/usr/bin/env bash
# Restores the production database from a backup made by backup.sh (ADR-0025).
#
# Usage: scripts/restore.sh <s3 key | s3://bucket/key | local .dump.gz> [--yes] [--keep-services]
#   List backups:  aws s3 ls "s3://$BACKUP_S3_BUCKET/postgres/"
#
# The dump is restored into a new database first; only if that succeeds are web/worker
# stopped and the databases swapped by rename. The previous database is kept as
# <db>_pre_restore_<timestamp> for you to drop once the restore is verified.

set -Eeuo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/pg-ops.sh
source scripts/lib/pg-ops.sh

SOURCE="" YES=0 STOP_SERVICES=1
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --keep-services) STOP_SERVICES=0 ;;
    -h | --help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    -*)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
    *) SOURCE=$arg ;;
  esac
done
[[ -n "$SOURCE" ]] || { sed -n '4,5p' "$0" >&2; exit 2; }

COMPOSE=(docker compose -f docker-compose.prod.yml)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGING_DB="${PG_DB}_restore_${STAMP}"
PREVIOUS_DB="${PG_DB}_pre_restore_${STAMP}"
TMP=$(mktemp -d)
STOPPED=0

cleanup() {
  local code=$?
  rm -rf "$TMP"
  if ((code != 0)); then
    psql_on postgres -c "DROP DATABASE IF EXISTS \"$STAGING_DB\" WITH (FORCE)" || true
  fi
  if ((STOPPED)); then
    "${COMPOSE[@]}" start web worker || true
  fi
}
trap cleanup EXIT

if [[ -f "$SOURCE" ]]; then
  FILE=$SOURCE
else
  [[ "$SOURCE" == s3://* ]] || SOURCE="s3://$(require_config BACKUP_S3_BUCKET)/$SOURCE"
  FILE="$TMP/backup.dump.gz"
  echo "==> Downloading $SOURCE"
  aws_cli s3 cp --only-show-errors "$SOURCE" "$FILE"
fi
gunzip -t "$FILE"

if ((!YES)); then
  echo "This replaces database '$PG_DB' with $SOURCE."
  read -r -p "Type the database name to continue: " answer
  [[ "$answer" == "$PG_DB" ]] || { echo "aborted"; exit 1; }
fi

echo "==> Restoring into staging database $STAGING_DB"
psql_on postgres -c "CREATE DATABASE \"$STAGING_DB\""
gunzip -c "$FILE" | pg pg_restore --no-owner --exit-on-error --single-transaction -U "$PG_USER" -d "$STAGING_DB"

if ((STOP_SERVICES)); then
  echo "==> Stopping web and worker"
  "${COMPOSE[@]}" stop web worker
  STOPPED=1
fi

echo "==> Swapping databases"
psql_on postgres -1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$PG_DB' AND pid <> pg_backend_pid();
ALTER DATABASE "$PG_DB" RENAME TO "$PREVIOUS_DB";
ALTER DATABASE "$STAGING_DB" RENAME TO "$PG_DB";
SQL

echo "==> Restore complete. Previous database kept as $PREVIOUS_DB; after verifying, drop it with:"
echo "    ${COMPOSE[*]} exec -T postgres psql -U $PG_USER -d postgres -c 'DROP DATABASE \"$PREVIOUS_DB\"'"
