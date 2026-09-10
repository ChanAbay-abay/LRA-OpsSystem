-- =====================================================================
-- LRA Global Ops :: RLS and write-path regression suite (Phase 1)
--
-- Run against a real Postgres with the `core` and `ops` migrations
-- applied — locally via `supabase start` + `supabase db reset`, which is
-- what `npm run test:rls` / CI's `rls` job do. Everything happens inside
-- one transaction that is rolled back, so it leaves nothing behind.
--
--     psql "$DATABASE_URL" -f supabase/tests/rls_test.sql
--
-- DO NOT paste this file into the Supabase web SQL editor. That editor
-- splits a script into separate statements, and the temp tables below
-- (`t_results`, `t_ids`, `t_meta`) do not survive the split -- the run
-- dies with `relation "t_results" does not exist`, which looks like a
-- broken suite and is not. Tried and confirmed 2026-09-10.
--
-- Without psql, the working route is a single Supabase MCP
-- `execute_sql` call containing this entire file verbatim; one call is
-- one session, so the temp tables hold. That is how the 109/0 pass on
-- 2026-09-10 was produced.
--
-- Structure and the two rules it exists to enforce are copied from
-- LRA-HR's suite (which was itself a rewrite after its first version
-- passed 14/14 against a wide-open database):
--
--   1. Tests run as `authenticated`, never as the table owner. The
--      owner bypasses RLS entirely (no table has FORCE ROW LEVEL
--      SECURITY).
--   2. A harness that cannot go red is worse than no harness. The last
--      test is a canary that MUST fail. If it passes, the suite is not
--      exercising RLS and every result above it is void.
--   3. `request.jwt.claims` — the PLURAL GUC — not the legacy singular
--      `request.jwt.claim.sub`. auth.uid() and core.is_system_caller()
--      both read the plural form; getting this wrong is exactly how
--      HR's first RLS suite went green while every persona was in fact
--      anonymous.
--
-- COVERAGE NOTE: this file covers the numbered attacks from PLAN.md §6
-- that have a real table to attack as of Phase 1 (`core` fully, `ops`
-- limited to `settings` and `weeks` — the catalog/tasks/ledger tables
-- and their attacks 1, 3-15, 17-19 arrive with the migrations that
-- create them in Phase 3/4). Attack 1 (TRUNCATE) is demonstrated
-- against `ops.weeks` instead of the not-yet-existent `ops.tasks` —
-- the defence being proven is the per-schema revoke block, which is
-- schema-wide and therefore identical for any table in `ops`. Attack 27
-- (the canary) is likewise demonstrated against `core.people` instead
-- of `ops.tasks`; Phase 3 must add the literal `ops.tasks` canary
-- PLAN.md §6 describes once that table exists.
-- =====================================================================

begin;

set local client_min_messages = warning;

create temp table t_results (
  id      serial,
  area    text,
  label   text,
  outcome text,
  passed  boolean
);
grant all on t_results to authenticated;
-- anon too: the TRUNCATE attacks below run as `anon`, and expect_blocked()
-- records its result into this table from inside that role. Without this
-- the suite aborts on the first anon test instead of reporting it.
grant all on t_results to anon;
-- The sequence behind the identity column needs the same treatment.
grant usage, select on all sequences in schema pg_temp to authenticated, anon;
grant usage, select on sequence t_results_id_seq to authenticated;

-- An attack that must be refused. Passes only if the database raises,
-- OR affects zero rows -- RLS usually refuses by matching no rows
-- rather than by raising, and both outcomes count as a refusal.
create function pg_temp.expect_blocked(p_area text, p_label text, p_sql text)
returns void language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  if n = 0 then
    insert into t_results (area, label, outcome, passed)
    values (p_area, p_label, 'refused: no rows affected', true);
  else
    insert into t_results (area, label, outcome, passed)
    values (p_area, p_label, 'ALLOWED - ' || n || ' row(s) changed', false);
  end if;
exception when others then
  insert into t_results (area, label, outcome, passed)
  values (p_area, p_label, 'refused: ' || left(sqlerrm, 60), true);
end $$;

-- For guards that normalise rather than refuse: run the attack, then
-- assert the value it targeted is unchanged.
create function pg_temp.expect_unchanged(
  p_area text, p_label text, p_sql text, p_check text
) returns void language plpgsql as $$
declare ok boolean;
begin
  begin execute p_sql; exception when others then null; end;
  execute p_check into ok;
  ok := coalesce(ok, false);
  insert into t_results (area, label, outcome, passed)
  values (p_area, p_label,
          case when ok then 'value unchanged' else 'VALUE WAS CHANGED OR MISSING' end, ok);
end $$;

-- A legitimate action that must succeed. Guards that block real users
-- are how HR broke clock-out and leave balances.
create function pg_temp.expect_allowed(p_area text, p_label text, p_sql text)
returns void language plpgsql as $$
begin
  execute p_sql;
  insert into t_results (area, label, outcome, passed)
  values (p_area, p_label, 'allowed', true);
exception when others then
  insert into t_results (area, label, outcome, passed)
  values (p_area, p_label, 'REFUSED - expected success: ' || left(sqlerrm, 60), false);
end $$;

create function pg_temp.expect_rows(p_area text, p_label text, p_sql text, p_expected int)
returns void language plpgsql as $$
declare v int;
begin
  execute p_sql into v;
  insert into t_results (area, label, outcome, passed)
  values (p_area, p_label, 'saw ' || v || ', expected ' || p_expected, v = p_expected);
exception when others then
  insert into t_results (area, label, outcome, passed)
  values (p_area, p_label, 'ERROR: ' || left(sqlerrm, 60), false);
end $$;

create function pg_temp.become(p_sub uuid) returns void language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated')::text,
    true
  );
end $$;

-- ---------------------------------------------------------------------
-- Attack 24, run BEFORE `set local role authenticated`, as the
-- connection's own (superuser/table-owner) role. core.audit_logs is
-- append-only "even to the service role" -- the trigger does not check
-- who is asking, so this proves the block applies universally,
-- including to the role every other guard in this file has to bypass
-- via core.is_system_caller().
-- ---------------------------------------------------------------------

insert into core.audit_logs (actor_id, action, entity_type)
values (null, 'TEST-seed', 'test.seed');

select pg_temp.expect_blocked('append-only',
  'even the service role cannot UPDATE core.audit_logs',
  $sql$update core.audit_logs set action = 'TAMPERED' where action = 'TEST-seed'$sql$);

-- ---------------------------------------------------------------------
-- Fixtures. Prefixed TEST- so they cannot collide with real records.
-- ---------------------------------------------------------------------

create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to authenticated;

insert into t_ids (k, v)
select k, gen_random_uuid()
from unnest(array['founder','gm','sales','broker','other']) as k;

insert into auth.users (id, email, instance_id, aud, role)
select v, 'test-' || k || '@lra.invalid', '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated'
from t_ids;

insert into core.people (person_code, first_name, last_name, email)
select 'TEST-' || upper(k), initcap(k), 'Persona', 'test-' || k || '@lra.invalid'
from t_ids;

insert into core.users (id, email, authority, person_id)
select t.v, 'test-' || t.k || '@lra.invalid',
       (case when t.k in ('sales','broker','other') then 'staff' else t.k end)::core.authority,
       (select id from core.people where person_code = 'TEST-' || upper(t.k))
from t_ids t;

insert into core.memberships (user_id, module, position)
-- 'gm' must carry position 'gm', not 'other'. The transition trigger
-- decides "is this task GM-owned?" from the membership POSITION, not from
-- authority, so a gm persona positioned as 'other' silently exercises the
-- wrong branch of the verify rung. That went unnoticed while no assertion
-- depended on GM-owned semantics; the settlement-forgery tests added in
-- 20260910160000 do, and three of them failed because of it.
select v, 'ops', (case when k in ('sales','broker','gm') then k else 'other' end)::core.position
from t_ids
where k <> 'other';   -- 'other' is deliberately not an ops member -- the read-scoping victim.

create temp view p as select k, v as uid from t_ids;
grant select on p to authenticated;

-- Force the fixture state rather than accepting whatever the live app left
-- behind. `do nothing` meant that once anyone actually ran a briefing, the
-- current week stayed 'open' and two commitment assertions failed for reasons
-- that had nothing to do with the code under test. Everything here is inside
-- the transaction this file rolls back, so the real week is untouched.
insert into ops.weeks (week_start, state)
values (ops.week_start_for(now()), 'planning')
on conflict (week_start) do update
  set state              = 'planning',
      briefing_opened_at = null,
      briefing_closed_at = null,
      briefing_closed_by = null,
      closed_at          = null,
      closed_by          = null,
      rolled_over_at     = null;

insert into core.notifications (user_id, title, message)
select v, 'TEST notification', 'seeded for the update-guard attack'
from t_ids where k = 'sales';

-- A SECOND founder, distinct from the one persona rows above promote to
-- the clearing seat (see the "Promote the test founder..." block below)
-- -- needed to prove that `core.authority = 'founder'` alone is not
-- enough to decide a flagged cancellation; only the ONE clearing seat
-- may (attack: "a non-clearing founder cannot approve one").
insert into t_ids (k, v) values ('founder2', gen_random_uuid());
insert into auth.users (id, email, instance_id, aud, role)
select v, 'test-founder2@lra.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'
from t_ids where k = 'founder2';
insert into core.people (person_code, first_name, last_name, email)
select 'TEST-FOUNDER2', 'Founder2', 'Persona', 'test-founder2@lra.invalid';
insert into core.users (id, email, authority, person_id)
select t.v, 'test-founder2@lra.invalid', 'founder', (select id from core.people where person_code = 'TEST-FOUNDER2')
from t_ids t where t.k = 'founder2';
insert into core.memberships (user_id, module, position)
select v, 'ops', 'other' from t_ids where k = 'founder2';

