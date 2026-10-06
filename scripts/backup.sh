#!/usr/bin/env bash
# Backs up the production database to S3 (ADR-0025, Requirement 20.4):
#   pg_dump -Fc → gzip → verify with pg_restore --list → aws s3 cp.
# Any failure posts to SLACK_OPS_WEBHOOK_URL and exits non-zero.
#
# Settings (environment or .env): BACKUP_S3_BUCKET (required), SLACK_OPS_WEBHOOK_URL,
# BACKUP_S3_PREFIX (default postgres). See scripts/lib/pg-ops.sh for test overrides.
#
# Daily cron on the EC2 host:
#   15 3 * * * /opt/arlo/scripts/backup.sh >> /var/log/arlo-backup.log 2>&1
# 30-day retention is an S3 lifecycle rule, applied once:
#   aws s3api put-bucket-lifecycle-configuration --bucket "$BACKUP_S3_BUCKET" \
#     --lifecycle-configuration file://infra/s3/backup-lifecycle.json

set -Eeuo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/pg-ops.sh
source scripts/lib/pg-ops.sh

STEP='init'
on_error() {
  local code=$?
  # errtrace (-E) also fires this in $(...) subshells; report once, from the main shell.
  ((BASH_SUBSHELL == 0)) || exit "$code"
  echo "backup failed at step '$STEP' (exit $code)" >&2
  notify_ops ":rotating_light: Arlo DB backup failed on $(hostname) at step '$STEP' (exit $code)"
  exit "$code"
}
trap on_error ERR

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

STEP='config'
BUCKET=$(require_config BACKUP_S3_BUCKET)
PREFIX=$(config_value BACKUP_S3_PREFIX)
PREFIX=${PREFIX:-postgres}
KEY="$PREFIX/$PG_DB-$(date -u +%Y%m%dT%H%M%SZ).dump.gz"
FILE="$TMP/backup.dump"

STEP='dump'
pg pg_dump -Fc -U "$PG_USER" -d "$PG_DB" >"$FILE"

STEP='compress'
gzip "$FILE"
FILE="$FILE.gz"

# Guards against uploading a truncated archive that would only fail at restore time.
STEP='verify'
gunzip -c "$FILE" | pg pg_restore --list >/dev/null

STEP='upload'
aws_cli s3 cp --only-show-errors "$FILE" "s3://$BUCKET/$KEY"

echo "backup uploaded: s3://$BUCKET/$KEY ($(wc -c <"$FILE" | tr -d ' ') bytes)"
