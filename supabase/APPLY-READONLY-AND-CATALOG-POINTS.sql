-- =====================================================================
-- LRA Ops :: APPLY-READONLY-AND-CATALOG-POINTS.sql
--
-- Consolidated, ordered, ready-to-paste SQL for the Supabase SQL editor.
-- Generated 2026-09-09. This is the same pattern as
-- APPLY-TO-PRODUCTION.sql and APPLY-PHASE-3-4-5.sql: no agent in this
-- project has ever held DDL credentials, so Chan applies migrations by
-- pasting them into the SQL editor.
--
-- It contains, in order:
--   1. 20260910120000_price_catalog_for_testing.sql
--   2. 20260910120100_core_read_only_accounts.sql
--
-- ⚠️  NEITHER MIGRATION HAS BEEN EXECUTED ANYWHERE. They were written
-- by hand-tracing every live function body and policy; the logic was
-- reviewed carefully, but nothing here has met a database. Treat the
-- first run as a test, not a confirmation.
--
-- What it does NOT do: it does not drop anything, does not touch `auth`,
-- and does not change any read path. Both migrations are additive.
--
-- 1. CATALOG POINTS. Sets a Fibonacci `points` value on every seeded
--    ops.task_types row so the system can be exercised end to end.
--    These numbers are a STAND-IN chosen by an agent, not company
--    policy. The `PLACEHOLDER —` prefix on every guideline_note is
--    deliberately preserved, so /catalog keeps showing its nag banner
--    and the Phase 6 gate stays shut until Chan prices the catalog with
--    his team.
--
-- 2. READ-ONLY ACCOUNTS. Adds core.users.read_only + core.is_read_only()
--    and guards every write surface with it: 12 tables' write policies
--    and 14 security-definer functions across core and ops. This is what
--    makes the ERC and DCA founder accounts observers — identical read
--    scope to a founder, refused on every write.
--
--    The guard is placed AHEAD of the is_admin() bypass in the triggers
--    on purpose, so a read-only admin is still read-only.
--
-- AFTER APPLYING, run the RLS suite (supabase/tests/rls_test.sql). It
-- now carries attack 12 plus a ~20-assertion read-only block. It must
-- print: ALL PASS (canary correctly failed)
--
-- If anything in here fails, STOP and report the error rather than
-- editing around it — a half-applied read-only sweep is worse than none,
-- because it looks enforced and is not.
-- =====================================================================

-- ============ 1/2 : 20260910120000_price_catalog_for_testing.sql ============

-- =====================================================================
-- LRA Ops :: price the catalog for testing (still not the founder's
-- real answer)
--
-- Chan has not yet done the sit-down that OPEN-QUESTIONS.md #3 and
-- PLAN.md's own framing call for -- pricing the catalog is the
-- founder's judgement about his own business, and an agent guessing it
-- would launder a guess into company policy. He asked for real,
-- exercisable numbers now so commitments, the scorecard and the
-- leaderboard can be trialled while that sit-down is still pending.
--
-- Two things, on top of 20260909180000's PLACEHOLDER pass:
--
-- 1. Recurring/admin work is the price of admission, not an
--    achievement, and must sit at or above a floor of 3 points -- the
--    same framing that pass already used for most rows. Three recurring
--    types were left at 2 in that first pass; raised to 3 here.
-- 2. Every guideline_note gets an explicit sentence that this number is
--    a stand-in for testing, appended AFTER the existing text -- never
--    replacing it, and the `PLACEHOLDER —` prefix that pass wrote is
--    left completely untouched. /catalog's banner
--    (`apps/web/src/routes/catalog.tsx`, `isPlaceholder()`) keys off
--    that literal prefix via `/^(PLACEHOLDER|DRAFT)\s*—/` and must keep
--    nagging the founder until he really prices these -- removing or
--    reworking the prefix here would silently turn that banner off.
-- =====================================================================

-- 1. Recurring floor of 3.
update ops.task_types
set default_points = 3
where name in (
  'Daily shipment status update to clients',
  'Client follow-up',
  'Run the Monday briefing'
)
and default_points < 3;

-- 2. The explicit "stand-in for testing" sentence, additive and
--    idempotent -- a second run of this migration (or a future one
--    touching the same rows) will not double the sentence.
update ops.task_types
set guideline_note = guideline_note
  || ' This point value is a stand-in for testing only -- the founder has not priced this catalog yet.'
where guideline_note not like '%stand-in for testing only%';

-- ============ 2/2 : 20260910120100_core_read_only_accounts.sql ============

-- =====================================================================
-- LRA Ops :: read-only founder accounts (ERC, DCA)
--
-- Chan is provisioning three founder accounts: LRA (the clearing
-- founder -- unchanged, still core.users.is_clearing_founder), and ERC
-- + DCA, which must be STRICTLY read-only: they see exactly what
-- oversight sees, and can change nothing at all.
--
-- Modelled exactly like `is_clearing_founder`: a plain boolean column
-- on `core.users`, a `core.is_read_only()` helper of the same shape as
-- `core.is_founder()` / `core.is_oversight()` / `core.is_clearing_founder()`
-- (security definer, pinned search_path, stable), admin-only to set.
--
-- This is a MECHANICAL SWEEP, not a redesign. `core.is_read_only()`
-- reads the CALLER's own row -- never the row being written -- and is
-- added as the very FIRST statement in every write-path RLS policy
-- predicate and every SECURITY DEFINER trigger/RPC in `core` and `ops`,
-- ahead of any existing bypass. That placement is deliberate: unlike
-- `core.is_system_caller()` (true only for a claimless direct
-- connection -- a migration, cron, or the service client with no user
-- JWT), a read-only founder's own request always carries their JWT, so
-- `core.is_system_caller()` is false and `core.is_admin()`/
-- `core.is_oversight()` alone would otherwise let their authority
-- ('founder') sail straight through every existing ladder. The guard
-- must therefore stand apart from, and ahead of, the authority ladder,
-- not be woven into it.
--
-- Every function below is reproduced in full (`create or replace`,
-- never an edit of an applied migration) from its current, live body --
-- traced through every later migration that touched it (the enum-cast
-- and row-lock fixes applied live via `pg_get_functiondef` are folded
-- back into the literal text here, exactly as 20260909150300 already
-- carries them in source).
--
-- Reads are UNTOUCHED: no SELECT policy anywhere in this migration
-- changes. A read-only founder's queries return identically to a
-- clearing founder's.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. The column and the helper.
-- ---------------------------------------------------------------------