-- ---------------------------------------------------------------------
-- Everything below runs as `authenticated`, never as the owner.
-- ---------------------------------------------------------------------

set local role authenticated;

-- === Attack 26: cross-person read scoping ============================

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_rows('read-scoping',
  'a staff member sees only their own core.people row',
  $sql$select count(*) from core.people where person_code like 'TEST-%'$sql$, 1);

select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_rows('read-scoping',
  'oversight (founder) sees every test person',
  $sql$select count(*) from core.people where person_code like 'TEST-%'$sql$,
  -- Counted from the persona table, never hardcoded: a later attack added a
  -- sixth persona (founder2, for the cancellation ladder) and this assertion
  -- went red because it still expected 5. The invariant is "sees ALL of them".
  (select count(*)::int from t_ids));

-- === Attack 23: privilege escalation on core.users ====================

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('escalation',
  'staff cannot make themselves admin',
  $sql$update core.users set authority='admin' where id=(select uid from p where k='sales')$sql$);

-- === Attack 16: staff cannot edit ops.settings ========================

select pg_temp.expect_blocked('ladder',
  'staff cannot change the recurring cap in ops.settings',
  $sql$update ops.settings set recurring_cap_pct = 0.99$sql$);

select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_allowed('ladder',
  'founder CAN change ops.settings',
  $sql$update ops.settings set recurring_cap_pct = 0.35$sql$);

-- === Attack 20: staff cannot open or close a week =====================

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('ladder',
  'staff cannot insert a new ops.weeks row',
  $sql$insert into ops.weeks (week_start, state) values ('2099-01-05','planning')$sql$);
select pg_temp.expect_blocked('ladder',
  'staff cannot close the current week',
  $sql$update ops.weeks set state='open' where week_start = ops.week_start_for(now())$sql$);

select pg_temp.become((select uid from p where k='gm'));
select pg_temp.expect_allowed('ladder',
  'GM (oversight) CAN open the briefing on the current week',
  $sql$update ops.weeks set briefing_opened_at = now() where week_start = ops.week_start_for(now())$sql$);

-- === Attack 21: the forgeable inbox ====================================

select pg_temp.become((select uid from p where k='broker'));
select pg_temp.expect_blocked('notifications',
  'staff cannot insert a notification into a colleague''s inbox',
  $sql$insert into core.notifications (user_id, title, message)
       select uid, 'forged', 'you have been approved' from p where k='sales'$sql$);

-- === Attack 22: notifications are is_read-only ========================

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('notifications',
  'staff cannot rewrite the title of their own notification',
  $sql$update core.notifications set title='EDITED'
       where user_id=(select uid from p where k='sales') and title='TEST notification'$sql$);
select pg_temp.expect_allowed('notifications',
  'staff CAN mark their own notification read',
  $sql$update core.notifications set is_read=true
       where user_id=(select uid from p where k='sales') and title='TEST notification'$sql$);

-- === Attack 25: audit rows must claim the real actor ==================

select pg_temp.expect_blocked('audit',
  'staff cannot insert an audit row claiming another actor',
  $sql$insert into core.audit_logs (actor_id, action, entity_type)
       select uid, 'TEST-forged', 'test.forge' from p where k='broker'$sql$);
select pg_temp.expect_allowed('audit',
  'staff CAN insert an audit row claiming themselves',
  $sql$insert into core.audit_logs (actor_id, action, entity_type)
       select uid, 'TEST-self', 'test.self' from p where k='sales'$sql$);

-- =======================================================================
-- Phase 3/4/5 additions — catalog, tasks, the state machine, the ledger,
-- blocks. Fixtures created as the owner/system role (still before this
-- point we are `authenticated`, so switch back briefly) so the INSERT
-- guard's system-caller bypass applies and these rows do not have to
-- satisfy `created_by = auth_user_id()` for a specific persona.
-- =======================================================================

reset role;
-- `reset role` alone is NOT enough. core.is_system_caller() reads the
-- `request.jwt.claims` GUC, not the current role -- and the last
-- pg_temp.become() left claims saying role=authenticated, so every
-- system-bypass below (the `submitted` seed, the is_clearing_founder
-- promotion) was still being refused with 42501. Clear the claims too.
-- This is the exact plural-GUC distinction this file's own header warns
-- about, and it bit the fixtures rather than the assertions.
select set_config('request.jwt.claims', null, true);

create temp table t_meta (k text primary key, v uuid);
grant all on t_meta to authenticated, anon;

insert into ops.task_types (name, category, guideline_note, default_points, is_active)
values ('TEST-Type', 'Test', 'DRAFT — test fixture, never priced for real', 8, true);

insert into t_meta (k, v)
select 'task_type', id from ops.task_types where name = 'TEST-Type';

-- main: stays at todo, target of the column-forgery attacks (9/10/11).
with ins as (
  insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
  select w.id, (select uid from p where k='sales'), (select v from t_meta where k='task_type'),
         'TEST-main', 'todo', (select uid from p where k='sales')
  from ops.weeks w where w.week_start = ops.week_start_for(now())
  returning id
)
insert into t_meta (k, v) select 'main', id from ins;

-- task2: walked all the way to cleared by legitimate actors, so the
-- ledger has real rows to test attack 13/14 against.
with ins as (
  insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
  select w.id, (select uid from p where k='sales'), (select v from t_meta where k='task_type'),
         'TEST-task2', 'todo', (select uid from p where k='sales')
  from ops.weeks w where w.week_start = ops.week_start_for(now())
  returning id
)
insert into t_meta (k, v) select 'task2', id from ins;

-- task3: owned by the GM, submitted directly (system bypass), so attack
-- 8 (GM self-verification) has something to attack without needing the
-- legal todo->submitted path first.
with ins as (
  insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
  select w.id, (select uid from p where k='gm'), (select v from t_meta where k='task_type'),
         'TEST-task3', 'submitted', (select uid from p where k='gm')
  from ops.weeks w where w.week_start = ops.week_start_for(now())
  returning id
)
insert into t_meta (k, v) select 'task3', id from ins;

-- taskA / taskB: the cycle-guard fixtures.
with ins as (
  insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
  select w.id, (select uid from p where k='sales'), (select v from t_meta where k='task_type'),
         'TEST-taskA', 'todo', (select uid from p where k='sales')
  from ops.weeks w where w.week_start = ops.week_start_for(now())
  returning id
)
insert into t_meta (k, v) select 'taskA', id from ins;

with ins as (
  insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
  select w.id, (select uid from p where k='sales'), (select v from t_meta where k='task_type'),
         'TEST-taskB', 'todo', (select uid from p where k='sales')
  from ops.weeks w where w.week_start = ops.week_start_for(now())
  returning id
)
insert into t_meta (k, v) select 'taskB', id from ins;

-- Promote the test founder to the one clearing seat, admin-only in
-- practice (RLS/trigger both require it) -- done here as the owner role,
-- the same way attack 24's fixture row bypasses the ladder legitimately.
-- Stand down whoever currently holds the single clearing seat first.
-- `uq_core_users_one_clearing_founder` permits exactly one, by design, so
-- with real (or demo-seeded) data present the promotion below would fail
-- on a duplicate key and abort the whole suite. Safe: everything here is
-- inside the transaction this file rolls back at the end.
update core.users set is_clearing_founder = false where is_clearing_founder;
update core.users set is_clearing_founder = true where id = (select uid from p where k='founder');

set local role authenticated;

-- === Attack 3: INSERT a task already at a downstream status ==========

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('state-machine',
  'staff cannot INSERT a task that starts at verified',
  $sql$insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
       select w.id, (select uid from p where k='sales'), (select v from t_meta where k='task_type'),
              'TEST-bad-insert', 'verified', (select uid from p where k='sales')
       from ops.weeks w where w.week_start = ops.week_start_for(now())$sql$);

-- === Attack 9/10/11: column forgery on ops.tasks ======================

select pg_temp.expect_blocked('ladder',
  'staff cannot change catalog_points on their own task',
  $sql$update ops.tasks set catalog_points = 21 where id = (select v from t_meta where k='main')$sql$);

select pg_temp.expect_blocked('ladder',
  'staff cannot set a points override',
  $sql$update ops.tasks set points_override = 13, points_override_reason = 'because I said so'
       where id = (select v from t_meta where k='main')$sql$);

select pg_temp.become((select uid from p where k='gm'));
select pg_temp.expect_blocked('ladder',
  'oversight cannot set a points override with no reason',
  $sql$update ops.tasks set points_override = 13 where id = (select v from t_meta where k='main')$sql$);

-- === Attack 4/5: staff cannot self-clear or write points_awarded ======

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_allowed('lifecycle',
  'owner CAN submit their own task (todo -> submitted)',
  $sql$update ops.tasks set status = 'submitted' where id = (select v from t_meta where k='task2')$sql$);

select pg_temp.expect_blocked('ladder',
  'staff cannot jump their own task straight to cleared',
  $sql$update ops.tasks set status = 'cleared' where id = (select v from t_meta where k='task2')$sql$);

select pg_temp.expect_blocked('ladder',
  'staff cannot write points_awarded directly',
  $sql$update ops.tasks set points_awarded = 99 where id = (select v from t_meta where k='task2')$sql$);

-- === Attack 8: GM cannot verify their own task ========================

select pg_temp.become((select uid from p where k='gm'));
select pg_temp.expect_blocked('ladder',
  'a GM cannot verify a task they own',
  $sql$update ops.tasks set status = 'verified' where id = (select v from t_meta where k='task3')$sql$);

