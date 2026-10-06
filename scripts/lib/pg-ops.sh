# shellcheck shell=bash
# Shared helpers for backup.sh and restore.sh. Source after `cd` to the repo root.
#
# Overridable through the environment (used by tests/backup-restore.test.ts):
#   ENV_FILE  file to read settings from when not set in the environment (default .env)
#   PG_EXEC   command prefix that runs a program inside the Postgres container
#   AWS_CLI   AWS CLI command (default aws; the host's IAM role grants bucket access)
#   PG_USER / PG_DB   database role and name (default arlo / arlo)

ENV_FILE="${ENV_FILE:-.env}"
PG_USER="${PG_USER:-arlo}"
PG_DB="${PG_DB:-arlo}"
read -r -a PG_EXEC_CMD <<<"${PG_EXEC:-docker compose -f docker-compose.prod.yml exec -T postgres}"
read -r -a AWS_CMD <<<"${AWS_CLI:-aws}"

# Prints KEY from the environment, else from ENV_FILE. The file is parsed, never sourced:
# values such as GA4_SERVICE_ACCOUNT_JSON are not valid shell.
config_value() {
  local key=$1 line
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return
  fi
  [[ -f "$ENV_FILE" ]] || return 0
  line=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1) || true
  line=${line#*=}
  line=${line%$'\r'}
  if [[ $line =~ ^\"(.*)\"$ || $line =~ ^\'(.*)\'$ ]]; then
    line=${BASH_REMATCH[1]}
  fi
  printf '%s' "$line"
}

require_config() {
  local value
  value=$(config_value "$1")
  [[ -n "$value" ]] || { echo "$1 is not set (environment or $ENV_FILE)" >&2; return 1; }
  printf '%s' "$value"
}

pg() { "${PG_EXEC_CMD[@]}" "$@"; }
psql_on() { local db=$1; shift; pg psql -X -q -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$db" "$@"; }
aws_cli() { "${AWS_CMD[@]}" "$@"; }

# Posts a message to the Slack ops incoming webhook, if configured. Never fails the caller.
notify_ops() {
  local text=$1 url
  url=$(config_value SLACK_OPS_WEBHOOK_URL)
  if [[ -z "$url" ]]; then
    echo "SLACK_OPS_WEBHOOK_URL not set; skipping notification" >&2
    return 0
  fi
  text=${text//\\/\\\\}
  text=${text//\"/\\\"}
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' --data "{\"text\":\"$text\"}" "$url" >/dev/null ||
    echo "failed to send Slack notification" >&2
}
