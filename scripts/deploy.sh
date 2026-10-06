#!/usr/bin/env bash
# Deploys the current branch on the EC2 host (ADR-0025, Requirement 20.5):
#   git pull → build → migrate → up -d → wait for healthchecks.
# On failure prints container status and recent logs, then exits non-zero.
#
# Usage: scripts/deploy.sh [--no-pull]
#   --no-pull   deploy the working tree as-is (e.g. after a manual checkout)

set -Eeuo pipefail

cd "$(dirname "$0")/.."

PULL=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    -h | --help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

COMPOSE=(docker compose -f docker-compose.prod.yml)
WAIT_TIMEOUT="${DEPLOY_WAIT_TIMEOUT:-180}"

step() { printf '\n==> %s\n' "$*"; }

on_error() {
  local code=$?
  # errtrace (-E) also fires this in $(...) subshells; report once, from the main shell.
  ((BASH_SUBSHELL == 0)) || exit "$code"
  step "Deploy FAILED (exit $code)"
  "${COMPOSE[@]}" ps -a || true
  "${COMPOSE[@]}" logs --no-color --tail=100 || true
  exit "$code"
}
trap on_error ERR

[[ -f .env ]] || { echo ".env not found; copy .env.example and fill it in" >&2; exit 1; }

if ((PULL)); then
  step "git pull"
  git pull --ff-only
fi
step "Deploying $(git rev-parse --short HEAD)"

step "Build images"
"${COMPOSE[@]}" build

step "Run migrations"
"${COMPOSE[@]}" run --rm worker migrate

step "Start services"
"${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout "$WAIT_TIMEOUT"

"${COMPOSE[@]}" ps
step "Deploy OK"