-- === Legitimate verify, then Attack 6/7: GM cannot stamp founder or clear ==

select pg_temp.expect_allowed('lifecycle',
  'GM CAN verify a task owned by someone else',
  $sql$update ops.tasks set status = 'verified' where id = (select v from t_meta where k='task2')$sql$);

select pg_temp.expect_blocked('ladder',
  'GM cannot stamp founder_id',
  $sql$update ops.tasks set founder_id = (select uid from p where k='gm')
       where id = (select v from t_meta where k='task2')$sql$);

select pg_temp.expect_blocked('ladder',
  'GM cannot move verified -> cleared',
  $sql$update ops.tasks set status = 'cleared' where id = (select v from t_meta where k='task2')$sql$);

-- === Legitimate clear, by the ONE clearing founder ====================

select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_allowed('lifecycle',
  'the clearing founder CAN clear a verified task',
  $sql$update ops.tasks set status = 'cleared' where id = (select v from t_meta where k='task2')$sql$);

select pg_temp.expect_rows('ledger',
  'task2''s full lifecycle wrote exactly 3 ledger rows (submitted/verified/cleared)',
  $sql$select count(*) from ops.point_ledger where task_id = (select v from t_meta where k='task2')$sql$, 3);

-- === Attack 13: the ledger is append-only, even to oversight ==========

select pg_temp.expect_blocked('append-only',
  'a founder cannot rewrite a point_ledger row',
  $sql$update ops.point_ledger set points = 21 where task_id = (select v from t_meta where k='task2')$sql$);
select pg_temp.expect_blocked('append-only',
  'a founder cannot delete a point_ledger row',
  $sql$delete from ops.point_ledger where task_id = (select v from t_meta where k='task2')$sql$);

-- === Attack 14: a cleared task is terminal ============================

select pg_temp.expect_blocked('ladder',
  'a cleared task cannot be edited, even by the clearing founder',
  $sql$update ops.tasks set title = 'TAMPERED' where id = (select v from t_meta where k='task2')$sql$);

-- === Attack 15: staff cannot edit the catalog =========================

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('ladder',
  'staff cannot re-price a catalog type',
  $sql$update ops.task_types set default_points = 21 where id = (select v from t_meta where k='task_type')$sql$);

-- === Attack 18: task -> task blocks may not close a cycle =============

select pg_temp.expect_allowed('blocks',
  'sales CAN declare taskB blocked by taskA',
  $sql$insert into ops.task_blocks (task_id, target, blocking_task_id, reason, created_by)
       values ((select v from t_meta where k='taskB'), 'task',
               (select v from t_meta where k='taskA'), 'waiting on the other task', (select uid from p where k='sales'))$sql$);

select pg_temp.expect_blocked('blocks',
  'the reverse edge (taskA blocked by taskB) is refused as a cycle',
  $sql$insert into ops.task_blocks (task_id, target, blocking_task_id, reason, created_by)
       values ((select v from t_meta where k='taskA'), 'task',
               (select v from t_meta where k='taskB'), 'this would deadlock the board', (select uid from p where k='sales'))$sql$);

-- =======================================================================
-- Catalog CRUD -- staff cannot create or hard-delete a catalog row
-- (attack 15 above already covers UPDATE).
-- =======================================================================

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('catalog-crud',
  'staff cannot INSERT a new ops.task_types row',
  $sql$insert into ops.task_types (name, category, guideline_note, is_active)
       values ('TEST-forged-type', 'Test', 'DRAFT — forged', true)$sql$);

select pg_temp.expect_blocked('catalog-crud',
  'staff cannot hard-delete a task type via ops.delete_task_type_if_unused',
  $sql$select ops.delete_task_type_if_unused((select v from t_meta where k='task_type'))$sql$);

select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_blocked('catalog-crud',
  'oversight cannot hard-delete a task type that a task has already referenced',
  $sql$select ops.delete_task_type_if_unused((select v from t_meta where k='task_type'))$sql$);

-- =======================================================================
-- Phase 6 -- commitments: ownership and the lock. taskA (still todo,
-- owned by sales) is committed, the briefing is closed, and the lock is
-- proven to bind everyone, including oversight, from the user path.
-- =======================================================================

select pg_temp.become((select uid from p where k='broker'));
select pg_temp.expect_blocked('commitments',
  'staff cannot commit someone else''s task',
  $sql$update ops.tasks set is_committed = true,
         committed_week_id = week_id, committed_points = coalesce(points_override, catalog_points, 0)
       where id = (select v from t_meta where k='taskA')$sql$);

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_allowed('commitments',
  'the owner CAN commit their own task while the week is planning',
  $sql$update ops.tasks set is_committed = true,
         committed_week_id = week_id, committed_points = coalesce(points_override, catalog_points, 0)
       where id = (select v from t_meta where k='taskA')$sql$);

reset role;
select set_config('request.jwt.claims', null, true);
select ops.close_briefing((select id from ops.weeks where week_start = ops.week_start_for(now())));
set local role authenticated;

-- === Attack 12: a FRESH commit, not merely an alteration, once the
-- briefing has closed. taskB has never been committed before this
-- point in the file (it is only touched by the cancellation ladder
-- further down) -- distinct from the "alter an existing commitment"
-- attacks below, which exercise the same trigger branch but starting
-- from is_committed = true rather than false.
select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('commitments',
  'attack 12: staff cannot make a brand-new commitment once the briefing has closed',
  $sql$update ops.tasks set is_committed = true,
         committed_week_id = week_id, committed_points = coalesce(points_override, catalog_points, 0)
       where id = (select v from t_meta where k='taskB')$sql$);

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('commitments',
  'nobody can alter a commitment after the briefing closes (owner tries to uncommit)',
  $sql$update ops.tasks set is_committed = false, committed_week_id = null, committed_points = null
       where id = (select v from t_meta where k='taskA')$sql$);

select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_blocked('commitments',
  'nobody can alter a commitment after the briefing closes (oversight tries too)',
  $sql$update ops.tasks set committed_points = 999
       where id = (select v from t_meta where k='taskA')$sql$);

-- =======================================================================
-- Cancellation as a two-rung approval (taskB: todo, owned by sales).
-- =======================================================================

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('cancellation',
  'staff cannot flag their own task for cancellation',
  $sql$update ops.tasks set status = 'pending_cancellation', cancellation_reason = 'trying to dodge review'
       where id = (select v from t_meta where k='taskB')$sql$);

select pg_temp.become((select uid from p where k='gm'));
select pg_temp.expect_allowed('cancellation',
  'GM CAN flag a task for cancellation with a real reason',
  $sql$update ops.tasks set status = 'pending_cancellation', cancellation_reason = 'client cancelled the shipment entirely'
       where id = (select v from t_meta where k='taskB')$sql$);

select pg_temp.expect_blocked('cancellation',
  'the GM who flagged it cannot also decide it (not the clearing founder)',
  $sql$update ops.tasks set status = 'cancelled' where id = (select v from t_meta where k='taskB')$sql$);

select pg_temp.become((select uid from p where k='founder2'));
select pg_temp.expect_blocked('cancellation',
  'a non-clearing founder cannot approve a flagged cancellation',
  $sql$update ops.tasks set status = 'cancelled' where id = (select v from t_meta where k='taskB')$sql$);

select pg_temp.expect_blocked('cancellation',
  'a non-clearing founder cannot refuse one either',
  $sql$update ops.tasks set status = 'todo', cancellation_decision_reason = 'no, keep working on it'
       where id = (select v from t_meta where k='taskB')$sql$);

select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_allowed('cancellation',
  'the CLEARING founder CAN refuse a flagged cancellation, with a reason',
  $sql$update ops.tasks set status = 'todo', cancellation_decision_reason = 'not yet — still chasing the client'
       where id = (select v from t_meta where k='taskB')$sql$);

select pg_temp.become((select uid from p where k='gm'));
select pg_temp.expect_allowed('cancellation',
  'GM re-flags the same task for cancellation',
  $sql$update ops.tasks set status = 'pending_cancellation', cancellation_reason = 'confirmed cancelled by the client today'
       where id = (select v from t_meta where k='taskB')$sql$);

select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_allowed('cancellation',
  'the clearing founder CAN approve the flagged cancellation',
  $sql$update ops.tasks set status = 'cancelled' where id = (select v from t_meta where k='taskB')$sql$);

select pg_temp.expect_rows('cancellation',
  'a cancelled task awards zero points and writes a cancelled ledger row',
  $sql$select coalesce(sum(points), 0)::int from ops.point_ledger
       where task_id = (select v from t_meta where k='taskB') and state = 'cancelled'$sql$, 0);

select pg_temp.expect_blocked('cancellation',
  'a cancelled task is frozen exactly like a cleared one',
  $sql$update ops.tasks set title = 'TAMPERED-cancelled' where id = (select v from t_meta where k='taskB')$sql$);

-- =======================================================================
-- ops.task_notes -- the worklog. append-only, owner/oversight write,
-- any member reads, closed once cleared/cancelled.
-- =======================================================================

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_allowed('notes',
  'the task owner CAN add a worklog note to their own task',
  $sql$insert into ops.task_notes (task_id, author_user_id, body)
       values ((select v from t_meta where k='main'), (select uid from p where k='sales'), 'Filed the entry, waiting on BOC.')$sql$);

insert into t_meta (k, v)
select 'note1', id from ops.task_notes where task_id = (select v from t_meta where k='main') order by created_at desc limit 1;

