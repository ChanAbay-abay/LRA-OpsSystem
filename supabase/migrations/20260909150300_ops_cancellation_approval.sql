-- =====================================================================
-- LRA Ops :: cancellation as a two-rung approval, and a task worklog
--
-- Part 1 -- cancellation. Mirrors submit -> verify -> clear exactly:
--   any workable status -> pending_cancellation   (GM or founder flags, reason required)
--   pending_cancellation -> cancelled             (the CLEARING founder approves)
--   pending_cancellation -> <status it held before>  (the clearing founder refuses, reason required)
-- A cancelled task awards no points -- ever -- but still writes a
-- `cancelled` ops.point_ledger row (points = 0) so the balance view and
-- the history stay honest, exactly like every other terminal outcome.
-- The existing owner-direct-cancel path (`todo`/`in_progress` ->
-- `cancelled`, no reason, PLAN.md §2.5's original table) is left in
-- place for a person abandoning their own not-yet-worked task -- that
-- is a different, lower-stakes act than a GM/founder cancelling
-- something already in flight, and Chan's ask is additive ("if a task
-- needs to be closed OR cancelled the GM can flag it"), not a removal
-- of self-cancel.
--
-- Part 2 -- ops.task_notes, a running worklog distinct from
-- `ops.tasks.description` (left untouched). Append-only like
-- `core.audit_logs` and `ops.point_ledger`; owner/GM/founder write,
-- any ops member reads (tasks are visible to everyone by design,
-- PRD.md §6.1, and the worklog is exactly that same visibility);
-- closed once the task is `cleared` or `cancelled`; every insert
-- refreshes `ops.tasks.last_activity_at` so staleness detection sees a
-- narrated task as active.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Columns for the cancellation ladder.
-- ---------------------------------------------------------------------
alter table ops.tasks
  add column cancellation_reason          text,
  add column cancellation_requested_by    uuid references core.users(id),
  add column cancellation_requested_at    timestamptz,
  add column pre_cancellation_status      ops.task_status,
  add column cancellation_decision_reason text,
  add column cancellation_decided_by      uuid references core.users(id),
  add column cancellation_decided_at      timestamptz;

comment on column ops.tasks.cancellation_reason is
  'Why a GM/founder flagged this task for cancellation. Required, >=10 chars, checked by the trigger.';
comment on column ops.tasks.pre_cancellation_status is
  'The status held immediately before flagging -- where the task returns if the clearing founder refuses.';
comment on column ops.tasks.cancellation_decision_reason is
  'Required on a refusal; optional on an approval (the flag reason already explains the "why").';

-- ---------------------------------------------------------------------
-- Freeze cancelled the same as cleared -- extend the existing trigger
-- function rather than writing a second one (Chan's explicit ask).
-- ---------------------------------------------------------------------
create or replace function ops.freeze_cleared_task()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  if core.is_system_caller() then
    return new;
  end if;

  if old.status in ('cleared', 'cancelled') then
    raise exception
      'a cleared or cancelled task is frozen; the record is closed and the ledger is append-only'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- The transition trigger, extended a third time (create or replace,
-- never editing an applied migration): commitment lock (from
-- ops_briefing.sql) plus the cancellation ladder.
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
  v_actor_email text;
  v_actor_authority core.authority;
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

  -- Cancellation stamps are derived, never client-set -- the reasons
  -- (cancellation_reason / cancellation_decision_reason) are the one
  -- part of this ladder a caller writes directly, same as
  -- rejected_reason elsewhere in this function.
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

    select w.state into v_week_state from ops.weeks w where w.id = new.week_id;
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
      -- The CLEARING founder's seat -- the same one that clears points,
      -- deliberately, not "any founder" (core_clearing_founder.sql's
      -- "a control two people can both satisfy is not a control" logic
      -- applies here exactly as it does to verified -> cleared).
      if not core.is_clearing_founder() then
        raise exception 'only the clearing founder may decide a flagged cancellation'
          using errcode = '42501';
      end if;

      if new.status = 'cancelled' then
        -- Approve. No points, ever -- points_awarded stays null.
        new.cancellation_decided_by := core.auth_user_id();
        new.cancellation_decided_at := now();

      elsif new.status = old.pre_cancellation_status then
        -- Refuse: return to the status held before flagging. Requires
        -- its own reason, the same >=10-char bar as every other
        -- accountability moment in this ladder.
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

  -- 8. Ledger + outbox — only for the five states PRD §3.5 tracks as
  -- ledger states. `pending_cancellation` is a waypoint, not a ledger
  -- state, and writes no row (mirrors `todo`/`in_progress` movement).
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

  -- Flag raised: notify the founders there is a decision waiting, the
  -- same shape as the 'verified' branch above.
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

  -- Refusal: back to the pre-flag status. Tell the requester and the owner.
  if old.status = 'pending_cancellation' and new.status = old.pre_cancellation_status then
    insert into core.notification_outbox
      (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
    select distinct r, 'ops', 'ops.task.cancellation_refused', 'ops.task', new.id,
           'Cancellation refused', coalesce(new.cancellation_decision_reason, ''), '/board'
    from unnest(array_remove(array[new.owner_user_id, old.cancellation_requested_by], null)) as r;
  end if;

  -- Chain of custody for the two highest-stakes moments in this ladder
  -- (flag and decision) also lands in core.audit_logs, same as every
  -- other privileged act in this system (PLAN.md §7.3).
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
-- ops.task_notes -- the running worklog. Append-only.
-- ---------------------------------------------------------------------
create table ops.task_notes (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references ops.tasks(id) on delete cascade,
  author_user_id uuid not null references core.users(id),
  -- Reasonable cap: long enough for a real worklog entry, short enough
  -- that one note cannot become a second description field. Unicode
  -- (emoji, RTL) is unaffected by a character-length check.
  body           text not null check (length(trim(body)) > 0 and length(body) <= 4000),
  created_at     timestamptz not null default now()
);
create index idx_ops_task_notes_task on ops.task_notes (task_id, created_at);

create or replace function ops.forbid_task_note_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ops.task_notes is append-only; % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

create trigger trg_forbid_task_note_update
  before update on ops.task_notes
  for each row execute function ops.forbid_task_note_mutation();
create trigger trg_forbid_task_note_delete
  before delete on ops.task_notes
  for each row execute function ops.forbid_task_note_mutation();

-- Author must be the caller; the task must be open (not cleared/
-- cancelled); the caller must be the task's owner or oversight. All
-- three enforced in the trigger, not the policy, because "is this task
-- still open" needs a lookup a CHECK/policy on `ops.task_notes` alone
-- cannot express cleanly and a lookup that must stay correct as
-- `ops.tasks` evolves belongs in one place.
create or replace function ops.enforce_task_note_insert()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_task ops.tasks%rowtype;
begin
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
    raise exception 'this task is closed (% ) and cannot take new notes', v_task.status
      using errcode = '42501';
  end if;

  if v_task.owner_user_id <> core.auth_user_id() and not core.is_oversight() then
    raise exception 'only the task owner or oversight may add a note to this task'
      using errcode = '42501';
  end if;

  -- A note is activity: staleness keys off last_activity_at, and a task
  -- someone is actively narrating is not stale (Chan's explicit ask).
  update ops.tasks set last_activity_at = now() where id = new.task_id;

  return new;
end;
$$;

create trigger trg_ops_enforce_task_note_insert
  before insert on ops.task_notes
  for each row execute function ops.enforce_task_note_insert();

alter table ops.task_notes enable row level security;

-- Any ops member reads -- tasks are visible to everyone by design
-- (PRD.md §6.1) and the worklog is exactly that same visibility.
create policy task_notes_select on ops.task_notes for select to authenticated
using (core.is_member('ops'));

-- INSERT is allowed at the policy layer for any ops member; the trigger
-- above is the real gate (author/ownership/open-task checks), same
-- division of labour as `ops.tasks` itself in ops_catalog_rls.sql.
create policy task_notes_insert on ops.task_notes for insert to authenticated
with check (core.is_member('ops'));

-- No UPDATE/DELETE policy for `authenticated` at all -- append-only
-- even to a task's own owner or oversight, matching
-- core.audit_logs/ops.point_ledger exactly. The triggers above are a
-- second line of defence in case a future migration ever adds one.
