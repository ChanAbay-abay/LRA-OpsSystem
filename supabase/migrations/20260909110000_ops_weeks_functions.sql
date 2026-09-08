-- =====================================================================
-- LRA Ops :: weeks — recurring generation and carry-over rollover
--
-- All three functions are `security definer`, all guarded
-- (`is_system_caller() or is_oversight()`, else 42501) and all
-- idempotent -- calling any of them twice with the same argument is a
-- no-op the second time (PLAN.md Phase 5).
--
-- The commitment LOCK trigger and the briefing screen that populates
-- `is_committed` for real are Phase 6, deliberately not built here --
-- that phase is blocked on the founder pricing the catalog. These
-- functions only move and generate tasks; they do not touch commitments.
-- =====================================================================

-- ---------------------------------------------------------------------
-- ops.generate_recurring_tasks(week_id) — one task per (active recurring
-- template, active member holding that template's position). Idempotent
-- via `uq_ops_tasks_recurring` + ON CONFLICT DO NOTHING: re-running adds
-- nothing for a member/template pair that already has a task this week.
-- ---------------------------------------------------------------------
create or replace function ops.generate_recurring_tasks(p_week_id uuid)
returns table (created_count int)
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_before bigint;
  v_after bigint;
begin
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
    m.user_id
  from ops.recurring_templates rt
  join core.memberships m
    on m.position = rt.position and m.module = 'ops' and m.is_active
  join core.users u on u.id = m.user_id and u.is_active
  where rt.is_active
  on conflict (owner_user_id, week_id, recurring_template_id) where recurring_template_id is not null
  do nothing;

  select count(*) into v_after from ops.tasks where week_id = p_week_id and is_recurring;

  return query select (v_after - v_before)::int;
end;
$$;

-- ---------------------------------------------------------------------
-- ops.roll_over_week(from_week_id) — every unfinished task
-- (todo/in_progress/submitted/verified/rejected) moves to the next
-- week (created in `planning` if it doesn't exist), with
-- carry_over_count incremented and first_week_id already preserved by
-- `ops.stamp_catalog_points()` at original creation. Idempotent: guarded
-- by `weeks.rolled_over_at` on the source week, so a second call is an
-- immediate no-op rather than re-matching zero rows by luck.
-- ---------------------------------------------------------------------
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
  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may roll over a week' using errcode = '42501';
  end if;

  select * into v_week from ops.weeks where id = p_from_week_id;
  if v_week.id is null then
    raise exception 'unknown week %', p_from_week_id using errcode = 'P0002';
  end if;

  if v_week.rolled_over_at is not null then
    -- Already rolled over -- idempotent no-op. Return the existing
    -- destination so a caller retrying after a dropped response still
    -- gets a useful answer.
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

-- ---------------------------------------------------------------------
-- ops.close_week(week_id) — marks the week closed and rolls it over.
-- Idempotent: a week already `closed` is a no-op (rollover's own guard
-- also protects the carry-over half independently).
-- ---------------------------------------------------------------------
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