select pg_temp.become((select uid from p where k='broker'));
select pg_temp.expect_blocked('notes',
  'staff cannot write a note on someone else''s task',
  $sql$insert into ops.task_notes (task_id, author_user_id, body)
       values ((select v from t_meta where k='main'), (select uid from p where k='broker'), 'Not my task, forged note')$sql$);

select pg_temp.become((select uid from p where k='gm'));
select pg_temp.expect_allowed('notes',
  'the GM (oversight) CAN add a note to someone else''s task',
  $sql$insert into ops.task_notes (task_id, author_user_id, body)
       values ((select v from t_meta where k='main'), (select uid from p where k='gm'), 'Checked in — looks on track.')$sql$);

select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_blocked('notes',
  'nobody, not even a founder, can UPDATE a task_notes row',
  $sql$update ops.task_notes set body = 'TAMPERED' where id = (select v from t_meta where k='note1')$sql$);
select pg_temp.expect_blocked('notes',
  'nobody, not even a founder, can DELETE a task_notes row',
  $sql$delete from ops.task_notes where id = (select v from t_meta where k='note1')$sql$);

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('notes',
  'no note can be added to a cleared task',
  $sql$insert into ops.task_notes (task_id, author_user_id, body)
       values ((select v from t_meta where k='task2'), (select uid from p where k='sales'), 'too late, already cleared')$sql$);
select pg_temp.expect_blocked('notes',
  'no note can be added to a cancelled task',
  $sql$insert into ops.task_notes (task_id, author_user_id, body)
       values ((select v from t_meta where k='taskB'), (select uid from p where k='sales'), 'too late, already cancelled')$sql$);

-- === Attack 1 (ops.tasks) / Attack 27 (real canary) ====================

reset role;
set local role anon;
select pg_temp.expect_blocked('truncate',
  'anon cannot TRUNCATE ops.tasks',
  'truncate ops.tasks cascade');
reset role;
set local role authenticated;

select pg_temp.become((select uid from p where k='other'));
select pg_temp.expect_rows('read-scoping',
  'a non-ops-member sees zero ops.tasks rows',
  $sql$select count(*) from ops.tasks where title like 'TEST-%'$sql$, 0);

select pg_temp.expect_rows('CANARY', 'MUST FAIL: a non-member reads every TEST task',
  $sql$select count(*) from ops.tasks where title like 'TEST-%'$sql$,
  (select count(*)::int from t_meta where k in ('main','task2','task3','taskA','taskB')));

set local role authenticated;

-- === Attack 2: TRUNCATE never falls through RLS =======================

reset role;
set local role anon;
select pg_temp.expect_blocked('truncate',
  'anon cannot TRUNCATE core.users',
  'truncate core.users cascade');

-- === Attack 1 (substitute): TRUNCATE is refused schema-wide in ops ====

select pg_temp.expect_blocked('truncate',
  'anon cannot TRUNCATE ops.weeks (the same per-schema revoke that will guard ops.tasks)',
  'truncate ops.weeks cascade');

reset role;
set local role authenticated;

-- === Attack 27 (substitute canary) =====================================
--
-- This must FAIL. It asserts that a plain staff member can read every
-- test person's core.people row, which RLS forbids. If it shows as
-- passed, the harness is not exercising RLS at all -- most likely
-- running as the table owner, or with claims that do not resolve -- and
-- every other result above is meaningless.

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_rows('CANARY', 'MUST FAIL: staff reads every test person',
  $sql$select count(*) from core.people where person_code like 'TEST-%'$sql$,
  -- Counted from the persona table, never hardcoded: a later attack added a
  -- sixth persona (founder2, for the cancellation ladder) and this assertion
  -- went red because it still expected 5. The invariant is "sees ALL of them".
  (select count(*)::int from t_ids));

-- =======================================================================
-- Soft delete + 14-day purge (20260910090000_core_soft_delete_accounts)
-- =======================================================================
--
-- Fixtures: three synthetic admins (so "the last admin" can be tested
-- for real, without assuming anything about whether a production admin
-- row already exists) and one throwaway staff account to soft-delete
-- and restore, kept separate from every persona the attacks above
-- depend on.

-- These fixtures touch auth.users and core.* directly, so they must run as
-- the owner, not as `authenticated` -- and clearing the claims matters as
-- much as resetting the role, because core.is_system_caller() reads the JWT
-- claims GUC, not current_user. Same trap as the Phase 3 fixture block above.
reset role;
select set_config('request.jwt.claims', null, true);

insert into t_ids (k, v)
select k, gen_random_uuid() from unnest(array['admin1','admin2','admin3','staff_del']) as k;
insert into auth.users (id, email, instance_id, aud, role)
select v, 'test-' || k || '@lra.invalid', '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated'
from t_ids where k in ('admin1','admin2','admin3','staff_del');
insert into core.people (person_code, first_name, last_name, email)
select 'TEST-' || upper(k), initcap(k), 'Persona', 'test-' || k || '@lra.invalid'
from t_ids where k in ('admin1','admin2','admin3','staff_del');
insert into core.users (id, email, authority, person_id)
select t.v, 'test-' || t.k || '@lra.invalid',
       (case when t.k = 'staff_del' then 'staff' else 'admin' end)::core.authority,
       (select id from core.people where person_code = 'TEST-' || upper(t.k))
from t_ids t where t.k in ('admin1','admin2','admin3','staff_del');
insert into core.memberships (user_id, module, position)
select v, 'ops', 'other' from t_ids where k in ('admin1','admin2','admin3','staff_del');

-- Back to `authenticated` for the attacks themselves.
set local role authenticated;

-- === Non-admin cannot soft-delete anyone ===============================

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('soft-delete',
  'staff cannot soft-delete another account',
  $sql$update core.users set deleted_at = now(), deleted_by = (select uid from p where k='sales'), is_active = false
       where id = (select uid from p where k='staff_del')$sql$);

-- === A legitimate soft-delete by an admin ==============================

select pg_temp.become((select uid from p where k='admin1'));
select pg_temp.expect_allowed('soft-delete',
  'admin can soft-delete a staff account',
  $sql$update core.users set deleted_at = now(), deleted_by = (select uid from p where k='admin1'), is_active = false
       where id = (select uid from p where k='staff_del')$sql$);

-- === Non-admin cannot restore anyone ====================================

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('soft-delete',
  'staff cannot restore a soft-deleted account',
  $sql$update core.users set deleted_at = null where id = (select uid from p where k='staff_del')$sql$);

-- === A soft-deleted user cannot read or write anything ==================
-- Tested as the soft-deleted user's own token, direct against Postgres,
-- not just through the API's is_active check.

select pg_temp.become((select uid from p where k='staff_del'));
select pg_temp.expect_rows('soft-delete',
  'a soft-deleted user sees zero ops.tasks rows despite an active ops membership row',
  $sql$select count(*) from ops.tasks where title like 'TEST-%'$sql$, 0);
select pg_temp.expect_rows('soft-delete',
  'a soft-deleted user cannot even read their own core.people row',
  $sql$select count(*) from core.people where person_code = 'TEST-STAFF_DEL'$sql$, 0);
select pg_temp.expect_blocked('soft-delete',
  'a soft-deleted user cannot update their own core.users row',
  $sql$update core.users set email = 'still-here@lra.invalid' where id = (select uid from p where k='staff_del')$sql$);

-- === Admin restore, fully reversible within the grace period ===========

select pg_temp.become((select uid from p where k='admin1'));
select pg_temp.expect_allowed('soft-delete',
  'admin can restore a soft-deleted account',
  $sql$update core.users set deleted_at = null where id = (select uid from p where k='staff_del')$sql$);
select pg_temp.expect_rows('soft-delete',
  'a restored account is_active is forced back to true by the guard',
  $sql$select count(*) from core.users where id = (select uid from p where k='staff_del') and is_active$sql$, 1);

-- === An admin cannot delete their own account ===========================

select pg_temp.expect_blocked('soft-delete',
  'an admin cannot soft-delete themselves',
  $sql$update core.users set deleted_at = now(), deleted_by = (select uid from p where k='admin1'), is_active = false
       where id = (select uid from p where k='admin1')$sql$);

-- === The last remaining active admin cannot be deleted ==================

select pg_temp.expect_allowed('soft-delete',
  'admin can delete a second admin while others remain active',
  $sql$update core.users set deleted_at = now(), deleted_by = (select uid from p where k='admin1'), is_active = false
       where id = (select uid from p where k='admin2')$sql$);
select pg_temp.expect_allowed('soft-delete',
  'admin can delete a third admin while others remain active',
  $sql$update core.users set deleted_at = now(), deleted_by = (select uid from p where k='admin1'), is_active = false
       where id = (select uid from p where k='admin3')$sql$);

-- Reduce every OTHER active admin in the table (there may or may not be
-- a real one, depending on environment) to deleted too, one row at a
-- time -- never in one bulk UPDATE, whose trigger exception would abort
-- the whole statement and make the outcome depend on row-processing
-- order instead of deterministically reaching "admin1 is the only one
-- left".
do $$
declare
  r record;
begin
  for r in
    select id from core.users
    where authority = 'admin' and is_active and deleted_at is null
      and id <> (select v from t_ids where k = 'admin1')
  loop
    update core.users
    set deleted_at = now(),
        deleted_by = (select v from t_ids where k = 'admin1'),
        is_active = false
    where id = r.id;
  end loop;
end $$;

select pg_temp.expect_rows('soft-delete',
  'admin1 is now the sole remaining active admin',
  $sql$select count(*) from core.users where authority = 'admin' and is_active and deleted_at is null$sql$, 1);

