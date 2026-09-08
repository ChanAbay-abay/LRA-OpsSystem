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
select v, 'ops', (case when k in ('sales','broker') then k else 'other' end)::core.position
from t_ids
where k <> 'other';   -- 'other' is deliberately not an ops member -- the read-scoping victim.

create temp view p as select k, v as uid from t_ids;
grant select on p to authenticated;

insert into ops.weeks (week_start, state)
values (ops.week_start_for(now()), 'planning')
on conflict (week_start) do nothing;

insert into core.notifications (user_id, title, message)
select v, 'TEST notification', 'seeded for the update-guard attack'
from t_ids where k = 'sales';

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
  $sql$select count(*) from core.people where person_code like 'TEST-%'$sql$, 5);

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
  $sql$select count(*) from core.people where person_code like 'TEST-%'$sql$, 5);

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
