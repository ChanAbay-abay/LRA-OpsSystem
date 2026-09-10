#!/usr/bin/env bash
# Run the RLS and write-path regression suite against the database.
#
#   DATABASE_URL=postgresql://... ./scripts/run-rls-tests.sh
#
# Or put DATABASE_URL in apps/api/.env (gitignored) and just run
# `npm run test:rls` -- this script reads that file when the variable is
# not already in the environment. An explicit DATABASE_URL always wins.
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

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# `apps/api/.env` holds the SUPABASE_* keys, which are the REST API and
# are NOT a Postgres connection -- psql cannot use them. DATABASE_URL is
# a separate thing and nothing was reading it from disk, so
# `npm run test:rls` failed on a clean shell every single time and the
# suite got run by hand or not at all. Read it here, only when the
# environment has not already supplied one, and only that one variable:
# sourcing the whole file would drag SUPABASE_SERVICE_ROLE_KEY into the
# environment of a script that has no business holding it.
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ROOT/apps/api/.env" ]; then
  # Last assignment wins, quotes stripped, `export ` prefix tolerated,
  # commented-out lines ignored.
  #
  # POSIX BREs only: macOS ships BSD sed, which does NOT understand the
  # GNU `\+` and `\?` extensions. A first attempt used them, matched
  # nothing, and reported "apps/api/.env does not define one" for a file
  # that plainly did -- caught only because this was tested against a
  # fixture instead of being assumed to work.
  DATABASE_URL="$(
    sed -e 's/^[[:space:]]*export[[:space:]][[:space:]]*//' "$ROOT/apps/api/.env" \
      | sed -n 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*//p' \
      | tail -n 1 \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
  )"
  [ -n "$DATABASE_URL" ] && export DATABASE_URL
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set, and apps/api/.env does not define one." >&2
  echo >&2
  echo "The SUPABASE_URL / SUPABASE_*_KEY values in that file are the REST API," >&2
  echo "not a Postgres connection -- psql cannot use them. You need the database" >&2
  echo "connection string, which is a different thing:" >&2
  echo >&2
  echo "  Local (preferred for a test run): supabase start, then use the string it" >&2
  echo "  prints -- postgresql://postgres:postgres@127.0.0.1:54322/postgres" >&2
  echo >&2
  echo "  Live project: Supabase dashboard -> Project Settings -> Database ->" >&2
  echo "  Connection string -> URI. Add it to apps/api/.env (gitignored) as" >&2
  echo "  DATABASE_URL=... and this script will pick it up from then on." >&2
  echo >&2
  echo "  URL-ENCODE the password. A '!' must be written %21, '@' as %40, '#' as" >&2
  echo "  %23 -- an un-encoded special character truncates the URL and the failure" >&2
  echo "  reads as a wrong password rather than a malformed string." >&2
  echo >&2
  echo "The suite runs inside a transaction it rolls back, so pointing it at the" >&2
  echo "live database writes nothing -- but a canary MUST fail for the run to mean" >&2
  echo "anything, and that is checked below." >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `set -e` (line 13) aborts on a failed command substitution in an
# assignment, and it does so BEFORE the `echo "$OUT"` below ever runs --
# verified by `sh -c 'set -e; OUT="$(false 2>&1)"; echo REACHED'`, which
# prints nothing and exits 1. So a psql that could not connect killed
# this script silently: no host, no auth error, no hint, just a non-zero
# status and an empty terminal, which reads as a hang rather than a
# failure. `|| rc=$?` keeps psql's own diagnostics and prints them.
rc=0

# Say what is about to happen, and where. The whole run is captured into
# `$OUT` -- the canary check below greps it -- so absolutely nothing
# reaches the terminal until psql exits. That takes ~25s against the
# pooler, during which a correct run and a wedged connection look
# identical: a blank terminal. It got interrupted mid-run for exactly
# that reason. Host only, never the password.
echo "Running the RLS suite against ${DATABASE_URL##*@}" >&2
echo "(~25s against a remote database, and nothing prints until it finishes)" >&2

OUT="$("$PSQL" "$DATABASE_URL" -q -f "$HERE/supabase/tests/rls_test.sql" 2>&1)" || rc=$?

# psql echoes a result set for EVERY `select pg_temp.expect_*()` call --
# some 200 four-line blocks reading `expect_allowed / (1 row)`, carrying
# no information, ahead of the two tables that carry all of it. By
# default print from the report header onward; RLS_VERBOSE=1 prints the
# lot. On a run that never reached the report, print everything, because
# then the noise IS the diagnostic.
if [ "${RLS_VERBOSE:-}" = "1" ] || ! printf '%s\n' "$OUT" | grep -q '^ *area *|'; then
  printf '%s\n' "$OUT"
else
  printf '%s\n' "$OUT" | sed -n '/^ *area *|/,$p'
fi

# A suite that ran and failed says so below, and its own message is the
# better one -- so only speak up here when psql died before producing a
# verdict at all.
if [ "$rc" -ne 0 ] && ! echo "$OUT" | grep -q "verdict"; then
  echo >&2
  echo "FAIL: psql exited $rc without running the suite -- the output above is its own error." >&2
  echo "Usually the connection string: check the host, the port, and that the password is URL-encoded." >&2
  exit "$rc"
fi

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