-- Attempted as the system caller (no JWT claims at all), not as admin1
-- itself -- specifically to prove this is the *last-admin* invariant
-- firing and not the separate self-delete guard: is_system_caller()
-- bypasses the self-delete check but the last-admin check has no such
-- bypass, on purpose (PLAN.md's "SECURITY DEFINER bypasses RLS by
-- design and must recheck" lesson applied to a trigger, not a
-- function).
reset role;
select pg_temp.expect_blocked('soft-delete',
  'the last remaining active admin cannot be deleted, even by the system caller',
  $sql$update core.users set deleted_at = now(), deleted_by = (select v from t_ids where k = 'admin2'), is_active = false
       where id = (select v from t_ids where k = 'admin1')$sql$);
set local role authenticated;

-- === core.purge_due_accounts() ==========================================

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('purge',
  'a non-admin cannot run core.purge_due_accounts()',
  $sql$select core.purge_due_accounts()$sql$);

select pg_temp.become((select uid from p where k='admin1'));
select pg_temp.expect_rows('purge',
  'purge_due_accounts ignores an account whose purge_due_at is still in the future',
  -- staff_del was restored above; re-delete it to get a fresh,
  -- not-yet-due purge_due_at (now() + 14 days, set by the guard).
  $sql$with d as (
         update core.users set deleted_at = now(), deleted_by = (select uid from p where k='admin1'), is_active = false
         where id = (select uid from p where k='staff_del')
       )
       select core.purge_due_accounts()$sql$, 0);

-- Backdating purge_due_at here is an admin/system action exercising the
-- function's own logic, not a path a client can reach (the privilege
-- guard restricts that column to admin/system already, and the API
-- never exposes it as user input) -- this is the test proving the
-- 14-day boundary is respected, not a demonstration of a client attack.
select pg_temp.expect_allowed('purge',
  'admin backdates purge_due_at to exercise the due path',
  $sql$update core.users set purge_due_at = now() - interval '1 minute'
       where id = (select uid from p where k='staff_del')$sql$);

select pg_temp.expect_rows('purge',
  'purge_due_accounts purges exactly the one due account',
  $sql$select core.purge_due_accounts()$sql$, 1);

-- Reading auth.users needs owner rights -- `authenticated` has no SELECT on
-- it, and that is correct. Drop to the owner just for this one assertion,
-- then go straight back; the purge itself was performed as admin above.
reset role;
select set_config('request.jwt.claims', null, true);
select pg_temp.expect_rows('purge',
  'the auth.users login is gone after purge',
  $sql$select count(*) from auth.users where id = (select uid from p where k='staff_del')$sql$, 0);
set local role authenticated;
select pg_temp.become((select uid from p where k='admin1'));

select pg_temp.expect_rows('purge',
  'core.users survives the purge -- ledger/task/audit attribution is never broken',
  $sql$select count(*) from core.users where id = (select uid from p where k='staff_del')$sql$, 1);

select pg_temp.expect_rows('purge',
  'core.people identity is scrubbed to a tombstone, not deleted',
  $sql$select count(*) from core.people where person_code = 'TEST-STAFF_DEL' and email like '%+deleted@purged.lra.invalid'$sql$, 1);

select pg_temp.expect_rows('purge',
  'a second run is a no-op (idempotent)',
  $sql$select core.purge_due_accounts()$sql$, 0);

reset role;

-- =======================================================================
-- Read-only founder accounts (20260910120100_core_read_only_accounts):
-- ERC/DCA -- authority = founder, is_clearing_founder = false,
-- read_only = true. Must see exactly what oversight sees and write
-- nothing at all. One attack per write surface from the coder's sweep
-- checklist. `readonly` proves the guard against a plain founder-level
-- account (the real ERC/DCA shape); `readonly_admin` additionally
-- proves the guard stands even ahead of the admin bypass, since several
-- of the triggers/RPCs check core.is_read_only() before
-- core.is_system_caller() or core.is_admin().
-- =======================================================================

reset role;
select set_config('request.jwt.claims', null, true);

insert into t_ids (k, v)
select k, gen_random_uuid() from unnest(array['readonly', 'readonly_admin']) as k;
insert into auth.users (id, email, instance_id, aud, role)
select v, 'test-' || k || '@lra.invalid', '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated'
from t_ids where k in ('readonly', 'readonly_admin');
insert into core.people (person_code, first_name, last_name, email)
select 'TEST-' || upper(k), initcap(k), 'Persona', 'test-' || k || '@lra.invalid'
from t_ids where k in ('readonly', 'readonly_admin');
insert into core.users (id, email, authority, person_id, read_only)
select t.v, 'test-' || t.k || '@lra.invalid',
       (case when t.k = 'readonly_admin' then 'admin' else 'founder' end)::core.authority,
       (select id from core.people where person_code = 'TEST-' || upper(t.k)),
       true
from t_ids t where t.k in ('readonly', 'readonly_admin');
insert into core.memberships (user_id, module, position)
select v, 'ops', 'other' from t_ids where k in ('readonly', 'readonly_admin');

set local role authenticated;

-- === Reads are UNTOUCHED: a read-only founder sees exactly what
--     oversight sees (same full-visibility count as attack 26's
--     oversight assertion). ===

select pg_temp.become((select uid from p where k='readonly'));
select pg_temp.expect_rows('read-only',
  'a read-only founder still reads every test person, same as oversight',
  $sql$select count(*) from core.people where person_code like 'TEST-%'$sql$,
  (select count(*)::int from t_ids));
select pg_temp.expect_rows('read-only',
  'a read-only founder still reads every visible TEST task',
  $sql$select count(*) from ops.tasks where title like 'TEST-%'$sql$,
  (select count(*)::int from t_meta where k in ('main', 'task2', 'task3', 'taskA', 'taskB')));

-- === core.people / core.users / core.memberships ===

select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot insert a core.people row (also not admin, belt and suspenders)',
  $sql$insert into core.people (person_code, first_name, last_name, email)
       values ('TEST-RO-FORGED', 'Forged', 'Person', 'test-ro-forged@lra.invalid')$sql$);

select pg_temp.become((select uid from p where k='readonly_admin'));
select pg_temp.expect_blocked('read-only',
  'a read-only ADMIN cannot update core.users -- the guard stands ahead of the admin bypass',
  $sql$update core.users set last_login = now() where id = (select uid from p where k='readonly_admin')$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only ADMIN cannot grant authority to another account either',
  $sql$update core.users set authority = 'admin' where id = (select uid from p where k='sales')$sql$);

-- === core.notifications -- own is_read toggle ===

-- Seeded as the system caller: there is no INSERT policy for
-- `authenticated` on core.notifications at all (the forgeable-inbox
-- defect, core_notifications_audit.sql) -- the read-only persona could
-- not create this fixture row for themselves even if the attack below
-- did not exist.
reset role;
select set_config('request.jwt.claims', null, true);
insert into core.notifications (user_id, title, message)
select (select uid from p where k='readonly'), 'TEST notification', 'seeded for the read-only guard';
set local role authenticated;

select pg_temp.become((select uid from p where k='readonly'));
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot even mark their own notification read',
  $sql$update core.notifications set is_read = true
       where user_id = (select uid from p where k='readonly') and title = 'TEST notification'$sql$);

-- === core.audit_logs ===

select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot insert an audit row, even claiming themselves',
  $sql$insert into core.audit_logs (actor_id, action, entity_type)
       values ((select uid from p where k='readonly'), 'TEST-readonly-forge', 'test.forge')$sql$);

-- === ops.settings ===

select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot change ops.settings',
  $sql$update ops.settings set recurring_cap_pct = 0.30$sql$);

-- === ops.weeks (direct write, and the three RPCs) ===

select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot insert a new ops.weeks row',
  $sql$insert into ops.weeks (week_start, state) values ('2099-03-02', 'planning')$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot directly update ops.weeks',
  $sql$update ops.weeks set briefing_opened_at = now() where week_start = ops.week_start_for(now())$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot call ops.generate_recurring_tasks',
  $sql$select ops.generate_recurring_tasks((select id from ops.weeks where week_start = ops.week_start_for(now())))$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot call ops.roll_over_week',
  $sql$select ops.roll_over_week((select id from ops.weeks where week_start = ops.week_start_for(now())))$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot call ops.close_week',
  $sql$select ops.close_week((select id from ops.weeks where week_start = ops.week_start_for(now())))$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot call ops.open_briefing',
  $sql$select ops.open_briefing((select id from ops.weeks where week_start = ops.week_start_for(now())))$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot call ops.close_briefing',
  $sql$select ops.close_briefing((select id from ops.weeks where week_start = ops.week_start_for(now())))$sql$);

-- === ops.task_types / ops.recurring_templates, incl. the hard-delete RPC ===

select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot re-price a catalog type',
  $sql$update ops.task_types set default_points = 21 where id = (select v from t_meta where k='task_type')$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot insert a new catalog type',
  $sql$insert into ops.task_types (name, category, guideline_note, is_active)
       values ('TEST-RO-forged-type', 'Test', 'DRAFT — forged', true)$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot call ops.delete_task_type_if_unused',
  $sql$select ops.delete_task_type_if_unused((select v from t_meta where k='task_type'))$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot edit a recurring template',
  $sql$update ops.recurring_templates set is_active = is_active
       where id = (select id from ops.recurring_templates where position = 'sales' limit 1)$sql$);

-- === ops.tasks -- create, transition, delete ===

