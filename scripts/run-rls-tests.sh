#!/usr/bin/env bash
# Run the RLS and write-path regression suite against the database.
#
#   DATABASE_URL=postgresql://... ./scripts/run-rls-tests.sh
#
# Everything runs inside a transaction that is rolled back, so it is
# safe against a live database, though a scratch one (via
# `supabase start`) is what CI and local development should use.
#
# Exits non-zero if any test fails OR if the canary passes -- a canary
# that passes means the suite is not exercising RLS and every result is
# void.
set -euo pipefail

PSQL="${PSQL:-psql}"
command -v "$PSQL" >/dev/null 2>&1 || PSQL=/opt/homebrew/opt/libpq/bin/psql

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set." >&2
  echo "For local development: supabase start, then use the connection string it prints" >&2
  echo "(default: postgresql://postgres:postgres@127.0.0.1:54322/postgres)." >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$("$PSQL" "$DATABASE_URL" -q -f "$HERE/supabase/tests/rls_test.sql" 2>&1)"
echo "$OUT"

if echo "$OUT" | grep -q "BROKEN: canary passed"; then
  echo >&2
  echo "FAIL: the canary passed, so this suite is not testing RLS." >&2
  exit 1
fi
if echo "$OUT" | grep -q "ALL PASS (canary correctly failed)"; then
  echo
  echo "OK: all RLS regression tests passed."
  exit 0
fi
echo >&2
echo "FAIL: one or more RLS regression tests failed." >&2
exit 1
