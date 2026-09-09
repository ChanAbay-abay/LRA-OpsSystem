-- =====================================================================
-- LRA Ops :: the definition lock, and GM edit requests
--
-- Chan: "Once the meeting is concluded, those todos should be set and
-- not editable by the staff. Only admin and founder. GM can flag for
-- edits with the founder(LRA) or admin(me) approving the edits."
--
-- ops.close_briefing already locks `is_committed` / `committed_week_id`
-- / `committed_points` (20260909150100). Nothing locks the fields that
-- DEFINE the commitment -- title, description, task_type_id,
-- owner_user_id, client_ref -- so a staff member could rewrite what they
-- committed to on Monday any time before Sunday, which defeats the
-- entire point of the lock. That gap is closed below.
--
-- Part 1 -- extend `ops.enforce_task_transition` a fourth time (`create
-- or replace`, never an edit of an applied migration; the function is
-- reproduced in full from its current live body, 20260910120100's
-- copy -- the last one to touch it). New guard, "2b", sits next to the
-- existing commitment lock ("2a") and fires on the same principle: it
-- runs on ANY update to the five defining columns, whether or not
-- `status` also changes, so it cannot be dodged by piggybacking the edit
-- on a legal status transition. It fires ONLY when the task is already
-- committed (`is_committed`) and its week has left `planning` -- exactly
-- the record this system exists to make un-rewritable. A task created
-- mid-week (never committed) or a task still in a `planning` week stays
-- fully editable by its owner, because it is not yet "what was
-- committed to." Status transitions, notes and blocks are entirely
-- untouched: this guard inspects only the five naming/definition
-- columns.
--
-- The exemption is `core.is_founder()`, not `core.is_oversight()`.
-- `is_oversight()` admits gm/founder/admin -- exactly the set Chan does
-- NOT want here. `is_founder()` admits only founder/admin, which is
-- Chan's literal list. Admin also fully bypasses this whole function at
-- statement 1 as it always has; GM therefore falls through to the
-- refusal exactly like staff, which is the point -- a GM's only path to
-- change a locked task's definition is Part 2 below. A read-only
-- founder (ERC/DCA) never reaches this branch at all: statement 0 of
-- this function already refuses them before anything else runs.
--
-- Part 2 -- `ops.task_edit_requests`, modelled on the cancellation
-- ladder's shape (pending/approved/rejected, a required reason, the
-- CLEARING founder as sole decider, self-approval refused) but NOT
-- reusing its "unlock the row, let them edit it" pattern, because there
-- is no such pattern here -- the request carries the exact proposed
-- change as data, and approving it applies that exact change atomically
-- inside the same trigger that decides the request. An approver reviews
-- and approves a concrete diff, never an open window. `withdrawn` is a
-- fourth state cancellation doesn't have, because a requester (unlike a
-- GM flagging a cancellation, which the clearing founder must always
-- rule on) may legitimately think better of their own request before
-- anyone acts on it.
--
-- Requesters: GM, founder or admin (`core.is_oversight()`). Chan's brief
-- names the GM; founder/admin are additionally allowed because they can
-- equally just edit directly (Part 1's exemption), so allowing them here
-- too costs nothing and gives a founder a way to put a reason on record
-- for a change they want scrutinised by the OTHER founder rather than
-- silently landing it themselves -- but nothing REQUIRES them to use
-- this path; direct edit remains open to them.
--
-- Approver: `core.is_clearing_founder()`, per the brief -- admits admin,
-- and the one clearing seat, and excludes a non-clearing founder
-- (founder2 in the test fixtures) and the read-only ERC/DCA accounts
-- exactly as it already does for the cancellation ladder. Confirmed by
-- reading the function (20260909180000): `is_admin() or
-- coalesce(is_clearing_founder column, false)`.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Part 1 -- the definition lock.
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
  -- 0. Read-only refusal, ahead of every other bypass.
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

  -- 2b. Definition lock. Once a task is committed and its week has left
  -- planning, the fields that define WHAT was committed to are frozen
  -- for everyone except a founder or admin -- not GM (see header). This
  -- fires on any change to these five columns whether or not `status`
  -- also changes, exactly like 2a, so it cannot be dodged by combining
  -- the edit with a legal status move. A task that was never committed,
  -- or whose week is still `planning`, is untouched by this branch: it
  -- is not yet "what was committed to."
  if (new.title is distinct from old.title
      or new.description is distinct from old.description
      or new.task_type_id is distinct from old.task_type_id
      or new.owner_user_id is distinct from old.owner_user_id
      or new.client_ref is distinct from old.client_ref)
     and old.is_committed
     and not core.is_founder() then

    select w.state into v_week_state from ops.weeks w where w.id = new.week_id for share;
    if v_week_state is not null and v_week_state <> 'planning' then
      raise exception
        'a committed task''s definition (title/description/type/owner/client reference) is locked '
        'once the week has left planning; ask the GM to raise a task edit request'
        using errcode = '42501';
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
-- Part 2 -- ops.task_edit_requests.
-- ---------------------------------------------------------------------

create type ops.edit_request_status as enum ('pending', 'approved', 'rejected', 'withdrawn');

create table ops.task_edit_requests (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references ops.tasks(id),
  requested_by   uuid not null references core.users(id),
  requested_at   timestamptz not null default now(),
  reason         text not null,

  -- The proposed change, as data. A `change_*` flag distinguishes "not
  -- proposing to touch this field" from "proposing to set it to null"
  -- (clearing a description, for instance) -- a bare `proposed_x is not
  -- null` test could not tell those apart.
  change_title          boolean not null default false,
  proposed_title         text,
  change_description     boolean not null default false,
  proposed_description    text,
  change_task_type_id    boolean not null default false,
  proposed_task_type_id   uuid references ops.task_types(id),
  change_owner_user_id   boolean not null default false,
  proposed_owner_user_id  uuid references core.users(id),
  change_client_ref      boolean not null default false,
  proposed_client_ref     text,

  status              ops.edit_request_status not null default 'pending',
  decided_by          uuid references core.users(id),
  decided_at          timestamptz,
  decision_reason     text,

  -- Recoverability, per Chan's explicit ask: "a locked commitment that
  -- changes with no trace is the exact failure this system prevents."
  -- before_values is snapshotted at request time from the task's own
  -- current values (only the fields actually being proposed); after_values
  -- is filled in atomically at approval from the values actually applied.
  before_values jsonb,
  after_values  jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint task_edit_requests_reason_len check (length(trim(reason)) >= 10),
  constraint task_edit_requests_proposes_something check (
    change_title or change_description or change_task_type_id
    or change_owner_user_id or change_client_ref
  )
);

create index idx_ops_task_edit_requests_task on ops.task_edit_requests (task_id, requested_at desc);
create index idx_ops_task_edit_requests_pending on ops.task_edit_requests (status, requested_at) where status = 'pending';

create trigger trg_ops_task_edit_requests_updated_at
  before update on ops.task_edit_requests
  for each row execute function core.set_updated_at();

-- ---------------------------------------------------------------------
-- INSERT guard -- who may raise a request, and what it must contain.
-- ---------------------------------------------------------------------
create or replace function ops.enforce_task_edit_request_insert()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_task ops.tasks%rowtype;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not raise a task edit request' using errcode = '42501';
  end if;

  if core.is_system_caller() or core.is_admin() then
    -- Fixture/system inserts: still snapshot before_values below so the
    -- record stays honest even for a seeded row.
    null;
  else
    if new.requested_by is distinct from core.auth_user_id() then
      raise exception 'requested_by must be the caller' using errcode = '42501';
    end if;
    -- GM, founder or admin (admin already handled above). Staff is
    -- refused here; a plain oversight() check would also admit GM,
    -- which is exactly who this path exists for.
    if not core.is_oversight() then
      raise exception 'only GM, founder or admin may raise a task edit request' using errcode = '42501';
    end if;
  end if;

  if new.status <> 'pending' then
    raise exception 'a new edit request must start pending' using errcode = '42501';
  end if;

  if new.decided_by is not null or new.decided_at is not null or new.decision_reason is not null
     or new.after_values is not null then
    raise exception 'a new edit request cannot be pre-decided' using errcode = '42501';
  end if;

  select * into v_task from ops.tasks where id = new.task_id;
  if v_task.id is null then
    raise exception 'unknown task' using errcode = 'P0002';
  end if;
  if v_task.status in ('cleared', 'cancelled') then
    raise exception 'this task is closed (%) and cannot take an edit request', v_task.status
      using errcode = '42501';
  end if;

  -- Snapshot only the fields actually being proposed, from the task's
  -- real current values -- never from client input, which could lie
  -- about what the "before" was. Built by conditionally MERGING one-key
  -- objects, not by `jsonb_strip_nulls` on a single `jsonb_build_object`
  -- call: strip_nulls cannot tell "not proposing this field" apart from
  -- "proposing to set this field to null" (clearing a description is a
  -- legitimate, intentional null) -- it would have silently dropped the
  -- key for the second case too, which is exactly the "no trace" failure
  -- this table exists to prevent.
  new.before_values :=
    (case when new.change_title then jsonb_build_object('title', to_jsonb(v_task.title)) else '{}'::jsonb end)
    || (case when new.change_description then jsonb_build_object('description', to_jsonb(v_task.description)) else '{}'::jsonb end)
    || (case when new.change_task_type_id then jsonb_build_object('task_type_id', to_jsonb(v_task.task_type_id)) else '{}'::jsonb end)
    || (case when new.change_owner_user_id then jsonb_build_object('owner_user_id', to_jsonb(v_task.owner_user_id)) else '{}'::jsonb end)
    || (case when new.change_client_ref then jsonb_build_object('client_ref', to_jsonb(v_task.client_ref)) else '{}'::jsonb end);
  new.after_values := null;

  return new;
end;
$$;

create trigger trg_ops_enforce_task_edit_request_insert
  before insert on ops.task_edit_requests
  for each row execute function ops.enforce_task_edit_request_insert();

-- ---------------------------------------------------------------------
-- UPDATE guard -- withdraw / approve / reject, and applying an approval
-- atomically to ops.tasks. This IS the "approving applies that exact
-- change" step: it happens inside this same trigger invocation, so
-- there is no window where the request is marked approved but the task
-- has not yet moved.
-- ---------------------------------------------------------------------
create or replace function ops.enforce_task_edit_request_transition()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_task ops.tasks%rowtype;
  v_actor_email text;
  v_actor_authority core.authority;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not act on a task edit request' using errcode = '42501';
  end if;

  if old.status <> 'pending' then
    raise exception 'this edit request has already been decided (%) and cannot be changed', old.status
      using errcode = '42501';
  end if;

  -- The proposed change and its provenance are immutable once created --
  -- withdraw and resubmit rather than edit a request in place, exactly
  -- like a cancellation flag's reason cannot be rewritten after the
  -- fact.
  if (new.task_id is distinct from old.task_id
      or new.requested_by is distinct from old.requested_by
      or new.requested_at is distinct from old.requested_at
      or new.reason is distinct from old.reason
      or new.change_title is distinct from old.change_title
      or new.proposed_title is distinct from old.proposed_title
      or new.change_description is distinct from old.change_description
      or new.proposed_description is distinct from old.proposed_description
      or new.change_task_type_id is distinct from old.change_task_type_id
      or new.proposed_task_type_id is distinct from old.proposed_task_type_id
      or new.change_owner_user_id is distinct from old.change_owner_user_id
      or new.proposed_owner_user_id is distinct from old.proposed_owner_user_id
      or new.change_client_ref is distinct from old.change_client_ref
      or new.proposed_client_ref is distinct from old.proposed_client_ref
      or new.before_values is distinct from old.before_values) then
    raise exception 'the proposed change on an edit request is immutable once created; withdraw and resubmit instead'
      using errcode = '42501';
  end if;

  if new.status = 'withdrawn' then
    if not (core.is_system_caller() or core.is_admin() or old.requested_by = core.auth_user_id()) then
      raise exception 'only the requester may withdraw their own edit request' using errcode = '42501';
    end if;
    new.decided_by := core.auth_user_id();
    new.decided_at := now();

  elsif new.status in ('approved', 'rejected') then
    if not (core.is_system_caller() or core.is_clearing_founder()) then
      raise exception 'only the clearing founder may decide a task edit request' using errcode = '42501';
    end if;

    if not core.is_system_caller() and old.requested_by = core.auth_user_id() then
      raise exception 'the requester may not approve or reject their own edit request' using errcode = '42501';
    end if;

    if new.status = 'rejected'
       and (new.decision_reason is null or length(trim(new.decision_reason)) < 10) then
      raise exception 'rejecting an edit request requires a written reason of at least 10 characters'
        using errcode = '42501';
    end if;

    new.decided_by := core.auth_user_id();
    new.decided_at := now();

    if new.status = 'approved' then
      select * into v_task from ops.tasks where id = old.task_id for update;
      if v_task.id is null then
        raise exception 'the task this request was raised against no longer exists' using errcode = 'P0002';
      end if;
      if v_task.status in ('cleared', 'cancelled') then
        raise exception 'this task is closed (%) and its definition can no longer be changed', v_task.status
          using errcode = '42501';
      end if;

      update ops.tasks set
        title         = case when old.change_title then old.proposed_title else title end,
        description   = case when old.change_description then old.proposed_description else description end,
        task_type_id  = case when old.change_task_type_id then old.proposed_task_type_id else task_type_id end,
        owner_user_id = case when old.change_owner_user_id then old.proposed_owner_user_id else owner_user_id end,
        client_ref    = case when old.change_client_ref then old.proposed_client_ref else client_ref end
      where id = old.task_id;

      -- Same merge-not-strip construction as before_values above, and for
      -- the same reason: a proposed value of null is a real, intentional
      -- part of the applied change, not an absence to be stripped.
      new.after_values :=
        (case when old.change_title then jsonb_build_object('title', to_jsonb(old.proposed_title)) else '{}'::jsonb end)
        || (case when old.change_description then jsonb_build_object('description', to_jsonb(old.proposed_description)) else '{}'::jsonb end)
        || (case when old.change_task_type_id then jsonb_build_object('task_type_id', to_jsonb(old.proposed_task_type_id)) else '{}'::jsonb end)
        || (case when old.change_owner_user_id then jsonb_build_object('owner_user_id', to_jsonb(old.proposed_owner_user_id)) else '{}'::jsonb end)
        || (case when old.change_client_ref then jsonb_build_object('client_ref', to_jsonb(old.proposed_client_ref)) else '{}'::jsonb end);
    end if;

  else
    raise exception 'illegal edit-request transition pending -> %', new.status using errcode = '42501';
  end if;

  select u.email, u.authority into v_actor_email, v_actor_authority
  from core.users u where u.id = core.auth_user_id();

  insert into core.audit_logs
    (actor_id, actor_email, actor_authority, module, action, entity_type, entity_id, old_values, new_values)
  values
    (core.auth_user_id(), v_actor_email, v_actor_authority, 'ops',
     case new.status
       when 'approved'  then 'ops.task_edit_request.approved'
       when 'rejected'  then 'ops.task_edit_request.rejected'
       when 'withdrawn' then 'ops.task_edit_request.withdrawn'
     end,
     'ops.task_edit_request', new.id,
     jsonb_build_object('status', old.status, 'before_values', old.before_values, 'task_id', old.task_id),
     jsonb_build_object('status', new.status, 'reason', coalesce(new.decision_reason, old.reason),
                         'after_values', new.after_values));

  return new;
end;
$$;

create trigger trg_ops_enforce_task_edit_request_transition
  before update on ops.task_edit_requests
  for each row execute function ops.enforce_task_edit_request_transition();

-- No DELETE trigger needed: no DELETE policy is granted below, matching
-- ops.task_notes/core.audit_logs/ops.point_ledger's append-only shape.

-- ---------------------------------------------------------------------
-- RLS. Reads: any ops member, same visibility as ops.tasks itself
-- (PRD.md §6.1 -- everyone is in the loop). Writes: policy layer is thin
-- (`is_member('ops') and not is_read_only()`), the triggers above are
-- the real gate, same division of labour as ops.tasks and
-- ops.task_notes. `and not core.is_read_only()` on every write policy,
-- matching 20260910120100's sweep.
-- ---------------------------------------------------------------------
alter table ops.task_edit_requests enable row level security;

create policy task_edit_requests_select on ops.task_edit_requests for select to authenticated
using (core.is_member('ops'));

create policy task_edit_requests_insert on ops.task_edit_requests for insert to authenticated
with check (core.is_member('ops') and not core.is_read_only());

create policy task_edit_requests_update on ops.task_edit_requests for update to authenticated
using (core.is_member('ops') and not core.is_read_only())
with check (core.is_member('ops') and not core.is_read_only());

-- No INSERT/UPDATE/DELETE grant is needed beyond RLS: `ops.task_edit_requests`
-- is created under the same role that already ran
-- `alter default privileges in schema ops revoke truncate, trigger,
-- references ... / revoke delete ... from anon` (20260908120400 §10),
-- which applies to every table created afterwards in this schema --
-- confirmed by ops.task_notes (20260909150300) needing no repeat of that
-- block either.

comment on table ops.task_edit_requests is
  'A GM''s (or founder''s/admin''s) request to change a locked, committed '
  'task''s definition. Carries the exact proposed change; approving by '
  'the clearing founder applies it atomically inside the same trigger '
  'that records the decision. Modelled on the cancellation ladder '
  '(20260909150300) but does not reuse its "unlock the row" shape -- '
  'there is nothing to unlock, only a concrete diff to approve or '
  'refuse.';