alter table core.users
  add column read_only boolean not null default false;

comment on column core.users.read_only is
  'A strictly read-only founder account (ERC, DCA): sees exactly what '
  'oversight sees, may write nothing at all. Admin-only to set (see '
  'core.guard_user_privilege_columns). Independent of authority/'
  'is_clearing_founder -- LRA stays a normal clearing founder with '
  'read_only = false; ERC/DCA are authority = founder, '
  'is_clearing_founder = false, read_only = true.';

create or replace function core.is_read_only()
returns boolean
language sql
stable
security definer
set search_path = core, public
as $$
  select coalesce(
    (select u.read_only from core.users u where u.id = core.auth_user_id()),
    false
  );
$$;

comment on function core.is_read_only() is
  'True only for the CALLER''s own core.users row. Checked as the first '
  'statement of every write-path RLS policy and SECURITY DEFINER '
  'trigger/RPC in core and ops -- ahead of is_system_caller()/is_admin(), '
  'because a read-only founder''s own authority (founder) would otherwise '
  'satisfy every existing oversight/founder check.';

-- ---------------------------------------------------------------------
-- 1. core.users write-path triggers -- extend with read_only as an
--    admin-only column, and refuse a read-only caller's own write
--    outright (defense in depth on top of the RLS policy change below).
-- ---------------------------------------------------------------------

create or replace function core.guard_user_privilege_columns()
returns trigger
language plpgsql
security definer
set search_path = core, public
as $$
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not update core.users'
      using errcode = '42501';
  end if;

  if core.is_system_caller() or core.is_admin() then
    return new;
  end if;

  if new.authority is distinct from old.authority
     or new.person_id is distinct from old.person_id
     or new.is_active is distinct from old.is_active
     or new.is_clearing_founder is distinct from old.is_clearing_founder
     or new.deleted_at is distinct from old.deleted_at
     or new.deleted_by is distinct from old.deleted_by
     or new.purge_due_at is distinct from old.purge_due_at
     or new.read_only is distinct from old.read_only then
    raise exception
      'authority, person_id, is_active, is_clearing_founder, deletion '
      'fields and read_only may only be changed by an admin'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create or replace function core.guard_account_deletion_invariants()
returns trigger
language plpgsql
security definer
set search_path = core, public
as $$
declare
  v_other_active_admins int;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not change core.users'
      using errcode = '42501';
  end if;

  -- A fresh soft-delete: old.deleted_at is null, new.deleted_at is not.
  if old.deleted_at is null and new.deleted_at is not null then

    -- An admin cannot delete their own account. Checked two ways so
    -- neither the API's own service-role write (which sets deleted_by
    -- to the acting admin's id) nor a direct PostgREST attack (which
    -- controls its own JWT but not necessarily what it puts in
    -- deleted_by) can slip past it.
    if new.deleted_by = new.id
       or (not core.is_system_caller() and core.auth_user_id() = new.id) then
      raise exception 'an admin cannot delete their own account'
        using errcode = '42501';
    end if;

    -- The last remaining active admin cannot be deleted, by anyone,
    -- including the system caller. Counted excluding the row being
    -- deleted so this also fails correctly when it is the only admin.
    if old.authority = 'admin' and old.is_active then
      select count(*) into v_other_active_admins
      from core.users u
      where u.authority = 'admin'
        and u.is_active
        and u.deleted_at is null
        and u.id <> new.id;

      if v_other_active_admins = 0 then
        raise exception 'the last remaining active admin cannot be deleted'
          using errcode = '42501';
      end if;
    end if;

    -- Server-computed, always. A client's deleted_at/purge_due_at is
    -- never trusted -- see the column comments above.
    new.deleted_at   := now();
    new.purge_due_at := new.deleted_at + interval '14 days';
    new.is_active    := false;

  -- An explicit admin restore: deleted_at was set, now cleared.
  elsif old.deleted_at is not null and new.deleted_at is null then
    new.deleted_by   := null;
    new.purge_due_at := null;
    new.is_active    := true;

  -- Still deleted (no transition either way this update): a deleted
  -- account can never be granted authority, silently or otherwise --
  -- "cannot be re-activated except by an explicit admin restore" cuts
  -- both ways.
  elsif old.deleted_at is not null and new.deleted_at is not null then
    if new.authority is distinct from old.authority then
      raise exception 'a soft-deleted account cannot be granted authority'
        using errcode = '42501';
    end if;
    new.is_active := false;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. core.notifications is_read-guard trigger.
-- ---------------------------------------------------------------------

