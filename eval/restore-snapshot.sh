#!/usr/bin/env bash
# eval/restore-snapshot.sh
#
# Build the deterministic eval environment: a frozen snapshot of the live
# `memento` corpus restored into an isolated `memento_eval` DB + a fresh Redis
# L1 index rebuilt from that snapshot. Run this before EVERY eval pass (and
# before every repeat in a variance run) so read-mutations / adaptor learning
# never carry across runs. See eval design v2.1 §5 / §9.
#
# Safe by construction: pg_dump reads live read-only; memento_eval is dropped &
# recreated; Redis ops target db index 15 only (never live db 0).
#
# Requires: PGPASSWORD exported. Postgres 127.0.0.1:5432 user postgres.

set -euo pipefail

LIVE_DB="memento"
EVAL_DB="memento_eval"
SCHEMA="agent_memory"
HOST="127.0.0.1"
PGUSER_="postgres"
REDIS_DB_IDX="${REDIS_DB:-15}"
DUMP_DIR="$(dirname "$0")/tmp"
DUMP_FILE="${DUMP_DIR}/memento_snapshot.sql"

if [ -z "${PGPASSWORD:-}" ]; then
  echo "ERROR: PGPASSWORD not set (needed for pg_dump/psql)." >&2
  exit 1
fi

mkdir -p "${DUMP_DIR}"

echo "=== [1/6] pg_dump live ${LIVE_DB} (schema ${SCHEMA}, read-only) ==="
pg_dump --schema="${SCHEMA}" --no-owner --no-privileges \
  -h "${HOST}" -U "${PGUSER_}" "${LIVE_DB}" > "${DUMP_FILE}"
echo "      dump: ${DUMP_FILE} ($(wc -l < "${DUMP_FILE}") lines)"

echo "=== [2/6] drop & recreate ${EVAL_DB} ==="
dropdb --if-exists -h "${HOST}" -U "${PGUSER_}" "${EVAL_DB}"
createdb -h "${HOST}" -U "${PGUSER_}" "${EVAL_DB}"

echo "=== [3/6] CREATE EXTENSION vector on ${EVAL_DB} (vector type needed pre-restore) ==="
psql -q -h "${HOST}" -U "${PGUSER_}" -d "${EVAL_DB}" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "=== [4/6] restore snapshot into ${EVAL_DB} ==="
psql -q -v ON_ERROR_STOP=1 -h "${HOST}" -U "${PGUSER_}" -d "${EVAL_DB}" -f "${DUMP_FILE}"
FRAG_COUNT=$(psql -tA -h "${HOST}" -U "${PGUSER_}" -d "${EVAL_DB}" \
  -c "SELECT count(*) FROM ${SCHEMA}.fragments WHERE valid_to IS NULL;")
echo "      restored active fragments: ${FRAG_COUNT}"

echo "=== [4b/6] apply migration-038 (morpheme_dict dim 1536->1024) to ${EVAL_DB} ==="
# The live dump carries the stale vector(1536) morpheme_dict; fix it post-restore
# so the L3 morpheme sub-path works (derived cache, lazily repopulated).
psql -q -v ON_ERROR_STOP=1 -h "${HOST}" -U "${PGUSER_}" -d "${EVAL_DB}" \
  -f "$(dirname "$0")/../lib/memory/migration-038-morpheme-dict-dim-fix.sql"

echo "=== [5/6] FLUSH eval Redis db ${REDIS_DB_IDX} (never db 0) ==="
redis-cli -n "${REDIS_DB_IDX}" FLUSHDB

echo "=== [6/6] rebuild Redis L1 from restored ${EVAL_DB} ==="
POSTGRES_DB="${EVAL_DB}" REDIS_DB="${REDIS_DB_IDX}" \
  node "$(dirname "$0")/rebuild-redis-l1.mjs"

echo "=== restore + rebuild complete (eval DB=${EVAL_DB}, redis db=${REDIS_DB_IDX}) ==="
