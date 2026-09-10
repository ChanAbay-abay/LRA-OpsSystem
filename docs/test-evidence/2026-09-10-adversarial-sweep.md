# Adversarial sweep — everything except the Monday lock and GM edit requests

**2026-09-10, run by the tester against the LIVE project** (ref `ttrjzyyuktropkufkcoj`), straight
at PostgREST with real user JWTs obtained via `POST /auth/v1/token?grant_type=password` for
`founder-demo`, `gm-demo`, `sales-demo`, `broker-demo`, `erc-demo`, `dca-demo`. Scope: the
approval ladder, the points ledger, commitments/briefing, weeks, blocks, the catalog, soft
delete/purge, scoreboard visibility, and cross-account reads — everything the 2026-09-10 lock/
edit-request pass did not already cover. `apps/api` / `apps/web` dev servers were **not**
started: ports 5173/3099 already had a live Vite process and an unrelated process bound,
apparently from a concurrent session, so I did not touch them per the concurrency-hygiene rule
and worked entirely against PostgREST + source reading instead. That is a real gap, noted below.

## Verdict
**FIX FIRST** — the core approval ladder, ledger append-only guarantee, catalog snapshot, week/
briefing idempotency, and commitment lock all held under direct attack. But three real defects
were found and reproduced live: a self-referencing RLS policy that 500s on every read of
`core.memberships`, a founder's ability to forge a non-null `points_awarded` on a task that was
never cleared (and have it survive rejection and rework), and a fully client-controlled
`created_at`/`resolved_at` on `ops.task_blocks` that lets anyone fabricate blocked-time history
for money-adjacent metrics. None of these are exploitable for a founder-free points grant, but
the second and third let people lie to the system's own book of record, which is the entire
point of this product.

## What I ran
```
curl -X POST {SUPABASE_URL}/auth/v1/token?grant_type=password  (x6 personas, anon key)
curl against {SUPABASE_URL}/rest/v1/... with Accept-Profile/Content-Profile: core|ops
  and each persona's bearer token (~60 requests total, see below for the ones that mattered)
Direct reads of supabase/migrations/*.sql to get ground truth for every trigger/policy
  before attacking it live, rather than guessing at behaviour.
```
No local dev server was started (see gap above); `npm run test:rls` / unit suites were not
re-run in this pass since the scope was live-database attack, and the baseline
(109 passed / 0 failed, canary correctly failed) was already established the same day per
`docs/AGENT-LESSONS.md` §2.

## Defects

### [Major] `core.memberships` SELECT policy is self-referential and 500s for every caller
- **Where:** `supabase/migrations/20260908120400_core_ops_rls.sql:100-108` (policy body
  reproduced verbatim by `20260910090000_core_soft_delete_accounts.sql:309-320`)
- **Repro:**
  1. Get any persona's JWT (tried founder, gm, broker — all identical).
  2. `GET {SUPABASE_URL}/rest/v1/memberships?select=*` with `Accept-Profile: core`,
     `apikey: <anon>`, `Authorization: Bearer <persona token>`.
- **Expected:** the caller's own visible slice of the roster (RLS says "any active member
  reads").
- **Actual:** `500 {"code":"42P17","message":"infinite recursion detected in policy for
  relation \"memberships\""}` — for founder, gm, and broker alike (I confirmed all three, not
  just one, to rule out a persona-specific quirk).
