-- =====================================================================
-- LRA Ops :: the task state machine
--
-- A policy cannot express a state machine -- it only ever sees the NEW
-- row. INSERT and UPDATE guards ship in this one migration, together,
-- because HR shipped them a migration apart and the gap between the two
-- deploys was exploitable (PLAN.md §2.5).
--
-- Ledger writes and outbox enqueues are added to
-- `ops.enforce_task_transition()` by a later migration via
-- `create or replace` (ops_ledger.sql) -- `ops.point_ledger` does not
-- exist yet at this point in the migration sequence. This migration
-- therefore only derives `cleared_at` / `points_awarded` and enforces
-- the ladder; it does not yet write history rows.
--
-- Bypass is unconditional and immediate, matching every other guard
-- trigger already shipped (`core.guard_user_privilege_columns`,
-- `core.guard_notification_is_read_only`): admin/system callers return
-- NEW with none of the below applied, including the derived-field and
-- (later) ledger logic. Admin is deliberately outside every business
-- ladder (PRD.md §2) and is not the account real transitions run
-- through -- the four demo/real role accounts are.
-- =====================================================================

-- ---------------------------------------------------------------------
-- BEFORE INSERT — a task is born at todo/in_progress, un-stamped, and
-- with a server-derived catalog_points snapshot the client cannot set.
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

create trigger trg_ops_enforce_initial_task_status
  before insert on ops.tasks
  for each row execute function ops.enforce_initial_task_status();

-- catalog_points is always derived server-side, for every caller
-- (including system/admin) -- this is correctness, not a security
-- ladder, so it runs as a separate, always-on trigger rather than living
-- inside the bypass-able guard above.
create or replace function ops.stamp_catalog_points()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  if new.task_type_id is null then
    new.catalog_points := null;
  else
    select tt.default_points into new.catalog_points
    from ops.task_types tt
    where tt.id = new.task_type_id;
  end if;

  if new.first_week_id is null then
    new.first_week_id := new.week_id;
  end if;

  return new;
end;
$$;

create trigger trg_ops_stamp_catalog_points
  before insert on ops.tasks
  for each row execute function ops.stamp_catalog_points();

-- ---------------------------------------------------------------------
-- BEFORE UPDATE — the ladder.
-- ---------------------------------------------------------------------
create or replace function ops.enforce_task_transition()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_owner_is_gm boolean;
begin
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

  -- 3. Status unchanged -> allow (subject to the guards above), refresh activity.
  if new.status = old.status then
    new.last_activity_at := now();
    return new;
  end if;

  -- 4. Cleared is terminal.
  if old.status = 'cleared' then
    raise exception 'a cleared task is terminal and cannot be changed' using errcode = '42501';
  end if;

  -- A task cannot be submitted without a priced-or-not catalog type at
  -- all (PRD.md §3.2: a free-form task must be assigned a catalog type
  -- before it can be submitted for points).
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
      if new.status not in ('in_progress', 'submitted', 'cancelled') then
        raise exception 'illegal transition todo -> %', new.status using errcode = '42501';
      end if;
      if new.owner_user_id <> core.auth_user_id() and not core.is_oversight() then
        raise exception 'only the owner or oversight may move this task' using errcode = '42501';
      end if;

    when 'in_progress' then
      if new.status not in ('todo', 'submitted', 'cancelled') then
        raise exception 'illegal transition in_progress -> %', new.status using errcode = '42501';
      end if;
      if new.owner_user_id <> core.auth_user_id() and not core.is_oversight() then
        raise exception 'only the owner or oversight may move this task' using errcode = '42501';
      end if;

    when 'submitted' then
      if new.status = 'verified' then
        -- 6. GM self-verification: if the owner IS the GM, only a
        -- founder may verify. A two-person control where one person can
        -- be both people is not a control.
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

      else
        raise exception 'illegal transition submitted -> %', new.status using errcode = '42501';
      end if;

    when 'verified' then
      if new.status = 'cleared' then
        -- The clearing seat, not "any founder" -- see
        -- core_clearing_founder.sql. Exactly one person holds this flag.
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

      else
        raise exception 'illegal transition verified -> %', new.status using errcode = '42501';
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
  return new;
end;
$$;

create trigger trg_ops_enforce_task_transition
  before update on ops.tasks
  for each row execute function ops.enforce_task_transition();

-- ---------------------------------------------------------------------
-- Catalog history — every INSERT/UPDATE on ops.task_types is snapshotted
-- append-only. Records the DRAFT state and every subsequent price.
-- ---------------------------------------------------------------------
create or replace function ops.record_task_type_revision()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  insert into ops.task_type_revisions
    (task_type_id, name, category, guideline_note, default_points, changed_by)
  values
    (new.id, new.name, new.category, new.guideline_note, new.default_points, core.auth_user_id());
  return new;
end;
$$;

create trigger trg_ops_task_type_revision_insert
  after insert on ops.task_types
  for each row execute function ops.record_task_type_revision();

create trigger trg_ops_task_type_revision_update
  after update on ops.task_types
  for each row execute function ops.record_task_type_revision();

-- ---------------------------------------------------------------------
-- Cycle guard — a task -> task block edge that would close a cycle is
-- refused. Only task-target edges can cycle; person/external targets
-- cannot participate in a graph cycle by construction.
-- ---------------------------------------------------------------------
create or replace function ops.reject_block_cycle()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_found boolean;
begin
  if new.target <> 'task' then
    return new;
  end if;

  if new.blocking_task_id = new.task_id then
    raise exception 'a task cannot block itself' using errcode = '42501';
  end if;

  -- Reachability check: can new.task_id be reached by walking existing
  -- OPEN task->task block edges starting from new.blocking_task_id? If
  -- so, adding task_id -> blocking_task_id would close a cycle.
  with recursive reach(task_id) as (
    select tb.blocking_task_id
    from ops.task_blocks tb
    where tb.task_id = new.blocking_task_id
      and tb.target = 'task'
      and tb.resolved_at is null
    union
    select tb.blocking_task_id
    from ops.task_blocks tb
    join reach r on tb.task_id = r.task_id
    where tb.target = 'task' and tb.resolved_at is null
  )
  select exists (select 1 from reach where task_id = new.task_id) into v_found;

  if v_found then
    raise exception 'this block would close a cycle between two or more tasks'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger trg_ops_reject_block_cycle
  before insert on ops.task_blocks
  for each row execute function ops.reject_block_cycle();
