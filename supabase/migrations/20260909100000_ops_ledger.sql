-- =====================================================================
-- LRA Ops :: the points ledger — "money waiting to clear"
--
-- Append-only. One row per point-bearing transition. Balances are
-- computed from `ops.tasks`' current state, never stored or summed from
-- the ledger, because a task that bounces submitted -> rejected -> todo
-- -> submitted again writes multiple ledger rows and only the task's
-- *current* status is the true balance (PLAN.md §2.6, PRD.md §3.5).
-- =====================================================================

create type ops.ledger_state as enum ('submitted', 'verified', 'cleared', 'rejected', 'cancelled');

create table ops.point_ledger (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references ops.tasks(id),
  user_id      uuid not null references core.users(id),
  week_id      uuid not null references ops.weeks(id),
  from_status  ops.task_status not null,
  to_status    ops.task_status not null,
  state        ops.ledger_state not null,
  points       int not null default 0,
  is_recurring boolean not null default false,
  is_committed boolean not null default false,
  actor_id     uuid references core.users(id),
  reason       text,
  created_at   timestamptz not null default now()
);
create index idx_ops_point_ledger_task on ops.point_ledger (task_id, created_at);
create index idx_ops_point_ledger_user_week on ops.point_ledger (user_id, week_id);

create or replace function ops.forbid_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ops.point_ledger is append-only; % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

create trigger trg_forbid_ledger_update
  before update on ops.point_ledger
  for each row execute function ops.forbid_ledger_mutation();

create trigger trg_forbid_ledger_delete
  before delete on ops.point_ledger
  for each row execute function ops.forbid_ledger_mutation();

alter table ops.point_ledger enable row level security;

-- Any ops member reads the whole ledger -- tasks are visible to
-- everyone by design (PRD.md §6.1) and the ledger is the receipts for
-- that same visible work.
create policy point_ledger_select on ops.point_ledger for select to authenticated
using (core.is_member('ops'));

-- No INSERT/UPDATE/DELETE policy for `authenticated`: the only path in
-- is `ops.enforce_task_transition()`, a SECURITY DEFINER trigger owned
-- by the table owner, which bypasses RLS the same way every other
-- system-only write path in this schema does.

-- ---------------------------------------------------------------------
-- Balances — computed from ops.tasks' current status, per person per
-- week. Cleared / pending-with-GM / pending-with-founder / new-vs-
-- recurring, exactly what PRD §3.5's three home-screen figures need.
-- ---------------------------------------------------------------------
create or replace view ops.v_point_balances as
select
  t.owner_user_id as user_id,
  t.week_id,
  coalesce(sum(t.points_awarded) filter (where t.status = 'cleared'), 0) as cleared_points,
  coalesce(sum(coalesce(t.points_override, t.catalog_points, 0)) filter (where t.status = 'submitted'), 0) as pending_with_gm,
  coalesce(sum(coalesce(t.points_override, t.catalog_points, 0)) filter (where t.status = 'verified'), 0) as pending_with_founder,
  coalesce(sum(coalesce(t.points_override, t.catalog_points, 0)) filter (where t.is_committed and t.status in ('todo', 'in_progress')), 0) as committed_not_submitted,
  coalesce(sum(t.points_awarded) filter (where t.status = 'cleared' and not t.is_recurring), 0) as cleared_new_points,
  coalesce(sum(t.points_awarded) filter (where t.status = 'cleared' and t.is_recurring), 0) as cleared_recurring_points,
  min(t.created_at) filter (where t.status in ('submitted', 'verified')) as oldest_pending_since
from ops.tasks t
group by t.owner_user_id, t.week_id;

comment on view ops.v_point_balances is
  'The "bank balance waiting to clear" figures for one person in one '
  'week. Computed from current task status, never from a ledger sum -- '
  'a task that bounces through rejection writes several ledger rows but '
  'has exactly one current status.';

-- ---------------------------------------------------------------------
-- Extend the transition trigger (create or replace, a NEW migration --
-- never edit an applied one) to write the ledger row and enqueue the
-- notification for every point-bearing transition. Everything from the
-- Phase 3 migration is reproduced verbatim; only the block after the
-- `case old.status` statement changes.
-- ---------------------------------------------------------------------
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

  -- 8. Ledger + outbox — only for the five states PRD §3.5 tracks as
  -- ledger states. todo/in_progress movement writes no ledger row.
  if new.status in ('submitted', 'verified', 'cleared', 'rejected', 'cancelled') then
    v_ledger_state := new.status::text::ops.ledger_state;
    v_ledger_points := case when new.status = 'cleared' then coalesce(new.points_awarded, 0) else 0 end;
    v_ledger_reason := case
      when new.status in ('rejected') then new.rejected_reason
      when new.points_override is not null then new.points_override_reason
      else null
    end;

    insert into ops.point_ledger
      (task_id, user_id, week_id, from_status, to_status, state, points,
       is_recurring, is_committed, actor_id, reason)
    values
      (new.id, new.owner_user_id, new.week_id, old.status, new.status, v_ledger_state, v_ledger_points,
       new.is_recurring, new.is_committed, core.auth_user_id(), v_ledger_reason);

    -- Notify the party the task now sits with, or the owner on a
    -- terminal outcome. Loop rather than a single INSERT because
    -- "the GM"/"the founder" can be more than one active account.
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
    end if;
  end if;

  return new;
end;
$$;