select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot create a new task',
  $sql$insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
       select w.id, (select uid from p where k='readonly'), (select v from t_meta where k='task_type'),
              'TEST-RO-forged-task', 'todo', (select uid from p where k='readonly')
       from ops.weeks w where w.week_start = ops.week_start_for(now())$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot move someone else''s task, even oversight-eligible transitions',
  $sql$update ops.tasks set status = 'in_progress' where id = (select v from t_meta where k='main')$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot set a points override',
  $sql$update ops.tasks set points_override = 13, points_override_reason = 'read-only trying anyway'
       where id = (select v from t_meta where k='main')$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot delete a task',
  $sql$delete from ops.tasks where id = (select v from t_meta where k='main') and status = 'todo'$sql$);

-- === ops.task_blocks / ops.task_notes ===

select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot declare a block',
  $sql$insert into ops.task_blocks (task_id, target, blocking_task_id, reason, created_by)
       values ((select v from t_meta where k='main'), 'task',
               (select v from t_meta where k='taskA'), 'read-only trying to declare a block',
               (select uid from p where k='readonly'))$sql$);
select pg_temp.expect_blocked('read-only',
  'a read-only founder cannot add a worklog note, even to a task they could otherwise see',
  $sql$insert into ops.task_notes (task_id, author_user_id, body)
       values ((select v from t_meta where k='main'), (select uid from p where k='readonly'),
               'read-only trying to narrate a task that is not theirs')$sql$);

-- === core.purge_due_accounts -- the one admin-only surface, proven via readonly_admin ===

select pg_temp.become((select uid from p where k='readonly_admin'));
select pg_temp.expect_blocked('read-only',
  'a read-only ADMIN cannot run core.purge_due_accounts',
  $sql$select core.purge_due_accounts()$sql$);

-- =======================================================================
-- The definition lock, and GM edit requests
-- (20260910140000_ops_task_edit_requests.sql).
--
-- Once a task is committed and its week has left `planning`, its
-- defining fields (title/description/task_type_id/owner_user_id/
-- client_ref) are frozen for everyone except founder/admin -- NOT GM,
-- even though GM passes `core.is_oversight()` everywhere else in this
-- file. Status transitions, notes and blocks are untouched -- the
-- regression that matters most is proven explicitly below. GM's only
-- path to a locked definition is `ops.task_edit_requests`, decided by
-- the clearing founder, who may not decide their own.
--
-- taskA is reused from the commitments section above: still committed,
-- still owned by sales, sitting in the now-`open` week -- exactly the
-- record this feature exists to protect.
-- =======================================================================

-- Captures a RETURNING id from an otherwise-normal expect_allowed check,
-- so a legitimate INSERT can be asserted AND reused by a later step
-- (approve/reject/withdraw) without a second, unprotected top-level
-- statement that could abort the whole transaction if it ever regresses.
create function pg_temp.expect_allowed_capture(p_area text, p_label text, p_sql text, p_key text)
returns void language plpgsql as $$
declare v_id uuid;
begin
  execute p_sql into v_id;
  insert into t_meta (k, v) values (p_key, v_id);
  insert into t_results (area, label, outcome, passed)
  values (p_area, p_label, 'allowed', true);
exception when others then
  insert into t_results (area, label, outcome, passed)
  values (p_area, p_label, 'REFUSED - expected success: ' || left(sqlerrm, 60), false);
end $$;

-- The clearing founder CAN still edit a locked committed task directly
-- -- Chan's explicit "only admin and founder" exemption.
select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_allowed('definition-lock',
  'the clearing founder CAN edit a locked committed task''s description directly, no request needed',
  $sql$update ops.tasks set description = 'founder note added directly'
       where id = (select v from t_meta where k='taskA')$sql$);

-- Staff cannot rewrite what they committed to.
select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('definition-lock',
  'staff cannot rewrite a locked committed task''s title',
  $sql$update ops.tasks set title = 'TAMPERED-definition' where id = (select v from t_meta where k='taskA')$sql$);

-- THE regression that matters most: the definition lock must never
-- become a progress lock. The owner can still move their own committed
-- task exactly as before.
select pg_temp.expect_allowed('definition-lock',
  'staff CAN still move a locked committed task''s status (todo -> in_progress)',
  $sql$update ops.tasks set status = 'in_progress' where id = (select v from t_meta where k='taskA')$sql$);

-- Staff cannot even raise an edit request -- oversight only.
select pg_temp.expect_blocked('edit-requests',
  'staff cannot raise a task edit request at all',
  $sql$insert into ops.task_edit_requests (task_id, requested_by, reason, change_title, proposed_title)
       values ((select v from t_meta where k='taskA'), (select uid from p where k='sales'),
               'trying to route around the lock myself', true, 'TEST-taskA (staff-forged)')$sql$);

-- GM cannot edit the locked definition directly either -- not exempted,
-- unlike founder/admin (Chan: "Only admin and founder... GM can flag").
select pg_temp.become((select uid from p where k='gm'));
select pg_temp.expect_blocked('definition-lock',
  'GM cannot rewrite a locked committed task''s owner directly',
  $sql$update ops.tasks set owner_user_id = (select uid from p where k='broker')
       where id = (select v from t_meta where k='taskA')$sql$);

-- GM's real path: raise a task edit request carrying the exact proposed
-- change.
select pg_temp.expect_allowed_capture('edit-requests',
  'GM CAN raise a task edit request for a locked committed task',
  $sql$insert into ops.task_edit_requests (task_id, requested_by, reason, change_title, proposed_title)
       values ((select v from t_meta where k='taskA'), (select uid from p where k='gm'),
               'client renamed the shipment reference on the BL', true, 'TEST-taskA (renamed)')
       returning id$sql$,
  'edit_req1');

-- A read-only founder can neither raise nor approve one.
select pg_temp.become((select uid from p where k='readonly'));
select pg_temp.expect_blocked('edit-requests',
  'a read-only founder cannot raise a task edit request',
  $sql$insert into ops.task_edit_requests (task_id, requested_by, reason, change_title, proposed_title)
       values ((select v from t_meta where k='taskA'), (select uid from p where k='readonly'),
               'read-only trying to raise a request anyway', true, 'TEST-taskA (RO-forged)')$sql$);

select pg_temp.become((select uid from p where k='readonly_admin'));
select pg_temp.expect_blocked('edit-requests',
  'a read-only ADMIN cannot approve a task edit request -- the guard stands ahead of the clearing-founder/admin bypass',
  $sql$update ops.task_edit_requests set status = 'approved' where id = (select v from t_meta where k='edit_req1')$sql$);

