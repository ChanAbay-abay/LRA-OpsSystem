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

A fourth, from the other direction — a check that would have reported a **false pass/fail** on
security policy. This query, written to confirm every write policy guards on `is_read_only`:

```sql
(qual::text || coalesce(with_check::text,'')) like '%is_read_only%'
```

returns `NULL` for every INSERT policy, because INSERT policies have `qual = NULL` and
`NULL || anything` is NULL in SQL. The guard was present; the check could not see it. Correct
form is `coalesce(qual::text,'') || coalesce(with_check::text,'')`.

**Do:** before reporting a negative, prove the instrument can produce a positive. When
auditing security policy, run the check against a case you know is guarded AND one you know
is not, and confirm it separates them. State plainly which findings were reproduced and which
were reasoned.

---

## 5. Guard by the rule, not by a list of states

**2026-09-10.** `seed-demo.mjs` crashed partway through a re-run because `flagCancellation`
skipped by enumerating `pending_cancellation` and `cancelled`, but the database also freezes
`cleared` tasks. The guard listed the states someone remembered instead of expressing the
actual rule.

**Do:** mirror the database's own condition (here: "terminal tasks are frozen"). The same
principle is why `lib/task-permissions.ts` mirrors the transition ladder rather than
re-deriving it per component — and why it may be **stricter** than the database, never looser.

---

## 6. A refusal on one rung is not proof that no path exists

**2026-09-10.** An agent reported that the founder's own recurring task "has no route to
`cleared` at all." Driving the real ladder over HTTP proved otherwise: submitted by the
founder, verified by the **GM**, cleared by the founder — 200 at every step, 3 points, 3
ledger rows. The agent had almost certainly tried founder-verifies-own-task, been correctly
refused, and generalised from that one refusal.

The rung it missed: `submitted -> verified` branches on whether the *owner* is a GM. The
founder is not, so the requirement is a `core.is_gm()` caller who is not the owner — which a
GM satisfies. And `verified -> cleared` has no owner-is-not-caller check at all.

**Do:** before reporting a deadlock, enumerate every actor who could satisfy the blocked rung
and try each one. Report "X cannot do this" rather than "this is impossible" unless you have
actually tried the alternatives.

**Do not dismiss such reports either** — commit 52e00ea fixed a case where three rules really
did deadlock. That is precisely why the claim was worth checking instead of believing or
ignoring.

---

## 7. A trigger can trip its own guard

**2026-09-10.** The cycle-time migration added `first_in_progress_at`, stamped by
`ops.enforce_task_transition` on the first move into `in_progress`, plus a forgery guard
refusing any client write to that column:

```sql
new.first_in_progress_at := now();          -- the trigger's own stamp
...
if new.first_in_progress_at is distinct from old.first_in_progress_at then
  raise exception '... is a server-derived stamp and cannot be changed';
```

The guard cannot tell the trigger's own assignment from a client's. So **every real user's
`todo -> in_progress` move raised**, and starting a task would have been impossible for
everyone except system and admin callers. The fix is a local flag (`v_stamped`) set where the
trigger stamps, and consulted by the guard.

The pattern generalises: whenever a trigger both **writes** a protected column and **guards**
that column against writes, the guard must distinguish its own write. Comparing `new` to `old`
cannot do that, because by then the trigger's own assignment is already in `new`.

**What actually caught it:** the RLS suite, on the assertion that *staff CAN still move a
locked committed task's status* — an **allow** test, not a refusal test. A suite made only of
"this must be refused" assertions would have gone green while the app was unusable.

**Do:** run the suite against the database **before** treating a migration as landed, not
after. This migration was reviewed by two agents and read as correct by both; it took
execution to find it.

---

## 8. A test fixture that is subtly wrong hides the assertions you add later

**2026-09-10.** `rls_test.sql` built its personas with

```sql
(case when k in ('sales','broker') then k else 'other' end)::core.position
```

so the **`gm` persona carried `position = 'other'`**. The transition trigger decides "is this
task GM-owned?" from the membership *position*, not from authority — so every assertion
touching a GM-owned task had silently been exercising the wrong branch of the verify rung.

It went unnoticed for 124 assertions because none of them depended on GM-owned semantics. The
settlement-forgery tests added later did, and three failed at once. The natural reading of
"three new tests fail" is "the new migration is broken" — the migration was fine.

**Do:** when new assertions fail in a cluster, check whether they are the *first* to depend on
some property of the fixture. A fixture bug and a product bug present identically; the
difference is whether older tests were ever exercising the thing at all.

---

## 9. Cleaning up "residue" can destroy real fixtures

**2026-09-10.** Adversarial testing left tasks with names like `HIST-301` and `(RENAMED)`
titles in the demo project. Deleting them looked like tidying. One of them was a legitimate
seeded history task that an aborted run had left uncommitted — removing it made the seed
recreate it, into a week that was by then `closed`, where committing is refused. The seed then
aborted, twice.

**Do:** before deleting data that looks like debris, check whether something generates it. If a
script would recreate it, deleting is not cleanup — it is a loop. Fix the generator first.

The generator bug here was itself lesson §5 again: `seedHistory` guarded idempotency by asking
"is this task already committed?" instead of the database's actual rule, "can this week take a
commitment at all?" An already-closed history week is the finished artifact and must be skipped
whole.