create or replace function core.guard_notification_is_read_only()
returns trigger
language plpgsql
security definer
set search_path = core, public
as $$
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not update a notification'
      using errcode = '42501';
  end if;

  if core.is_system_caller() or core.is_admin() then
    return new;
  end if;

  if new.user_id is distinct from old.user_id
     or new.title is distinct from old.title
     or new.message is distinct from old.message
     or new.entity_type is distinct from old.entity_type
     or new.entity_id is distinct from old.entity_id
     or new.link is distinct from old.link
     or new.created_at is distinct from old.created_at then
    raise exception 'only is_read may be changed on a notification'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. RLS policy sweep -- every INSERT/UPDATE/DELETE policy in core and
--    ops gets `and not core.is_read_only()` folded into its predicate.
--    SELECT policies are not touched anywhere in this migration.
-- ---------------------------------------------------------------------

-- core.people
drop policy people_insert on core.people;
create policy people_insert on core.people for insert to authenticated
with check (core.is_admin() and not core.is_read_only());

drop policy people_update on core.people;
create policy people_update on core.people for update to authenticated
using (core.is_admin() and not core.is_read_only())
with check (core.is_admin() and not core.is_read_only());

-- core.users
drop policy users_insert on core.users;
create policy users_insert on core.users for insert to authenticated
with check (core.is_admin() and not core.is_read_only());

drop policy users_update on core.users;
create policy users_update on core.users for update to authenticated
using (
  ((id = core.auth_user_id() and core.caller_is_active()) or core.is_admin())
  and not core.is_read_only()
)
with check (
  ((id = core.auth_user_id() and core.caller_is_active()) or core.is_admin())
  and not core.is_read_only()
);

-- core.memberships
drop policy memberships_insert on core.memberships;
create policy memberships_insert on core.memberships for insert to authenticated
with check (core.is_admin() and not core.is_read_only());

drop policy memberships_update on core.memberships;
create policy memberships_update on core.memberships for update to authenticated
using (core.is_admin() and not core.is_read_only())
with check (core.is_admin() and not core.is_read_only());

-- core.notifications -- own is_read toggle, own delete.
drop policy notifications_update on core.notifications;
create policy notifications_update on core.notifications for update to authenticated
using (user_id = core.auth_user_id() and core.caller_is_active() and not core.is_read_only())
with check (user_id = core.auth_user_id() and core.caller_is_active() and not core.is_read_only());

drop policy notifications_delete on core.notifications;
create policy notifications_delete on core.notifications for delete to authenticated
using (user_id = core.auth_user_id() and core.caller_is_active() and not core.is_read_only());

-- core.audit_logs -- a read-only account can never legitimately reach a
-- privileged act, so it may not claim an actor-stamped audit row either.
drop policy audit_insert on core.audit_logs;
create policy audit_insert on core.audit_logs for insert to authenticated
with check (actor_id = core.auth_user_id() and core.caller_is_active() and not core.is_read_only());

-- ops.settings
drop policy settings_update on ops.settings;
create policy settings_update on ops.settings for update to authenticated
using (core.is_founder() and not core.is_read_only())
with check (core.is_founder() and not core.is_read_only());

-- ops.weeks
drop policy weeks_insert on ops.weeks;
create policy weeks_insert on ops.weeks for insert to authenticated
with check (core.is_oversight() and not core.is_read_only());

drop policy weeks_update on ops.weeks;
create policy weeks_update on ops.weeks for update to authenticated
using (core.is_oversight() and not core.is_read_only())
with check (core.is_oversight() and not core.is_read_only());

-- ops.task_types
drop policy task_types_insert on ops.task_types;
create policy task_types_insert on ops.task_types for insert to authenticated
with check (core.is_oversight() and not core.is_read_only());

drop policy task_types_update on ops.task_types;
create policy task_types_update on ops.task_types for update to authenticated
using (core.is_oversight() and not core.is_read_only())
with check (core.is_oversight() and not core.is_read_only());

-- ops.recurring_templates
drop policy recurring_templates_insert on ops.recurring_templates;
create policy recurring_templates_insert on ops.recurring_templates for insert to authenticated
with check (core.is_oversight() and not core.is_read_only());

drop policy recurring_templates_update on ops.recurring_templates;
create policy recurring_templates_update on ops.recurring_templates for update to authenticated
using (core.is_oversight() and not core.is_read_only())
with check (core.is_oversight() and not core.is_read_only());

-- ops.tasks
drop policy tasks_insert on ops.tasks;
create policy tasks_insert on ops.tasks for insert to authenticated
with check (
  ((owner_user_id = core.auth_user_id() and core.caller_is_active()) or core.is_oversight())
  and not core.is_read_only()
);

drop policy tasks_update on ops.tasks;
create policy tasks_update on ops.tasks for update to authenticated
using (
  ((owner_user_id = core.auth_user_id() and core.caller_is_active()) or core.is_oversight())
  and not core.is_read_only()
)
with check (
  ((owner_user_id = core.auth_user_id() and core.caller_is_active()) or core.is_oversight())
  and not core.is_read_only()
);

drop policy tasks_delete on ops.tasks;
create policy tasks_delete on ops.tasks for delete to authenticated
using (
  owner_user_id = core.auth_user_id() and core.caller_is_active()
  and status in ('todo', 'cancelled')
  and not core.is_read_only()
);

-- ops.task_blocks
drop policy task_blocks_insert on ops.task_blocks;
create policy task_blocks_insert on ops.task_blocks for insert to authenticated
with check (core.is_member('ops') and created_by = core.auth_user_id() and not core.is_read_only());

