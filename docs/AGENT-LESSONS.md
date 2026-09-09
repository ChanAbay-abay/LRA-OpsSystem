# Agent lessons — LRA Ops

Concrete lessons from real failures in this repo. Written to be actionable, not
retrospective. Add to it when something actually goes wrong; delete an entry only when it
stops being true.

---

## 1. Never `git add -A` while a subagent is working

**2026-09-10.** The orchestrator committed twice with `git add -A` while a coder agent was
mid-edit on the web app. Both commits swallowed that agent's in-progress files, so a commit
titled "Schedule the 14-day purge" also contained the entire read-only client plumbing, and
the commit recording Chan's asks contained sidebar and briefing gating.

Nothing was lost and the tests stayed green, but the history lied — and history is the only
place a reviewer can see *why* a change was made.

**Do:** stage explicit paths (`git add supabase/migrations/x.sql apps/api/...`) whenever any
agent may be writing. `git add -A` is only safe when you are certain you are alone in the
tree.

**If it already happened:** it is recoverable while nothing is pushed. Tag the tip as a
safety net, `git reset --soft <base>`, unstage, then re-commit by explicit path in logical
groups. Verify with `git diff --stat <tag> HEAD` — empty output means the tree is
byte-identical and only the history changed. Then delete the tag.

---

## 2. The RLS suite cannot run in the Supabase web SQL editor

**2026-09-10.** Pasting `supabase/tests/rls_test.sql` into the dashboard editor fails with
`relation "t_results" does not exist`. The editor splits a pasted script into separate
statements and the suite's temp tables do not survive the split. **The suite is not broken.**

**Do:** `psql "$DATABASE_URL" -f supabase/tests/rls_test.sql`, or a single Supabase MCP
`execute_sql` call containing the entire file verbatim — one call is one session, so the temp
tables hold. Baseline as of 2026-09-10: **109 passed / 0 failed**, verdict
`ALL PASS (canary correctly failed)`.

---

## 3. A migration applied by hand is invisible to the migration ledger

**2026-09-10.** Two migrations pasted into the SQL editor changed the schema but left no row
in `supabase_migrations.schema_migrations`. A later `db push` would have tried to apply them
again. Separately, a migration created through the MCP tooling was stamped with a timestamp
that sorted *before* the migration defining the function it referenced — a fresh `db reset`
would have failed on it.

**Do:** after any out-of-band schema change, record it in the ledger, and check that new
versions sort after everything they depend on. `mcp__supabase__list_migrations` against the
repo's `supabase/migrations/` listing is the check.

---

## 4. Verify your instrumentation before believing a negative result

**2026-09-09 / 10.** Three separate "defects" found during verification were measurement
errors, not code faults:

- A leaderboard access rule looked broken because the check printed `len(response['data'])`
  — and `data` is an object with four keys, so it printed 4 regardless of how many rows came
  back. Counting `data['rows']` showed correct behaviour.
- A regex audit reported 17 unguarded security-definer functions; it had broken on
  `returns table (...)`. The real count was one, and that one was unreachable.
- A `/set-password` run showed "server can't be reached", which looked like a product bug. It
  was a deliberately non-standard dev port fighting `CORS_ORIGIN`.

**Do:** before reporting a negative, prove the instrument can produce a positive. State
plainly which findings were reproduced and which were reasoned.

---

## 5. Guard by the rule, not by a list of states

**2026-09-10.** `seed-demo.mjs` crashed partway through a re-run because `flagCancellation`
skipped by enumerating `pending_cancellation` and `cancelled`, but the database also freezes
`cleared` tasks. The guard listed the states someone remembered instead of expressing the
actual rule.

**Do:** mirror the database's own condition (here: "terminal tasks are frozen"). The same
principle is why `lib/task-permissions.ts` mirrors the transition ladder rather than
re-deriving it per component — and why it may be **stricter** than the database, never looser.
