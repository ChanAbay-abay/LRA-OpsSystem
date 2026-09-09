-- =====================================================================
-- LRA Ops :: Phase 6 -- the Monday briefing
--
-- Three things ship together:
--
-- 1. The commitment lock, as a trigger, not a policy (PLAN.md §2.6): "a
--    policy cannot express a state machine, it only ever sees the NEW
--    row." Committing/uncommitting a task changes `is_committed` /
--    `committed_week_id` / `committed_points` while `status` typically
--    stays `todo` -- and `ops.enforce_task_transition`'s existing
--    "status unchanged -> allow" branch would let that sail through
--    with no check at all. This extends the same function
--    (`create or replace`, a NEW migration -- the applied one is never
--    edited) with a guard that runs before that early-return, mirroring
--    the stamp-forgery guards already there: only the owner or
--    oversight may touch the commitment columns, and once the task's
--    week has left `planning` nobody -- not even oversight -- may
--    change them from the user path. System/admin callers still bypass
--    unconditionally at the top, which is what lets `ops.roll_over_week`
--    carry a task to a new week without disturbing its old commitment
--    record (PRD.md §3.7: "the original week's commitment record stays
--    exactly as it was").
--
-- 2. `ops.open_briefing` / `ops.close_briefing` -- the only path that
--    moves a week `planning -> open`. Per PRD.md §3.1, the week enters
--    `open` exactly when the briefing closes, not when it is merely
--    opened for the meeting; `briefing_opened_at` is only a screen-state
--    timestamp. Closing is where the lock actually engages, and it is
--    audit-logged and irreversible from the UI (PRD.md §6.2) -- there is
--    no `reopen_briefing` function; per OPEN-QUESTIONS.md #7 that would
--    need the founder and is out of scope here.
--
-- Nothing here proposes a point value or requires one: unpriced types
-- keep rendering `default_points = null` end to end (Chan: "unpriced
-- types render — and the feature must work regardless").
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Commitment lock -- extend the transition trigger.
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
  v_week_state ops.week_state;
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

  -- 2a. Commitment lock (Phase 6). Fires on any change to the three
  -- commitment columns, whether or not `status` also changes -- a
  -- commit/uncommit action leaves `status` at `todo` in the ordinary
  -- case, so this cannot live inside the status-based branches below.
  if (new.is_committed is distinct from old.is_committed
      or new.committed_week_id is distinct from old.committed_week_id
      or new.committed_points is distinct from old.committed_points) then

    if new.owner_user_id <> core.auth_user_id() and not core.is_oversight() then
      raise exception 'only the task owner or oversight may change this task''s commitment'
        using errcode = '42501';
    end if;

    -- `for share`: without a row lock this is a read-committed TOCTOU window --
    -- a commit landing while close_briefing is mid-transaction would still see
    -- 'planning'. See 20260909190000.
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

-- ---------------------------------------------------------------------
-- 2. ops.open_briefing / ops.close_briefing.
-- ---------------------------------------------------------------------

-- Stamps `briefing_opened_at` for the shared display. Does NOT touch
-- week state -- PRD.md §3.1: the week is `planning` until the briefing
-- CLOSES, not while it is merely open on screen. Idempotent: a second
-- open is a no-op that returns the week unchanged.
create or replace function ops.open_briefing(p_week_id uuid)
returns ops.weeks
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_week ops.weeks%rowtype;
begin
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

-- The lock moment. Moves the week `planning -> open`, stamps
-- `briefing_closed_at`/`briefing_closed_by`, and writes one
-- `core.audit_logs` row -- promoting a founder is not the only
-- high-privilege act in this system; locking the whole company's
-- commitments for the week is another, and PRD.md §6.2 requires it be
-- irreversible from the UI and audit-logged. Idempotent: closing an
-- already-open (or closed) week is a no-op that returns the row as-is,
-- rather than raising, so a retried click after a dropped response does
-- not error.
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

comment on function ops.open_briefing(uuid) is
  'Stamps briefing_opened_at only. Does not lock anything -- the week '
  'still leaves planning only at ops.close_briefing.';
comment on function ops.close_briefing(uuid) is
  'The only path that moves a week planning -> open. Locks every '
  'commitment on the week via ops.enforce_task_transition''s guard. '
  'Irreversible from the UI (PRD.md §6.2) -- there is no reopen '
  'function here on purpose.';