drop policy task_blocks_update on ops.task_blocks;
create policy task_blocks_update on ops.task_blocks for update to authenticated
using (
  (
    (created_by = core.auth_user_id() and core.caller_is_active())
    or (blocking_user_id = core.auth_user_id() and core.caller_is_active())
    or core.is_oversight()
  )
  and not core.is_read_only()
)
with check (
  (
    (created_by = core.auth_user_id() and core.caller_is_active())
    or (blocking_user_id = core.auth_user_id() and core.caller_is_active())
    or core.is_oversight()
  )
  and not core.is_read_only()
);

-- ops.task_notes
drop policy task_notes_insert on ops.task_notes;
create policy task_notes_insert on ops.task_notes for insert to authenticated
with check (core.is_member('ops') and not core.is_read_only());

-- ---------------------------------------------------------------------
-- 4. ops.tasks INSERT/UPDATE trigger sweep.
-- ---------------------------------------------------------------------

create or replace function ops.enforce_initial_task_status()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_catalog_points int;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not create a task' using errcode = '42501';
  end if;

  if core.is_system_caller() or core.is_admin() then
    return new;
  end if;

  if new.status not in ('todo', 'in_progress') then
    raise exception 'a new task must start at todo or in_progress, not %', new.status
      using errcode = '42501';
  end if;

  if new.gm_id is not null or new.gm_acted_at is not null
     or new.founder_id is not null or new.founder_acted_at is not null
     or new.cleared_at is not null or new.points_awarded is not null
     or new.points_override is not null or new.points_override_reason is not null then
    raise exception 'a new task cannot be pre-stamped, pre-cleared or pre-overridden'
      using errcode = '42501';
  end if;

  if new.created_by is distinct from core.auth_user_id() then
    raise exception 'created_by must be the creating user'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- The main state machine, reproduced from its current live body:
-- 20260909150300's literal text, with the two later live-patched fixes
-- (the 'ops'::core.module cast, and `for share` on the week-state read)
-- folded back in, plus the read-only guard as the very first statement.
create or replace function ops.enforce_task_transition()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_owner_is_gm boolean;
  v_ledger_state ops.ledger_state;
  v_ledger_points int;
  v_ledger_reason text;
  v_recipient record;
  v_week_state ops.week_state;
  v_actor_email text;
  v_actor_authority core.authority;
