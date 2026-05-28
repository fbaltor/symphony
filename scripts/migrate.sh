#!/usr/bin/env bash
# Apply src/audit/schema.sql against $DATABASE_URL.

set -euo pipefail

DATABASE_URL=${DATABASE_URL:-}
if [[ -z "${DATABASE_URL}" ]]; then
  echo "[symphony/migrate] DATABASE_URL is required" >&2
  exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
SCHEMA="${REPO_ROOT}/independent/symphony/src/audit/schema.sql"

if ! command -v psql >/dev/null 2>&1; then
  echo "[symphony/migrate] psql not found in PATH" >&2
  exit 1
fi

echo "[symphony/migrate] applying ${SCHEMA}"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${SCHEMA}"
echo "[symphony/migrate] done"