-- A non-clearing founder cannot approve one either (mirrors the
-- cancellation ladder's founder2 precedent exactly).
select pg_temp.become((select uid from p where k='founder2'));
select pg_temp.expect_blocked('edit-requests',
  'a non-clearing founder cannot approve a task edit request',
  $sql$update ops.task_edit_requests set status = 'approved' where id = (select v from t_meta where k='edit_req1')$sql$);

-- GM (the requester, and not the clearing founder either) cannot
-- approve its own request.
select pg_temp.become((select uid from p where k='gm'));
select pg_temp.expect_blocked('edit-requests',
  'the GM requester cannot approve their own edit request',
  $sql$update ops.task_edit_requests set status = 'approved' where id = (select v from t_meta where k='edit_req1')$sql$);

-- The self-approval guard specifically, isolated from the
-- clearing-founder gate above: the clearing founder raises their OWN
-- request and is still refused deciding it.
select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_allowed_capture('edit-requests',
  'the clearing founder CAN raise their own edit request (fixture for the self-approval check below)',
  $sql$insert into ops.task_edit_requests (task_id, requested_by, reason, change_description, proposed_description)
       values ((select v from t_meta where k='taskA'), (select uid from p where k='founder'),
               'adding my own context note via the request path', true, 'Founder note via edit-request path')
       returning id$sql$,
  'edit_req_self');

select pg_temp.expect_blocked('edit-requests',
  'the clearing founder cannot approve their own edit request, even though they hold the deciding seat',
  $sql$update ops.task_edit_requests set status = 'approved' where id = (select v from t_meta where k='edit_req_self')$sql$);

-- The legitimate decision: the clearing founder approves GM's request,
-- and the change actually lands atomically.
select pg_temp.expect_allowed('edit-requests',
  'the clearing founder CAN approve GM''s task edit request',
  $sql$update ops.task_edit_requests set status = 'approved' where id = (select v from t_meta where k='edit_req1')$sql$);

select pg_temp.expect_rows('edit-requests',
  'approval actually applied the proposed title to ops.tasks',
  $sql$select count(*) from ops.tasks where id = (select v from t_meta where k='taskA')
       and title = 'TEST-taskA (renamed)'$sql$, 1);

select pg_temp.expect_rows('edit-requests',
  'the approved request recorded after_values for the applied change',
  $sql$select count(*) from ops.task_edit_requests where id = (select v from t_meta where k='edit_req1')
       and status = 'approved' and after_values ->> 'title' = 'TEST-taskA (renamed)'$sql$, 1);

-- =======================================================================
-- 2026-09-10 adversarial sweep fixes
-- (docs/test-evidence/2026-09-10-adversarial-sweep.md,
--  20260910160000_adversarial_sweep_fixes.sql). One attack per defect,
-- plus the allow cases that prove nothing legitimate broke -- lesson §7
-- exists precisely because a suite of only-refusal assertions can go
-- green while the real path is broken.
-- =======================================================================

-- === Defect 1: core.memberships SELECT was infinitely recursive =======
--
-- Before the fix this raised 42P17 for every caller, admin or not.
-- Regression: a plain non-admin member can read the table at all, and
-- sees every active membership (module-agnostic, matching the policy's
-- own original EXISTS) -- not just their own row. Counted against
-- `t_ids` rather than a hardcoded number, and scoped to this file's own
-- fixture user_ids, so pre-existing production membership rows in a
-- real target database cannot make this assertion flaky either way.

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_rows('memberships',
  'a non-admin authenticated member can SELECT core.memberships without recursing, '
  'and sees every active test membership',
  $sql$select count(*) from core.memberships where user_id in (select v from t_ids)$sql$,
  (select count(*)::int from t_ids where k <> 'other'));

-- === Defect 2: founder_id/founder_acted_at/cleared_at/points_awarded ===
--     forgeable at any status, not just via the transition that stamps
--     them.
--
-- task3 (owner: gm, still sitting at 'submitted' since attack 8 refused
-- the GM's own self-verify attempt) is reused so the attack has a task
-- that has never been cleared.

select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_blocked('ladder',
  'a founder cannot forge points_awarded on a task that is not being cleared '
  '(status stays submitted, no transition at all)',
  $sql$update ops.tasks set points_awarded = 999 where id = (select v from t_meta where k='task3')$sql$);

select pg_temp.expect_allowed('lifecycle',
  'the founder CAN verify task3 (owner is the GM, so only a founder -- not a GM -- may verify)',
  $sql$update ops.tasks set status = 'verified' where id = (select v from t_meta where k='task3')$sql$);

select pg_temp.expect_blocked('ladder',
  'a founder still cannot forge points_awarded once verified, off the real cleared transition',
  $sql$update ops.tasks set points_awarded = 999 where id = (select v from t_meta where k='task3')$sql$);

select pg_temp.expect_blocked('ladder',
  'a founder still cannot forge cleared_at directly either -- same guard, same root cause',
  $sql$update ops.tasks set cleared_at = now() where id = (select v from t_meta where k='task3')$sql$);

select pg_temp.expect_allowed('lifecycle',
  'the clearing founder CAN clear task3, and the real verified -> cleared transition '
  'still awards points correctly',
  $sql$update ops.tasks set status = 'cleared' where id = (select v from t_meta where k='task3')$sql$);

select pg_temp.expect_rows('ladder',
  'task3 was awarded the catalog default (8 points) by the trigger, not the forged 999',
  $sql$select points_awarded from ops.tasks where id = (select v from t_meta where k='task3')$sql$, 8);

-- === Defect 3: ops.task_blocks.created_at/resolved_at were fully
--     client-controlled. ===

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_allowed_capture('blocks',
  'a member CAN declare a block on their own task (creation itself is not refused '
  'by the new timestamp trigger)',
  $sql$insert into ops.task_blocks (task_id, target, blocking_user_id, reason, created_by, created_at)
       values ((select v from t_meta where k='main'), 'person',
               (select uid from p where k='broker'), 'probe: trying to backdate a block 9 days',
               (select uid from p where k='sales'), now() - interval '9 days')
       returning id$sql$,
  'backdated_block');

select pg_temp.expect_rows('blocks',
  'the fabricated 9-day-old created_at was NOT accepted -- the row is server-stamped '
  'with the real time instead',
  $sql$select count(*) from ops.task_blocks
       where id = (select v from t_meta where k='backdated_block')
         and created_at > now() - interval '1 minute'$sql$, 1);

select pg_temp.expect_blocked('blocks',
  'created_at cannot be altered after insert, even by the block''s own creator',
  $sql$update ops.task_blocks set created_at = now() - interval '30 days'
       where id = (select v from t_meta where k='backdated_block')$sql$);

select pg_temp.expect_allowed('blocks',
  'the block''s creator CAN resolve it normally -- the resolve action itself is not refused',
  $sql$update ops.task_blocks set resolved_at = now() - interval '9 days'
       where id = (select v from t_meta where k='backdated_block')$sql$);

select pg_temp.expect_rows('blocks',
  'resolved_at was server-stamped with the real time, not the 9-day-old value the client sent',
  $sql$select count(*) from ops.task_blocks
       where id = (select v from t_meta where k='backdated_block')
         and resolved_at > now() - interval '1 minute'$sql$, 1);

select pg_temp.expect_blocked('blocks',
  'resolved_at cannot be altered again once a block has been resolved',
  $sql$update ops.task_blocks set resolved_at = now() - interval '30 days'
       where id = (select v from t_meta where k='backdated_block')$sql$);

-- =======================================================================
-- Auditing the founder/admin direct-edit path, and refusing an INSERT
-- into a closed week (20260910170000_audit_direct_edits_and_closed_
-- week_guard.sql). taskA is reused again: still committed, still in the
-- now-`open` week -- exactly the record this whole feature protects.
-- =======================================================================

-- === Item 1: a direct definition edit now writes an audit row ========

select pg_temp.become((select uid from p where k='founder'));
select pg_temp.expect_allowed('audit-direct-edit',
  'the clearing founder CAN still edit taskA''s client_ref directly (guard 2b''s exemption, untouched)',
  $sql$update ops.tasks set client_ref = 'TEST-taskA-direct-edit-client-ref'
       where id = (select v from t_meta where k='taskA')$sql$);

select pg_temp.expect_rows('audit-direct-edit',
  'that direct edit wrote exactly one audit_logs row carrying before/after client_ref',
  $sql$select count(*) from core.audit_logs
       where entity_type = 'ops.task' and entity_id = (select v from t_meta where k='taskA')
         and action = 'ops.task.definition_edited_directly'
         and old_values ? 'client_ref'
         and new_values ->> 'client_ref' = 'TEST-taskA-direct-edit-client-ref'
         and (old_values ->> 'client_ref') is distinct from 'TEST-taskA-direct-edit-client-ref'$sql$,
  1);

-- === Item 1, the "do not drown the signal" half: an ordinary edit to
--     an uncommitted task in a `planning` week writes NO audit row ====
--
-- A fresh week and a fresh task, never committed -- old.is_committed is
-- false, so 0c's condition never applies. This must behave exactly as
-- it always has.

reset role;
select set_config('request.jwt.claims', null, true);
insert into ops.weeks (week_start, state) values ('2099-04-06', 'planning');
with ins as (
  insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
  select w.id, (select uid from p where k='broker'), (select v from t_meta where k='task_type'),
         'TEST-taskPlanning', 'todo', (select uid from p where k='broker')
  from ops.weeks w where w.week_start = '2099-04-06'
  returning id
)
insert into t_meta (k, v) select 'taskPlanning', id from ins;
set local role authenticated;

select pg_temp.become((select uid from p where k='broker'));
select pg_temp.expect_allowed('audit-direct-edit',
  'an ordinary edit to an uncommitted task in a planning week still works, untouched by this fix',
  $sql$update ops.tasks set title = 'TEST-taskPlanning (edited)'
       where id = (select v from t_meta where k='taskPlanning')$sql$);

select pg_temp.expect_rows('audit-direct-edit',
  'that ordinary planning-week edit wrote NO audit row -- the signal stays reserved for a real, '
  'locked-definition edit, not every edit anyone ever makes',
  $sql$select count(*) from core.audit_logs
       where entity_type = 'ops.task' and entity_id = (select v from t_meta where k='taskPlanning')
         and action = 'ops.task.definition_edited_directly'$sql$,
  0);

-- === Regression guard for the suppression flag: the GM's edit-request
--     approval earlier in this file (edit_req1, which renamed taskA to
--     'TEST-taskA (renamed)') must have written exactly its own audit
--     row, not a second one from this migration's new 0c block re-
--     entering ops.tasks' trigger via the request's internal UPDATE ===

-- Read these two as the founder, NOT as broker. `core.audit_logs`'
-- SELECT policy is `actor_id = me OR core.can_read_audit(...)`, and
-- can_read_audit grants oversight everything but a plain staff member
-- only their OWN ops.task rows -- and nothing at all for entity_type
-- 'ops.task_edit_request'. Left as broker, the "expected 1" assertion
-- below failed for a pure visibility reason with the trigger working
-- perfectly, AND the "expected 0" assertion passed vacuously: it would
-- have gone green even if the duplicate row it exists to catch were
-- really there. Lesson §4 -- verify the instrumentation can see the
-- thing before believing either a positive or a negative from it.
select pg_temp.become((select uid from p where k='founder'));

select pg_temp.expect_rows('audit-direct-edit',
  'GM''s approved edit request produced NO duplicate row from the direct-edit trigger it '
  're-enters internally -- the suppression flag held',
  $sql$select count(*) from core.audit_logs
       where entity_type = 'ops.task' and entity_id = (select v from t_meta where k='taskA')
         and action = 'ops.task.definition_edited_directly'
         and new_values ->> 'title' = 'TEST-taskA (renamed)'$sql$,
  0);

select pg_temp.expect_rows('audit-direct-edit',
  'the approved edit request itself still has its own, single audit row (unaffected by this migration)',
  $sql$select count(*) from core.audit_logs
       where entity_type = 'ops.task_edit_request'
         and action = 'ops.task_edit_request.approved'
         and new_values -> 'after_values' ->> 'title' = 'TEST-taskA (renamed)'$sql$,
  1);

-- === Item 2: an INSERT into an already-closed week is refused, and the
--     mid-week `open` case -- the allow that matters most -- still works.
-- =======================================================================

reset role;
select set_config('request.jwt.claims', null, true);
insert into ops.weeks (week_start, state) values ('2099-05-04', 'closed');
set local role authenticated;

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_blocked('week-guard',
  'a task cannot be INSERTed into an already-closed week',
  $sql$insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
       select w.id, (select uid from p where k='sales'), (select v from t_meta where k='task_type'),
              'TEST-closed-week-insert', 'todo', (select uid from p where k='sales')
       from ops.weeks w where w.week_start = '2099-05-04'$sql$);

-- The allow case that matters most: the file's own current week is
-- `open` at this point (closed the briefing earlier, via
-- ops.close_briefing, well before this section) -- mid-week task
-- creation must keep working exactly as before.
select pg_temp.expect_allowed('week-guard',
  'a task CAN still be INSERTed into the current, mid-week `open` week -- getting this wrong '
  'would make it impossible to log any work discovered after Monday',
  $sql$insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
       select w.id, (select uid from p where k='sales'), (select v from t_meta where k='task_type'),
              'TEST-open-week-insert', 'todo', (select uid from p where k='sales')
       from ops.weeks w where w.week_start = ops.week_start_for(now())$sql$);

reset role;

-- =======================================================================
-- Who may resolve a block
-- (20260910190000_ops_task_block_owner_resolves.sql).
--
-- The policy grants four identities, and this section proves each one
-- separately plus the two refusals that matter. Every assertion needs
-- its OWN block row: `ops.stamp_task_block_timestamps` makes
-- `resolved_at` immutable once set, so a resolved block cannot be
-- reused as the fixture for the next attempt.
--
-- The personas are chosen so each allow exercises exactly ONE branch:
--   * `broker` resolving a block on their own task is the NEW branch
--     alone -- they did not declare it (sales did) and they are not its
--     named blocking user (gm is), and they are staff, so
--     core.is_oversight() is false;
--   * `broker` resolving a block on SALES's task is the named-blocking-
--     user branch alone -- there they own nothing;
--   * `sales` resolving their own declaration is the creator branch.
-- =======================================================================

reset role;
select set_config('request.jwt.claims', null, true);

-- A staff ops member with no relationship at all to the blocks below --
-- not an owner, not a creator, not a named blocking user. The existing
-- `other` persona cannot serve here: it is deliberately NOT an ops
-- member, so it would be refused by core.is_member('ops') and the test
-- would pass for the wrong reason.
insert into t_ids (k, v) select 'blk_bystander', gen_random_uuid();
insert into auth.users (id, email, instance_id, aud, role)
select v, 'test-' || k || '@lra.invalid', '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated'
from t_ids where k = 'blk_bystander';
insert into core.people (person_code, first_name, last_name, email)
select 'TEST-' || upper(k), 'Blk', 'Bystander', 'test-' || k || '@lra.invalid'
from t_ids where k = 'blk_bystander';
insert into core.users (id, email, authority, person_id)
select t.v, 'test-' || t.k || '@lra.invalid', 'staff'::core.authority,
       (select id from core.people where person_code = 'TEST-' || upper(t.k))
from t_ids t where t.k = 'blk_bystander';
insert into core.memberships (user_id, module, position)
select v, 'ops', 'other' from t_ids where k = 'blk_bystander';

-- Three tasks, one per owner the assertions below need. Created as the
-- system role for the same reason the Phase 3 fixtures above are.
with ins as (
  insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
  select w.id, (select uid from p where k='broker'), (select v from t_meta where k='task_type'),
         'TEST-blk-owned-by-broker', 'in_progress', (select uid from p where k='broker')
  from ops.weeks w where w.week_start = ops.week_start_for(now())
  returning id
)
insert into t_meta (k, v) select 'blk_task_broker', id from ins;

with ins as (
  insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
  select w.id, (select uid from p where k='sales'), (select v from t_meta where k='task_type'),
         'TEST-blk-owned-by-sales', 'in_progress', (select uid from p where k='sales')
  from ops.weeks w where w.week_start = ops.week_start_for(now())
  returning id
)
insert into t_meta (k, v) select 'blk_task_sales', id from ins;

with ins as (
  insert into ops.tasks (week_id, owner_user_id, task_type_id, title, status, created_by)
  select w.id, (select uid from p where k='readonly'), (select v from t_meta where k='task_type'),
         'TEST-blk-owned-by-readonly', 'in_progress', (select uid from p where k='readonly')
  from ops.weeks w where w.week_start = ops.week_start_for(now())
  returning id
)
insert into t_meta (k, v) select 'blk_task_readonly', id from ins;

-- Five open blocks, all declared BY sales (so `created_by` is never the
-- persona under test except in the creator case), all naming gm as the
-- blocking user (so `blocking_user_id` is never the persona under test
-- except in the named-user case).
with ins as (
  insert into ops.task_blocks (task_id, target, blocking_user_id, reason, created_by)
  values ((select v from t_meta where k='blk_task_broker'), 'person',
          (select uid from p where k='gm'), 'waiting on the GM to send the file',
          (select uid from p where k='sales'))
  returning id
)
insert into t_meta (k, v) select 'blk_for_owner', id from ins;

with ins as (
  insert into ops.task_blocks (task_id, target, blocking_user_id, reason, created_by)
  values ((select v from t_meta where k='blk_task_broker'), 'person',
          (select uid from p where k='gm'), 'waiting on the GM to send the second file',
          (select uid from p where k='sales'))
  returning id
)
insert into t_meta (k, v) select 'blk_for_creator', id from ins;

with ins as (
  insert into ops.task_blocks (task_id, target, blocking_user_id, reason, created_by)
  values ((select v from t_meta where k='blk_task_sales'), 'person',
          (select uid from p where k='broker'), 'waiting on the broker to confirm the listing',
          (select uid from p where k='sales'))
  returning id
)
insert into t_meta (k, v) select 'blk_for_named_user', id from ins;

with ins as (
  insert into ops.task_blocks (task_id, target, blocking_user_id, reason, created_by)
  values ((select v from t_meta where k='blk_task_broker'), 'person',
          (select uid from p where k='gm'), 'waiting on the GM to send the third file',
          (select uid from p where k='sales'))
  returning id
)
insert into t_meta (k, v) select 'blk_for_bystander', id from ins;

with ins as (
  insert into ops.task_blocks (task_id, target, blocking_user_id, reason, created_by)
  values ((select v from t_meta where k='blk_task_readonly'), 'person',
          (select uid from p where k='gm'), 'waiting on the GM before the read-only owner can move',
          (select uid from p where k='sales'))
  returning id
)
insert into t_meta (k, v) select 'blk_for_readonly_owner', id from ins;

set local role authenticated;

-- === THE DEFECT ITSELF: the owner of the blocked task ================

select pg_temp.become((select uid from p where k='broker'));
select pg_temp.expect_allowed('blocks',
  'the OWNER of a blocked task CAN resolve a block they did not declare -- the defect '
  'Chan reported ("users cant unblock a task"): the board showed them the Resolve '
  'button and RLS refused the write',
  $sql$update ops.task_blocks
       set resolved_at = now(), resolved_by = (select uid from p where k='broker')
       where id = (select v from t_meta where k='blk_for_owner')$sql$);

select pg_temp.expect_rows('blocks',
  'that resolve really landed -- the block is closed, not merely un-refused',
  $sql$select count(*) from ops.task_blocks
       where id = (select v from t_meta where k='blk_for_owner') and resolved_at is not null$sql$, 1);

-- === The three branches that already existed, still intact ===========

select pg_temp.become((select uid from p where k='sales'));
select pg_temp.expect_allowed('blocks',
  'the block''s CREATOR can still resolve it (unchanged branch)',
  $sql$update ops.task_blocks
       set resolved_at = now(), resolved_by = (select uid from p where k='sales')
       where id = (select v from t_meta where k='blk_for_creator')$sql$);

select pg_temp.become((select uid from p where k='broker'));
select pg_temp.expect_allowed('blocks',
  'the NAMED blocking user can still resolve a block on someone else''s task, where they '
  'are neither owner nor creator (unchanged branch)',
  $sql$update ops.task_blocks
       set resolved_at = now(), resolved_by = (select uid from p where k='broker')
       where id = (select v from t_meta where k='blk_for_named_user')$sql$);

-- === The refusals ====================================================

select pg_temp.become((select uid from p where k='blk_bystander'));
select pg_temp.expect_blocked('blocks',
  'an unrelated staff ops member CANNOT resolve a block -- the new owner branch widens '
  'authority by exactly one identity, not to every member',
  $sql$update ops.task_blocks
       set resolved_at = now(), resolved_by = (select uid from p where k='blk_bystander')
       where id = (select v from t_meta where k='blk_for_bystander')$sql$);

select pg_temp.become((select uid from p where k='readonly'));
select pg_temp.expect_blocked('blocks',
  'a read-only founder CANNOT resolve a block even on a task they own -- the new branch '
  'sits inside the `not core.is_read_only()` wrapper, like every other branch',
  $sql$update ops.task_blocks
       set resolved_at = now(), resolved_by = (select uid from p where k='readonly')
       where id = (select v from t_meta where k='blk_for_readonly_owner')$sql$);

select pg_temp.expect_rows('blocks',
  'both refused blocks are still open, so neither refusal was a silent partial write',
  $sql$select count(*) from ops.task_blocks
       where id in ((select v from t_meta where k='blk_for_bystander'),
                    (select v from t_meta where k='blk_for_readonly_owner'))
         and resolved_at is null$sql$, 2);

reset role;

-- ---------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------

select area, label, outcome, case when coalesce(passed,false) then 'pass' else 'FAIL' end as result
from t_results order by id;

select
  count(*) filter (where coalesce(passed,false) and area <> 'CANARY')    as passed,
  count(*) filter (where not coalesce(passed,false) and area <> 'CANARY') as failed,
  case
    when bool_or(passed) filter (where area = 'CANARY')
      then 'BROKEN: canary passed, so this suite is not testing RLS. Ignore all results above.'
    when count(*) filter (where not coalesce(passed,false) and area <> 'CANARY') = 0
      then 'ALL PASS (canary correctly failed)'
    else 'FAILURES PRESENT'
  end as verdict
from t_results;

rollback;