- **Why it matters:** the policy's `using` clause does `exists (select 1 from core.memberships
  caller where caller.user_id = auth_user_id() and caller.is_active)` — a raw, RLS-checked
  subquery on the very table the policy protects, instead of routing through a
  `security definer` helper the way every other cross-table check in this codebase does
  (`core.is_member()`, `core.is_admin()`, etc. — the exact pattern this migration set claims to
  follow). Postgres re-evaluates the same policy recursively and never terminates.
  **Current blast radius is zero** because every server-side read of `core.memberships` in
  `apps/api` goes through `serviceClient()` (`apps/api/src/lib/roster.ts`,
  `apps/api/src/lib/supabase.ts:143`, `apps/api/src/routes/admin.ts`,
  `apps/api/src/routes/tasks.ts:152`), which bypasses RLS entirely and never hits this path —
  confirmed by reading every call site. But it means the RLS policy on this table is not
  actually enforceable for anyone reaching it directly (the exact "PostgREST is reachable
  without the API" attack surface this sweep was asked to use), and it is a landmine for any
  future direct client read (a report, a mobile client, a webhook) that forgets to route
  through the service role.
- **Confidence:** verified live, reproduced 3x across personas.

### [High] A founder can forge `points_awarded` on a task that was never cleared, and it survives rejection and rework
- **Where:** `supabase/migrations/20260910120100_core_read_only_accounts.sql` (live
  `ops.enforce_task_transition()`, the "status unchanged" branch at the block starting
  `if new.status = old.status then ... return new; end if;`), same shape as originally shipped
  in `20260909090200_ops_task_state_machine.sql:148-152`.
- **Repro (all as real user JWTs, task `5b06893d-...`/`a1ec6bfa-...`-style probe, since deleted):**
  1. `broker-demo` creates a task, moves it to `submitted`.
  2. `gm-demo` verifies it (`submitted -> verified`) — legitimate.
  3. `founder-demo` sends `PATCH .../tasks?id=eq.<id>` with body `{"points_awarded": 999}` and
     **no status field** (status stays `verified`).
  4. Response: `200`, 1 row, `points_awarded` is now `999` on a task that is still `verified`,
     i.e. not cleared.
  5. `founder-demo` then rejects the task (`verified -> rejected`, with a valid reason).
     `points_awarded` is still `999` on the now-`rejected` task.
  6. `broker-demo` reworks it (`rejected -> todo`, the owner's normal right). `points_awarded`
     is **still `999`** on a plain `todo` task.
- **Expected (per PLAN.md §2.4):** "`points_awarded` — written by the trigger at `cleared`
  **only**, derived, never accepted from the client." A task that has never cleared should
  never carry a non-null `points_awarded`, under any status, ever.
- **Actual:** the stamp-forgery guard (`if founder_id/founder_acted_at/cleared_at/points_awarded
  is distinct... and not is_founder() then raise`) only checks *who* is allowed to touch the
  column, not *when* — it happily lets a founder set `points_awarded` on any status-unchanged
  update, with no requirement that the transition is actually `verified -> cleared`.
- **Why it matters:** this is a UI-trust bug, not a ledger bug — no ledger row is written (the
  ledger insert only fires on an actual status change into one of the five ledger states), and
  `ops.v_point_balances` filters `cleared_points` by `status = 'cleared'`, so the forged value
  never enters a real balance or the scoreboard. But `apps/web/src/routes/board.tsx:1199` reads
  `task.points_awarded ?? task.points_override ?? task.catalog_points` for the card's point
  badge, and `board.tsx:1415` switches the field label to **"Points awarded"** — the "settled"
  label — the instant `points_awarded` is non-null, which is exactly the "settled value is
  solid ink, unsettled value never is" rule DESIGN.md exists to protect. A founder (accidentally
  via a stray API call, a bad client cache write, or a race) can make a pending, rejected, or
  even freshly-reworked `todo` task display as "settled" with an arbitrary number, and nothing
  in the system ever clears it back to null short of the task actually reaching `cleared` again
  (at which point the real trigger overwrites it correctly). In a system whose entire premise is
  "the number means something," a phantom settled-looking number on unsettled work is a real
  trust defect, even though it can't be laundered into an actual paid balance.
- **Confidence:** verified live, reproduced end-to-end including the rejection/rework survival.
  Cleaned up: test task deleted via service-role connection (its own ledger rows cascaded per
  `20260909100100_ops_ledger_purge_exception.sql`'s documented system-caller exception) — this
  was my own throwaway probe data, not pre-existing demo history.

### [High] `ops.task_blocks.created_at`/`resolved_at` are fully client-controlled — anyone can fabricate blocked-time history
- **Where:** `supabase/migrations/20260909090100_ops_catalog_tasks.sql:162-183` (table def, no
  server-side stamping trigger on insert/update for these columns), RLS in
  `supabase/migrations/20260910120100_core_read_only_accounts.sql:344-366`.
- **Repro:**
  1. `gm-demo` (any ops member would do) `POST`s to `.../task_blocks` with
     `{"task_id": "<broker's task>", "target": "person", "blocking_user_id": "<broker's uid>",
     "reason": "probe: backdated block for fake exoneration hours", "created_by": "<gm uid>",
     "created_at": "2026-09-01T00:00:00Z"}`.
  2. `201`, row created with `created_at` exactly as submitted — **9 days in the past**, not
     `now()`.
  3. The same is true of `resolved_at` on the UPDATE path — I set it to an arbitrary literal
     timestamp as the block's creator in an earlier step of the same session and it was
     accepted verbatim.
- **Expected:** `created_at`/`resolved_at` should be server-derived (`now()` at insert /
  resolve time), the same way `cleared_at`, `founder_acted_at`, `gm_acted_at`, and
  `first_in_progress_at` all are on `ops.tasks` — this codebase clearly knows the pattern, it
  just wasn't applied here.
- **Why it matters:** PRD.md §4 defines **Blocked time** as `Σ(resolved_at − created_at)`,
  aggregated per blocking person and per external party — "the GM blocked 41 hours of other
  people's work this week" is the number PRD.md explicitly says is read out loud in the
  briefing and is meant to name who costs the company the most days. Cycle time (§4) is also
  defined as `cleared_at − first_in_progress_at`, **minus total blocked time** — so a fabricated
  block also inflates a person's cycle-time-looking-good number by claiming server time was
  actually blocked time. With `created_at`/`resolved_at` fully client-supplied, any ops member
  — not just oversight — can retroactively manufacture an arbitrarily large "blocked" interval
  against any task, naming any person or external party as the cause, with zero relationship to
  reality. This is precisely the attack named in the assignment scope: "use a block to exonerate
  a commitment that was never blocked." A commitment that was actually missed can be
  retroactively covered by inserting a blocks row backdated to span the whole week, naming
  whichever person or "BOC"/"the client" is most convenient.
- **Confidence:** verified live. The fabricated block was deleted afterward via the service-role
  connection (task_blocks has no append-only trigger, unlike the ledger/audit tables, so this
  was a clean, fully-restorable delete — nothing here is a permanent append-only artifact).

## Held up under attack

**Approval ladder**
- Staff self-verifying their own submitted task: refused (`only a GM may verify a submitted
  task`), verified live.
- Non-GM, non-owner staff verifying someone else's submitted task: refused, RLS `200`/0 rows.
- GM verifying their **own** submitted task (owner-is-GM branch): refused (`a GM cannot verify
  their own task; a founder must`) — and the founder-verifies-GM's-task path was then walked
  legitimately end to end (`submitted -> verified -> cleared`, 3 ledger rows, correct points).
- Skipping a rung: `submitted -> cleared` directly, tried as both the task owner and the
  clearing founder: refused both times (`illegal transition submitted -> cleared`).
- GM stamping `founder_id` on a task they don't own the rung for: refused.
- Re-clearing an already-`cleared` task via a `points_override` write: refused (`a cleared or
  cancelled task is frozen`).
- Rejection with a reason under 10 characters, by an otherwise-legitimate GM: refused.
- Staff rejecting their own submitted task: refused (`only GM/founder may reject a task`).
- ERC/DCA (read-only, `authority = 'founder'`) attempting a points override, a settings write,
  and self-promotion to admin: all refused as `200`/0 rows — `core.is_read_only()` correctly
  intercepts every one of these ahead of the authority ladder, exactly as
  `20260910120100_core_read_only_accounts.sql`'s own commentary claims.

**The ledger**
- Founder UPDATE on an existing ledger row (`points: 9999`): `200`/0 rows — RLS has no UPDATE
  policy for `authenticated` at all, so it never even reaches the trigger.
- Founder DELETE on a ledger row: `200`/0 rows, same reason.
- Staff INSERT of a fabricated `cleared`-state ledger row crediting themselves 100 points:
  `403`, RLS insert policy violation.
- Service-role UPDATE on a ledger row (bypassing RLS entirely, going straight at the trigger):
  `403 ops.point_ledger is append-only; UPDATE is not permitted` — confirms the append-only
  guarantee holds even against the one role capable of bypassing RLS, and that the narrow
  DELETE exception in `20260909100100_ops_ledger_purge_exception.sql` does **not** extend to
  UPDATE under any caller.
- Cascade-delete-the-parent: an owner deleting their own task while it has ledger history
  (status `todo`, but ledger rows exist from an earlier `submitted` excursion) is refused —
  Postgres attempts to cascade the DELETE onto `point_ledger` (the FK is `on delete cascade` by
  deliberate design, per that same migration's comment, for Chan's own demo-purge script), the
  cascade hits the append-only trigger, and the **whole transaction rolls back**, so the task
  itself is not deleted either. A cleared task cannot be deleted by anyone (RLS `tasks_delete`
  only allows owner-while-`todo`/`cancelled`) — verified live for both the owner and the
  clearing founder.
- `core.audit_logs` UPDATE via the **service role** directly: refused
  (`core.audit_logs is append-only; UPDATE is not permitted`) — no exception exists for audit,
  matching the plan's explicit statement that audit gets no purge carve-out.
- `ops.task_type_revisions` UPDATE/DELETE by a founder: both `200`/0 rows, no policy exists for
  either verb.

**Catalog**
- Staff editing `default_points` on a task type: `200`/0 rows, refused.
- Founder re-pricing a task type after a task was already cleared against it: the historical
  task's `catalog_points` and `points_awarded` were unchanged after the reprice (verified by
  reading the row before and after) — the snapshot-at-creation guarantee holds.
- Founder hard-deleting a task type in use via `rpc/delete_task_type_if_unused`: `409`, refused
  with a clear message pointing at deactivation instead.
- Staff reactivating a task type a founder had deactivated: `200`/0 rows, refused (oversight
  only).

**Weeks / briefing**
- Staff calling `generate_recurring_tasks`, `close_week`, `roll_over_week`,
  `close_briefing` directly via `rpc/...`: all `403`, "only oversight may ...".
- `generate_recurring_tasks` called twice in a row on the same (already-generated) week:
  `created_count: 0` both times, count of recurring tasks unchanged — idempotent.
- `close_week` and `roll_over_week` called a second time on an already-closed/rolled-over week:
  identical output, `closed_at`/`rolled_over_at` timestamps unchanged — idempotent, no double
  carry-over.
- `close_briefing` called a second time on an already-open week: state and timestamps
  unchanged, and **no duplicate audit row** was written (checked count before/after) — no
  double-logging on a repeated no-op call.

**Commitments**
- Owner committing a new task after the briefing closed (week state `open`): refused
  (`commitments are locked for this week`).
- Non-owner staff committing someone else's task: `200`/0 rows, refused.
- **GM/oversight** attempting to force-commit a task after close: also refused — the lock is
  absolute once the week leaves `planning`, with no oversight override, matching PRD §3.6.

**Blocks**
- Task→task cycle (`A blocked by B`, then `B blocked by A`): the second insert was refused
  (`this block would close a cycle between two or more tasks`).
- A task's owner (not the block's creator) resolving a block someone else raised on their task:
  `200`/0 rows, refused — only the creator, the named blocking person, or oversight may resolve.
- Any ops member creating a block naming someone else's task as blocked, or naming a third
  party as the blocker: this **succeeded** — but per PLAN.md §2.7 this is by design
  (`ops.task_blocks` INSERT policy is "member, `created_by = auth.uid()`", with no
  ownership-of-target restriction), not a bug. Noted for completeness, not scored as a defect.

**Scoreboard / cross-account reads**
- `core.people`: a staff member (`broker-demo`) querying the full table got back only their own
  row — the "self, or oversight" policy holds.
- `core.users`: same — a staff member sees only their own row.
- `ops.tasks`/`ops.point_ledger`: any ops member can see any other member's tasks and ledger
  rows — this is **intentional transparency** per PRD §6.1 ("any ops member — everyone sees
  everything, by design") and PLAN §2.7's RLS table, not a defect.

## A structural note, not a scored defect
`GET /api/scoreboard` gates reliability, hit-rate, cycle time, and `leaderboard_visibility =
oversight_only` entirely in `apps/api/src/routes/scoreboard.ts` (confirmed by reading the file's
own header comment, which is explicit about this: "enforced HERE, server-side... Reads run on
`userClient`"). Because the RLS policies on `ops.tasks`/`ops.weeks`/`ops.task_blocks` grant every
ops member full read access **by design**, and no database view or additional RLS layer sits
between those tables and the scoreboard's arithmetic, a `staff` caller can reconstruct any other
person's reliability, hit-rate, or cycle-time by reading the same raw rows directly via
PostgREST with their own JWT and running the (published, tested, deterministic)
`packages/ops-scoring` formulas themselves — verified live: `broker-demo` pulled every field
needed for GM's cycle-time and hit-rate history (`cleared_at`, `first_in_progress_at`,
`committed_points`, `status`, per week) directly from `ops.tasks`. I'm not scoring this as a
defect at Medium-or-above because the underlying facts are already, deliberately, visible to
every ops member (PRD §6.1) — the restriction only ever hid the *pre-computed derived number*,
not the inputs, so a determined staff member loses nothing by going around it that they didn't
already have. But it is exactly the "a ladder that exists only in TypeScript is decoration"
pattern the plan's own carried-over HR lessons warn about, and if `leaderboard_visibility`'s
intent is ever tightened to also hide the underlying task-level data (not just the aggregate),
this gap becomes load-bearing rather than cosmetic. Rated **Low**, reasoned live (not a
guess — the raw-row pull was actually executed and returned exactly the fields the API-layer
gate is meant to withhold).

## Not tested
- `apps/api`/`apps/web` were not started. Ports 5173 and 3099 already had processes bound at
  session start (`node .../vite`, and a second process on 3099) that looked like they belonged
  to a concurrent session rather than a stale leftover of mine, so per the collaboration-hygiene
  rule I did not kill them or start competing servers. This means the actual HTTP-layer
  enforcement in `apps/api` (the `maySeeReliability` gate, `/set-password`, provisioning) was
  verified by reading source only, not by driving real HTTP requests against a running API —
  flagged per the instructions as an honest gap, not folded into a "SHIP" verdict.
- `core.purge_due_accounts()` / the 14-day window were **not exercised live** — running it for
  real would require soft-deleting one of the six persona accounts I was given to test with,
  which are exactly the accounts this sweep depends on, and there is no throwaway account to
  sacrifice. Verified instead by reading `20260910090000_core_soft_delete_accounts.sql` in full:
  the FK from `core.users.id` to `auth.users.id` is deliberately dropped (not just widened) so
  that `delete from auth.users` cannot cascade into `core.users`/`ops.tasks`/`ops.point_ledger`,
  and the invariant guards (an admin can't delete themselves, the last active admin can't be
  deleted, a soft-deleted account can't be silently re-granted authority) are structurally
  sound on paper. This is **reasoned, not reproduced** — flagging plainly per the instructions.
- Web/Playwright UI testing (board drag-and-drop, the queue screen, the scoreboard page
  rendering) was not attempted, for the same server-not-running reason above.
- `npm run test:rls` was not re-run in this session; I relied on the 2026-09-10 baseline already
  recorded in `docs/AGENT-LESSONS.md` §2 (109 passed / 0 failed, canary correctly failed) rather
  than re-running it, since this sweep's mandate was live-database attack beyond what that suite
  already covers.

## Data touched
- Five throwaway probe tasks were created (`[TESTER-PROBE-A]` through `[TESTER-PROBE-F]`) to
  exercise the ladder, commitments, and blocks; all were deleted before this report was written
  — four via the owning persona once they were back at a deletable status, two (which had
  point-ledger history from their journey through `submitted`/`verified`/`rejected`) via the
  service-role connection, whose narrow system-caller DELETE exception on `ops.point_ledger`
  exists exactly for this kind of demo cleanup per `20260909100100_ops_ledger_purge_exception.sql`.
- One task (`[TESTER-PROBE-B] GM self task`, id `5b06893d-dfdf-4c83-b1aa-c36116c1a2af`) was
  walked through the **real** ladder legitimately (GM submits, founder verifies since GM owns
  it, founder clears) to prove the GM-self-verification rule and generate real ledger rows to
  attack. It was **left in place, cleared, 3 points** — deleting a legitimately cleared task and
  its ledger rows is refused by the system for everyone by design (append-only, terminal state),
  and forcing it via service role would itself be the kind of history-rewrite this system exists
  to prevent. This is a small, clearly-labelled synthetic addition to the demo data, same
  treatment as the prior evidence file's approved edit-request row.
- One fabricated `ops.task_blocks` row (backdated `created_at`) and one legitimate-looking block
  used to prove the cycle guard were both deleted via the service-role connection — `task_blocks`
  has no append-only trigger, so this cleanup was complete and left no residue.
- `ops.settings`/`ops.task_types.default_points`/`.is_active` were each flipped and restored to
  their original values within the same request pair (verified before/after).
- No `core.audit_logs` or `ops.point_ledger` rows from real pre-existing demo history were
  touched. The only permanent additions to those append-only tables are the 3 ledger rows and
  0 audit rows from the one legitimately-cleared probe task described above.
