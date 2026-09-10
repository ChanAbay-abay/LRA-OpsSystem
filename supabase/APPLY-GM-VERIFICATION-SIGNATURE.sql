-- =====================================================================
-- LRA Ops :: a verification gets a signature, the same way a clearing does
--
-- THE GAP. `ops.tasks` carries two symmetric pairs of signature columns:
-- `founder_id`/`founder_acted_at` and `gm_id`/`gm_acted_at`. Only one of
-- them was ever written. The `verified -> cleared` branch of
-- `ops.enforce_task_transition()` stamps
--
--     new.founder_id := core.auth_user_id();
--     new.founder_acted_at := now();
--
-- while the `submitted -> verified` branch stamps nothing at all. It
-- checks authority carefully -- a GM's own task must be verified by a
-- founder, and no owner may verify their own work -- and then throws
-- away the identity it just checked.
--
-- So the system records who CLEARED a task and not who VERIFIED it, and
-- verification is the gate: a task that is not verified can never be
-- cleared, and points are awarded on clearing. The one approval that
-- decides whether work counts at all was the one approval nobody signed.
--
-- LIVE EVIDENCE (production, 2026-09-10, read-only count):
--
--     verified_or_beyond = 32
--     with_founder_sig   = 28
--     with_gm_sig        =  0
--
-- Thirty-two tasks have passed verification. Twenty-eight carry a
-- founder's signature from clearing. Zero carry a GM's signature from
-- verification. That is not a data problem; it is the trigger doing
-- exactly what it was written to do.
--
-- THE FIX. Two lines, in the `submitted -> verified` branch, placed
-- AFTER both authority checks that already live there (the
-- `v_owner_is_gm` founder-vs-GM check, and "a task owner may not verify
-- their own task"). Nothing else in the function changes.
--
-- WHY THE STAMP-FORGERY GUARD DOES NOT FIRE. Statement 2 of the same
-- function refuses any update where `new.gm_id`/`new.gm_acted_at`
-- differ from `old` unless `core.is_gm()`. `core.is_gm()` is GM-or-
-- admin, so a FOUNDER verifying a GM-owned task -- a legal and required
-- path -- is not `is_gm()`, and a naive reading says this fix locks
-- that path out.
--
-- It does not, because of ORDERING. The guard sits at statement 2; the
-- status branches are statement 5. At guard time the client has sent no
-- signature columns, so `new.gm_id is not distinct from old.gm_id` and
-- `new.gm_acted_at is not distinct from old.gm_acted_at`: the guard's
-- condition is false and it never evaluates `core.is_gm()` at all. The
-- trigger then stamps the row afterwards, in a BEFORE trigger, on its
-- own authority -- the same mechanism by which the `verified ->
-- cleared` branch has always set `founder_id` without tripping the
-- founder half of the same guard two lines below it.
--
-- The guard is NOT widened, weakened, or touched. A client that tries
-- to send `gm_id` itself is refused exactly as before. The only new
-- writer of these columns is the trigger, on one specific transition,
-- after the authority for that transition has been proven.
--
-- FORWARD-ONLY. NOTHING IS BACKFILLED. The 32 historical rows stay
-- unsigned, and that is deliberate. We do not know who verified them --
-- the trigger never recorded it -- so any backfill would be an
-- invention: a name written into a signature field for an approval that
-- person may or may not have given. Fabricating a signature on a
-- historical approval is precisely the failure this system's whole
-- stamp/guard apparatus exists to prevent, and it would be worse than
-- the gap it papered over, because an unsigned row is honestly unknown
-- while a forged one reads as fact. A null `gm_id` on a task verified
-- before this migration means "not recorded"; from the moment this runs,
-- a null on a newly verified task cannot happen.
--
-- KNOWN LIMIT, stated rather than hidden: statement 1 returns early for
-- `core.is_system_caller()` or `core.is_admin()`, ahead of every branch.
-- A verification performed by an admin account or by a system/seed path
-- therefore still leaves `gm_id` null. That bypass predates this change
-- and narrowing it is a separate authority decision, not this one.
--
-- SCOPE. One `create or replace function` on
-- `ops.enforce_task_transition()`. No table is altered, no row is
-- written, no policy or grant changes, no other function is touched.
-- The body below is the definition currently deployed in production
-- (verified against `pg_proc.prosrc`, md5 3085fa1a0c59d6e23b87a16e2962571c)
-- with the two added lines and nothing else.
-- =====================================================================

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
  v_stamped boolean := false;
begin
  -- 0. Read-only refusal, ahead of every other bypass.
  if core.is_read_only() then
    raise exception 'a read-only account may not change a task' using errcode = '42501';
  end if;

  -- 0b. Cycle-time start stamp.
  if new.status = 'in_progress'
     and new.status is distinct from old.status
     and old.first_in_progress_at is null then
    new.first_in_progress_at := now();
    v_stamped := true;
  end if;

  -- 0c. Audit a direct edit to a committed task's definition, once its
  -- week has left planning.
  if (new.title is distinct from old.title
      or new.description is distinct from old.description
      or new.task_type_id is distinct from old.task_type_id
      or new.owner_user_id is distinct from old.owner_user_id
      or new.client_ref is distinct from old.client_ref)
     and old.is_committed
     and not core.is_system_caller()
     and coalesce(current_setting('ops.suppress_direct_edit_audit', true), '') <> 'true' then

    select w.state into v_week_state from ops.weeks w where w.id = new.week_id for share;

    if v_week_state is not null and v_week_state <> 'planning' then
      select u.email, u.authority into v_actor_email, v_actor_authority
      from core.users u where u.id = core.auth_user_id();

      insert into core.audit_logs
        (actor_id, actor_email, actor_authority, module, action, entity_type, entity_id, old_values, new_values)
      values
        (core.auth_user_id(), v_actor_email, v_actor_authority, 'ops',
         'ops.task.definition_edited_directly', 'ops.task', new.id,
         (case when new.title is distinct from old.title then jsonb_build_object('title', to_jsonb(old.title)) else '{}'::jsonb end)
         || (case when new.description is distinct from old.description then jsonb_build_object('description', to_jsonb(old.description)) else '{}'::jsonb end)
         || (case when new.task_type_id is distinct from old.task_type_id then jsonb_build_object('task_type_id', to_jsonb(old.task_type_id)) else '{}'::jsonb end)
         || (case when new.owner_user_id is distinct from old.owner_user_id then jsonb_build_object('owner_user_id', to_jsonb(old.owner_user_id)) else '{}'::jsonb end)
         || (case when new.client_ref is distinct from old.client_ref then jsonb_build_object('client_ref', to_jsonb(old.client_ref)) else '{}'::jsonb end),
         (case when new.title is distinct from old.title then jsonb_build_object('title', to_jsonb(new.title)) else '{}'::jsonb end)
         || (case when new.description is distinct from old.description then jsonb_build_object('description', to_jsonb(new.description)) else '{}'::jsonb end)
         || (case when new.task_type_id is distinct from old.task_type_id then jsonb_build_object('task_type_id', to_jsonb(new.task_type_id)) else '{}'::jsonb end)
         || (case when new.owner_user_id is distinct from old.owner_user_id then jsonb_build_object('owner_user_id', to_jsonb(new.owner_user_id)) else '{}'::jsonb end)
         || (case when new.client_ref is distinct from old.client_ref then jsonb_build_object('client_ref', to_jsonb(new.client_ref)) else '{}'::jsonb end));
    end if;
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
      or new.points_awarded is distinct from old.points_awarded) then

    if not core.is_founder() then
      raise exception 'only a founder may set founder_id/founder_acted_at/cleared_at/points_awarded'
        using errcode = '42501';
    end if;

    if not (old.status = 'verified' and new.status = 'cleared') then
      raise exception
        'founder_id/founder_acted_at/cleared_at/points_awarded are server-derived stamps, '
        'set only when a verified task is cleared, and cannot be changed on any other transition'
        using errcode = '42501';
    end if;
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

  if not v_stamped and new.first_in_progress_at is distinct from old.first_in_progress_at then
    raise exception 'first_in_progress_at is a server-derived stamp and cannot be changed'
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

    select w.state into v_week_state from ops.weeks w where w.id = new.week_id for share;
    if v_week_state is not null and v_week_state <> 'planning' then
      raise exception 'commitments are locked for this week' using errcode = '42501';
    end if;
  end if;

  -- 2b. Definition lock.
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
        new.gm_id := core.auth_user_id();
        new.gm_acted_at := now();

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