begin
  -- 0. Read-only refusal, ahead of every other bypass -- a read-only
  -- founder's own authority (founder) would otherwise satisfy most of
  -- the checks below.
  if core.is_read_only() then
    raise exception 'a read-only account may not change a task' using errcode = '42501';
  end if;

  -- 1. Unconditional bypass.
  if core.is_system_caller() or core.is_admin() then
    return new;
  end if;

  -- 2. Stamp-forgery guard, on every update whether or not status changed.
  if (new.gm_id is distinct from old.gm_id or new.gm_acted_at is distinct from old.gm_acted_at)
     and not core.is_gm() then
    raise exception 'only a GM may set gm_id/gm_acted_at' using errcode = '42501';
  end if;

  if (new.founder_id is distinct from old.founder_id
      or new.founder_acted_at is distinct from old.founder_acted_at
      or new.cleared_at is distinct from old.cleared_at
      or new.points_awarded is distinct from old.points_awarded)
     and not core.is_founder() then
    raise exception 'only a founder may set founder_id/founder_acted_at/cleared_at/points_awarded'
      using errcode = '42501';
  end if;

  if new.catalog_points is distinct from old.catalog_points then
    raise exception 'catalog_points is a server-derived snapshot and cannot be changed'
      using errcode = '42501';
  end if;

  if (new.points_override is distinct from old.points_override
      or new.points_override_reason is distinct from old.points_override_reason)
     and not core.is_oversight() then
    raise exception 'only GM/founder may set a points override' using errcode = '42501';
  end if;

  if new.points_override is not null
     and (new.points_override_reason is null or length(trim(new.points_override_reason)) < 10) then
    raise exception 'a points override requires a written reason of at least 10 characters'
      using errcode = '42501';
  end if;

  -- Cancellation stamps are derived, never client-set.
  if (new.cancellation_requested_by is distinct from old.cancellation_requested_by
      or new.cancellation_requested_at is distinct from old.cancellation_requested_at
      or new.pre_cancellation_status is distinct from old.pre_cancellation_status
      or new.cancellation_decided_by is distinct from old.cancellation_decided_by
      or new.cancellation_decided_at is distinct from old.cancellation_decided_at) then
    raise exception 'cancellation stamps are derived and cannot be set directly' using errcode = '42501';
  end if;

  -- 2a. Commitment lock (Phase 6).
  if (new.is_committed is distinct from old.is_committed
      or new.committed_week_id is distinct from old.committed_week_id
      or new.committed_points is distinct from old.committed_points) then

    if new.owner_user_id <> core.auth_user_id() and not core.is_oversight() then
      raise exception 'only the task owner or oversight may change this task''s commitment'
        using errcode = '42501';
    end if;

    -- `for share`: without a row lock this is a read-committed TOCTOU
    -- window (20260909190000).
    select w.state into v_week_state from ops.weeks w where w.id = new.week_id for share;
    if v_week_state is not null and v_week_state <> 'planning' then
      raise exception 'commitments are locked for this week' using errcode = '42501';
    end if;
  end if;

  -- 3. Status unchanged -> allow (subject to the guards above), refresh activity.
  if new.status = old.status then
    new.last_activity_at := now();
    return new;
  end if;

  -- 4. Terminal states.
  if old.status in ('cleared', 'cancelled') then
    raise exception 'a % task is terminal and cannot be changed', old.status using errcode = '42501';
  end if;

  if new.status = 'submitted' and new.task_type_id is null then
    raise exception 'a task must have a catalog type before it can be submitted'
      using errcode = '42501';
  end if;

  select (m.position = 'gm') into v_owner_is_gm
  from core.memberships m
  where m.user_id = new.owner_user_id and m.module = 'ops' and m.is_active
  limit 1;

  -- 5. Legal transitions.
  case old.status
    when 'todo' then
      if new.status = 'pending_cancellation' then
        if not core.is_oversight() then
          raise exception 'only GM or founder may flag a task for cancellation' using errcode = '42501';
        end if;
        if new.cancellation_reason is null or length(trim(new.cancellation_reason)) < 10 then
          raise exception 'a cancellation flag requires a written reason of at least 10 characters'
            using errcode = '42501';
        end if;
        new.pre_cancellation_status := old.status;
        new.cancellation_requested_by := core.auth_user_id();
        new.cancellation_requested_at := now();
      elsif new.status not in ('in_progress', 'submitted', 'cancelled') then
        raise exception 'illegal transition todo -> %', new.status using errcode = '42501';
      elsif new.owner_user_id <> core.auth_user_id() and not core.is_oversight() then
        raise exception 'only the owner or oversight may move this task' using errcode = '42501';
      end if;

    when 'in_progress' then
      if new.status = 'pending_cancellation' then
        if not core.is_oversight() then
          raise exception 'only GM or founder may flag a task for cancellation' using errcode = '42501';
        end if;
        if new.cancellation_reason is null or length(trim(new.cancellation_reason)) < 10 then
          raise exception 'a cancellation flag requires a written reason of at least 10 characters'
            using errcode = '42501';
        end if;
        new.pre_cancellation_status := old.status;
        new.cancellation_requested_by := core.auth_user_id();
        new.cancellation_requested_at := now();
      elsif new.status not in ('todo', 'submitted', 'cancelled') then
        raise exception 'illegal transition in_progress -> %', new.status using errcode = '42501';
      elsif new.owner_user_id <> core.auth_user_id() and not core.is_oversight() then
        raise exception 'only the owner or oversight may move this task' using errcode = '42501';
      end if;

    when 'submitted' then
      if new.status = 'verified' then
        if v_owner_is_gm then
          if not core.is_founder() then
            raise exception 'a GM cannot verify their own task; a founder must'
              using errcode = '42501';
          end if;
        else
          if not core.is_gm() then
            raise exception 'only a GM may verify a submitted task' using errcode = '42501';
          end if;
        end if;
        if new.owner_user_id = core.auth_user_id() then
          raise exception 'a task owner may not verify their own task' using errcode = '42501';
        end if;

      elsif new.status = 'rejected' then
        if not core.is_oversight() then
          raise exception 'only GM/founder may reject a task' using errcode = '42501';
        end if;
        if new.rejected_reason is null or length(trim(new.rejected_reason)) < 10 then
          raise exception 'a rejection requires a written reason of at least 10 characters'
            using errcode = '42501';
        end if;

      elsif new.status = 'in_progress' then
        if new.owner_user_id <> core.auth_user_id() and not core.is_gm() then
          raise exception 'only the owner (retracting) or a GM may return this task to in_progress'
            using errcode = '42501';
        end if;

      elsif new.status = 'pending_cancellation' then
        if not core.is_oversight() then
          raise exception 'only GM or founder may flag a task for cancellation' using errcode = '42501';
        end if;
        if new.cancellation_reason is null or length(trim(new.cancellation_reason)) < 10 then
          raise exception 'a cancellation flag requires a written reason of at least 10 characters'
            using errcode = '42501';
        end if;
        new.pre_cancellation_status := old.status;
        new.cancellation_requested_by := core.auth_user_id();
        new.cancellation_requested_at := now();

      else
        raise exception 'illegal transition submitted -> %', new.status using errcode = '42501';
      end if;

    when 'verified' then
      if new.status = 'cleared' then
        if not core.is_clearing_founder() then
          raise exception 'only the clearing founder may clear a task' using errcode = '42501';
        end if;
        new.cleared_at := now();
        new.founder_id := core.auth_user_id();
        new.founder_acted_at := now();
        new.points_awarded := coalesce(new.points_override, new.catalog_points);

      elsif new.status = 'rejected' then
        if not core.is_founder() then
          raise exception 'only a founder may reject a verified task' using errcode = '42501';
        end if;
        if new.rejected_reason is null or length(trim(new.rejected_reason)) < 10 then
          raise exception 'a rejection requires a written reason of at least 10 characters'
            using errcode = '42501';
        end if;

      elsif new.status = 'submitted' then
        if not core.is_founder() then
          raise exception 'only a founder may send a verified task back to the GM'
            using errcode = '42501';
        end if;
        if new.rejected_reason is null or length(trim(new.rejected_reason)) < 10 then
          raise exception 'sending a task back requires a written reason of at least 10 characters'
            using errcode = '42501';
        end if;

      elsif new.status = 'pending_cancellation' then
        if not core.is_oversight() then
          raise exception 'only GM or founder may flag a task for cancellation' using errcode = '42501';
        end if;
        if new.cancellation_reason is null or length(trim(new.cancellation_reason)) < 10 then
          raise exception 'a cancellation flag requires a written reason of at least 10 characters'
            using errcode = '42501';
        end if;
        new.pre_cancellation_status := old.status;
        new.cancellation_requested_by := core.auth_user_id();
        new.cancellation_requested_at := now();

      else
        raise exception 'illegal transition verified -> %', new.status using errcode = '42501';
      end if;

    when 'pending_cancellation' then
      if not core.is_clearing_founder() then
        raise exception 'only the clearing founder may decide a flagged cancellation'
          using errcode = '42501';
      end if;

      if new.status = 'cancelled' then
        new.cancellation_decided_by := core.auth_user_id();
        new.cancellation_decided_at := now();

      elsif new.status = old.pre_cancellation_status then
        if new.cancellation_decision_reason is null or length(trim(new.cancellation_decision_reason)) < 10 then
          raise exception 'a cancellation refusal requires a written reason of at least 10 characters'
            using errcode = '42501';
        end if;
        new.cancellation_decided_by := core.auth_user_id();
        new.cancellation_decided_at := now();

      else
        raise exception 'a flagged cancellation may only be approved (-> cancelled) or refused (-> %)',
          old.pre_cancellation_status using errcode = '42501';
      end if;

    when 'rejected' then
      if new.status <> 'todo' then
        raise exception 'illegal transition rejected -> %', new.status using errcode = '42501';
      end if;
      if new.owner_user_id <> core.auth_user_id() and not core.is_oversight() then
        raise exception 'only the owner may rework a rejected task' using errcode = '42501';
      end if;

    when 'cancelled' then
      if new.status <> 'todo' then
        raise exception 'illegal transition cancelled -> %', new.status using errcode = '42501';
      end if;
      if not core.is_oversight() then
        raise exception 'only oversight may revive a cancelled task' using errcode = '42501';
      end if;

    else
      raise exception 'unreachable status %', old.status using errcode = '42501';
  end case;

  new.last_activity_at := now();

  -- 8. Ledger + outbox.
  if new.status in ('submitted', 'verified', 'cleared', 'rejected', 'cancelled') then
    v_ledger_state := new.status::text::ops.ledger_state;
    v_ledger_points := case when new.status = 'cleared' then coalesce(new.points_awarded, 0) else 0 end;
    v_ledger_reason := case
      when new.status = 'rejected' then new.rejected_reason
      when new.status = 'cancelled' and old.status = 'pending_cancellation' then new.cancellation_reason
      when new.points_override is not null then new.points_override_reason
      else null
    end;

    insert into ops.point_ledger
      (task_id, user_id, week_id, from_status, to_status, state, points,
       is_recurring, is_committed, actor_id, reason)
    values
      (new.id, new.owner_user_id, new.week_id, old.status, new.status, v_ledger_state, v_ledger_points,
       new.is_recurring, new.is_committed, core.auth_user_id(), v_ledger_reason);

    if new.status = 'submitted' then
      for v_recipient in
        select u.id from core.users u
        join core.memberships m on m.user_id = u.id and m.module = 'ops' and m.is_active
        where u.is_active and u.authority = 'gm'
      loop
        insert into core.notification_outbox
          (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
        values
          (v_recipient.id, 'ops', 'ops.task.submitted', 'ops.task', new.id,
           'Task submitted for verification', new.title, '/queue');
      end loop;

    elsif new.status = 'verified' then
      for v_recipient in
        select u.id from core.users u
        join core.memberships m on m.user_id = u.id and m.module = 'ops' and m.is_active
        where u.is_active and u.authority = 'founder'
      loop
        insert into core.notification_outbox
          (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
        values
          (v_recipient.id, 'ops', 'ops.task.verified', 'ops.task', new.id,
           'Task verified, waiting on your approval', new.title, '/queue');
      end loop;

    elsif new.status = 'cleared' then
      insert into core.notification_outbox
        (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
      values
        (new.owner_user_id, 'ops', 'ops.task.cleared', 'ops.task', new.id,
         'Task cleared', format('%s points cleared for "%s"', coalesce(new.points_awarded, 0), new.title), '/points');

    elsif new.status = 'rejected' then
      insert into core.notification_outbox
        (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
      values
        (new.owner_user_id, 'ops', 'ops.task.rejected', 'ops.task', new.id,
         'Task returned', coalesce(new.rejected_reason, ''), '/board');

    elsif new.status = 'cancelled' and old.status = 'pending_cancellation' then
      insert into core.notification_outbox
        (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
      values
        (new.owner_user_id, 'ops', 'ops.task.cancellation_approved', 'ops.task', new.id,
         'Task cancelled', format('The clearing founder cancelled "%s"', new.title), '/board');
    end if;
  end if;

  if new.status = 'pending_cancellation' then
    for v_recipient in
      select u.id from core.users u
      join core.memberships m on m.user_id = u.id and m.module = 'ops' and m.is_active
      where u.is_active and u.authority = 'founder'
    loop
      insert into core.notification_outbox
        (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
      values
        (v_recipient.id, 'ops', 'ops.task.cancellation_flagged', 'ops.task', new.id,
         'Cancellation waiting on your decision', new.title, '/queue');
    end loop;
  end if;

  if old.status = 'pending_cancellation' and new.status = old.pre_cancellation_status then
    insert into core.notification_outbox
      (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
    select distinct r, 'ops'::core.module, 'ops.task.cancellation_refused', 'ops.task', new.id,
           'Cancellation refused', coalesce(new.cancellation_decision_reason, ''), '/board'
    from unnest(array_remove(array[new.owner_user_id, old.cancellation_requested_by], null)) as r;
  end if;

  if new.status = 'pending_cancellation'
     or (old.status = 'pending_cancellation' and new.status in ('cancelled', old.pre_cancellation_status)) then
    select u.email, u.authority into v_actor_email, v_actor_authority
    from core.users u where u.id = core.auth_user_id();

    insert into core.audit_logs
      (actor_id, actor_email, actor_authority, module, action, entity_type, entity_id, old_values, new_values)
    values
      (core.auth_user_id(), v_actor_email, v_actor_authority, 'ops',
       case
         when new.status = 'pending_cancellation' then 'ops.task.cancellation_flagged'
         when new.status = 'cancelled' then 'ops.task.cancellation_approved'
         else 'ops.task.cancellation_refused'
       end,
       'ops.task', new.id,
       jsonb_build_object('status', old.status),
       jsonb_build_object(
         'status', new.status,
         'reason', coalesce(new.cancellation_reason, new.cancellation_decision_reason)
       ));
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. ops.task_notes insert trigger.
-- ---------------------------------------------------------------------

create or replace function ops.enforce_task_note_insert()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_task ops.tasks%rowtype;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not add a task note' using errcode = '42501';
  end if;

  if core.is_system_caller() or core.is_admin() then
    return new;
  end if;

  if new.author_user_id is distinct from core.auth_user_id() then
    raise exception 'a note must be authored by the caller' using errcode = '42501';
  end if;

  select * into v_task from ops.tasks where id = new.task_id;
  if v_task.id is null then
    raise exception 'unknown task' using errcode = 'P0002';
  end if;

  if v_task.status in ('cleared', 'cancelled') then
    raise exception 'this task is closed (%) and cannot take new notes', v_task.status
      using errcode = '42501';
  end if;

  if v_task.owner_user_id <> core.auth_user_id() and not core.is_oversight() then
    raise exception 'only the task owner or oversight may add a note to this task'
      using errcode = '42501';
  end if;

  update ops.tasks set last_activity_at = now() where id = new.task_id;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. The RPC surface -- weeks, briefing, catalog hard-delete, purge.
--    Every one of these is `security definer`, bypasses RLS entirely,
--    and already re-checks authorization itself; each gets the same
--    read-only refusal at the top.
-- ---------------------------------------------------------------------

create or replace function ops.generate_recurring_tasks(p_week_id uuid)
returns table(created_count integer)
language plpgsql
security definer
set search_path to 'ops', 'core', 'public'
as $function$
declare
  v_before bigint;
  v_after bigint;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not generate recurring tasks' using errcode = '42501';
  end if;

  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may generate recurring tasks' using errcode = '42501';
  end if;

  if not exists (select 1 from ops.weeks where id = p_week_id) then
    raise exception 'unknown week %', p_week_id using errcode = 'P0002';
  end if;

  select count(*) into v_before from ops.tasks where week_id = p_week_id and is_recurring;

  insert into ops.tasks
    (week_id, owner_user_id, task_type_id, title, description, status,
     is_recurring, recurring_template_id, created_by)
  select
    p_week_id,
    m.user_id,
    rt.task_type_id,
    rt.title,
    rt.description,
    'todo',
    true,
    rt.id,
    coalesce(core.auth_user_id(), m.user_id)
  from ops.recurring_templates rt
  join ops.task_types tt on tt.id = rt.task_type_id
  join core.memberships m
    on m.position = rt.position and m.module = 'ops' and m.is_active
  -- A read-only account is excluded from recurring generation entirely.
  -- ERC and DCA hold `position = 'founder'` so that they read what a
  -- founder reads, and this join would otherwise hand them a copy of
  -- every founder-positioned recurring task -- work they are forbidden
  -- from ever moving, submitting or clearing. Observed on 2026-09-09:
  -- seeding gave ERC "Clear the approval queue". Assigning someone work
  -- the database will refuse them is the precise failure this whole
  -- feature exists to prevent, and it would also pollute their
  -- reliability score with commitments they cannot act on.
  join core.users u on u.id = m.user_id and u.is_active and not u.read_only
  where rt.is_active and tt.is_active
  on conflict (owner_user_id, week_id, recurring_template_id) where recurring_template_id is not null
  do nothing;

  select count(*) into v_after from ops.tasks where week_id = p_week_id and is_recurring;

  return query select (v_after - v_before)::int;
end;
$function$;

create or replace function ops.roll_over_week(p_from_week_id uuid)
returns table (carried_count int, next_week_id uuid)
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_week ops.weeks%rowtype;
  v_next_week_start date;
  v_next_week_id uuid;
  v_carried int;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not roll over a week' using errcode = '42501';
  end if;

  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may roll over a week' using errcode = '42501';
  end if;

  select * into v_week from ops.weeks where id = p_from_week_id;
  if v_week.id is null then
    raise exception 'unknown week %', p_from_week_id using errcode = 'P0002';
  end if;

  if v_week.rolled_over_at is not null then
    select w.id into v_next_week_id from ops.weeks w where w.week_start = v_week.week_start + 7;
    return query select 0, v_next_week_id;
    return;
  end if;

  v_next_week_start := v_week.week_start + 7;

  insert into ops.weeks (week_start)
  values (v_next_week_start)
  on conflict (week_start) do nothing;

  select id into v_next_week_id from ops.weeks where week_start = v_next_week_start;

  with moved as (
    update ops.tasks
    set week_id = v_next_week_id,
        carry_over_count = carry_over_count + 1,
        last_activity_at = now()
    where week_id = p_from_week_id
      and status in ('todo', 'in_progress', 'submitted', 'verified', 'rejected')
    returning 1
  )
  select count(*) into v_carried from moved;

  update ops.weeks set rolled_over_at = now() where id = p_from_week_id;

  return query select v_carried, v_next_week_id;
end;
$$;

create or replace function ops.close_week(p_week_id uuid)
returns table (state ops.week_state, carried_count int, next_week_id uuid)
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_week ops.weeks%rowtype;
  v_rollover record;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not close a week' using errcode = '42501';
  end if;

  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may close a week' using errcode = '42501';
  end if;

  select * into v_week from ops.weeks where id = p_week_id;
  if v_week.id is null then
    raise exception 'unknown week %', p_week_id using errcode = 'P0002';
  end if;

  if v_week.state = 'closed' then
    select * into v_rollover from ops.roll_over_week(p_week_id);
    return query select v_week.state, v_rollover.carried_count, v_rollover.next_week_id;
    return;
  end if;

  update ops.weeks
  set state = 'closed', closed_at = now(), closed_by = core.auth_user_id()
  where id = p_week_id;

  select * into v_rollover from ops.roll_over_week(p_week_id);

  return query select 'closed'::ops.week_state, v_rollover.carried_count, v_rollover.next_week_id;
end;
$$;

create or replace function ops.open_briefing(p_week_id uuid)
returns ops.weeks
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_week ops.weeks%rowtype;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not open the briefing' using errcode = '42501';
  end if;

  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may open the briefing' using errcode = '42501';
  end if;

  select * into v_week from ops.weeks where id = p_week_id;
  if v_week.id is null then
    raise exception 'unknown week %', p_week_id using errcode = 'P0002';
  end if;

  if v_week.briefing_opened_at is not null then
    return v_week;
  end if;

  update ops.weeks set briefing_opened_at = now()
  where id = p_week_id
  returning * into v_week;

  return v_week;
end;
$$;

create or replace function ops.close_briefing(p_week_id uuid)
returns ops.weeks
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_week ops.weeks%rowtype;
  v_actor uuid;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not close the briefing' using errcode = '42501';
  end if;

  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may close the briefing' using errcode = '42501';
  end if;

  select * into v_week from ops.weeks where id = p_week_id;
  if v_week.id is null then
    raise exception 'unknown week %', p_week_id using errcode = 'P0002';
  end if;

  if v_week.state <> 'planning' then
    return v_week;
  end if;

  v_actor := core.auth_user_id();

  update ops.weeks
  set state = 'open',
      briefing_opened_at = coalesce(briefing_opened_at, now()),
      briefing_closed_at = now(),
      briefing_closed_by = v_actor
  where id = p_week_id
  returning * into v_week;

  insert into core.audit_logs
    (actor_id, actor_email, actor_authority, module, action, entity_type, entity_id, new_values)
  select v_actor, u.email, u.authority, 'ops', 'ops.briefing.closed', 'ops.week', p_week_id,
         jsonb_build_object('week_start', v_week.week_start, 'week_id', v_week.id)
  from core.users u where u.id = v_actor;

  return v_week;
end;
$$;

create or replace function ops.delete_task_type_if_unused(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not delete a task type' using errcode = '42501';
  end if;

  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may delete a task type' using errcode = '42501';
  end if;

  if not exists (select 1 from ops.task_types where id = p_id) then
    raise exception 'no such task type' using errcode = 'P0002';
  end if;

  if exists (select 1 from ops.tasks where task_type_id = p_id) then
    raise exception
      'this task type has been used by at least one task and cannot be hard-deleted; deactivate it instead'
      using errcode = '23503';
  end if;

  if exists (select 1 from ops.recurring_templates where task_type_id = p_id) then
    raise exception
      'this task type is used by a recurring template and cannot be hard-deleted; retire the template first'
      using errcode = '23503';
  end if;

  delete from ops.task_types where id = p_id;
end;
$$;

create or replace function ops.delete_recurring_template_if_unused(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not delete a recurring template' using errcode = '42501';
  end if;

  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may delete a recurring template' using errcode = '42501';
  end if;

  if not exists (select 1 from ops.recurring_templates where id = p_id) then
    raise exception 'no such recurring template' using errcode = 'P0002';
  end if;

  if exists (select 1 from ops.tasks where recurring_template_id = p_id) then
    raise exception
      'this template has already generated at least one task and cannot be hard-deleted; deactivate it instead'
      using errcode = '23503';
  end if;

  delete from ops.recurring_templates where id = p_id;
end;
$$;

create or replace function core.purge_due_accounts()
returns int
language plpgsql
security definer
set search_path = core, public
as $$
declare
  v_purged int := 0;
  r record;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not run core.purge_due_accounts' using errcode = '42501';
  end if;

  if not (core.is_admin() or core.is_system_caller()) then
    raise exception 'core.purge_due_accounts may only be run by an admin or the system'
      using errcode = '42501';
  end if;

  for r in
    select u.id, u.person_id
    from core.users u
    where u.deleted_at is not null
      and u.purge_due_at is not null
      and u.purge_due_at <= now()
      and exists (select 1 from auth.users a where a.id = u.id)
  loop
    if r.person_id is not null then
      update core.people
      set first_name   = 'Deleted',
          last_name     = 'person',
          display_name  = 'Deleted person ' || person_code,
          email         = lower(person_code) || '+deleted@purged.lra.invalid',
          is_active     = false
      where id = r.person_id;
    end if;

    delete from auth.users where id = r.id;

    v_purged := v_purged + 1;
  end loop;

  return v_purged;
end;
$$;
