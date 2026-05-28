#!/usr/bin/env bash
# Local dev runner for Symphony.
#
# Loads .env, optionally pulls secrets via gcloud, then runs `pnpm dev`.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${LINEAR_API_KEY:?set LINEAR_API_KEY in .env}"
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY in .env}"
: "${DATABASE_URL:?set DATABASE_URL in .env}"

WORKFLOW_PATH=${SYMPHONY_WORKFLOW_PATH:-./WORKFLOW.md}

echo "[symphony/dev] launching with workflow=${WORKFLOW_PATH}"
exec pnpm dev -- "${WORKFLOW_PATH}"
