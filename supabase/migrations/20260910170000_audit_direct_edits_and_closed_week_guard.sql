-- =====================================================================
-- LRA Ops :: audit the founder/admin direct-edit path, and refuse an
-- INSERT into a closed week.
--
-- The founder/admin direct-edit dialog (apps/web,
-- task-edit-request-dialog.tsx `direct` mode) shipped able to rewrite a
-- committed, locked task's definition through the real, already-
-- enforced `PATCH /api/tasks/:id` -> `ops.enforce_task_transition`'s
-- guard 2b (`core.is_founder()` exemption). What it left behind: guard
-- 2b decides WHO may make the change and WHEN, but writes no record of
-- WHAT changed. When a GM's edit request is approved instead
-- (20260910140000), the exact before/after lands in `core.audit_logs`.
-- An accountability system whose only unrecorded edit is the one made
-- by its most privileged actor has the property backwards -- Chan's own
-- framing: "the record of what was committed to on Monday cannot be
-- quietly rewritten," and this is the one path where it could be,
-- silently.
--
-- Two independent defects fixed here, plus a decision recorded rather
-- than made silently:
--
-- 1. No audit row for a direct definition edit on a committed task
--    whose week has left `planning`. Fixed in the trigger, not the API
--    -- PostgREST is reachable directly, so a guard that only lived in
--    `routes/tasks.ts` would not be a guard at all, the same reasoning
--    every other rule in `ops.enforce_task_transition` already follows.
--
-- 2. `ops.tasks`'s `tasks_insert` policy has no week-state check, so a
--    task can be INSERTed straight into an already-`closed`, already-
--    scored week -- the UI's week picker filters closed weeks out, but
--    that is cooperation, not enforcement, and PostgREST is reachable
--    without the UI at all.
--
-- 3. Owner reassignment on a direct edit: `PATCH /api/tasks/:id`'s
--    `patchSchema` had no `ownerUserId` field, so the direct-edit
--    dialog disabled that toggle even though guard 2b's own exemption
--    (`core.is_founder()`) would otherwise allow a founder/admin to
--    change `owner_user_id` exactly like title/description/type/
--    client_ref. Chan's rule ("Only admin and founder" may edit a
--    locked definition) names the whole definition, owner included, so
--    this migration does not change the trigger at all for owner
--    reassignment -- 2b already covers `owner_user_id` in its column
--    list and always has. The only gap was the API route refusing to
--    forward the field; that is closed in `apps/api/src/routes/
--    tasks.ts` alongside this migration, gated to founder/admin only
--    (the same authorities 2b exempts), and flows through the same
--    audit logging added below because it is one of the five columns
--    that logging already watches.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Part 1 -- audit the direct definition edit, in
-- ops.enforce_task_transition(). Reproduced in full from its current
-- live body (20260910160000's copy -- the last migration to touch it);
-- `create or replace`, never an edit of an applied migration.
--
-- New block "0c" sits BEFORE the admin/system bypass at statement 1, on
-- purpose. Every guard added to this function so far (2a, 2b, the
-- forgery guards) lives AFTER statement 1, which is correct for a rule
-- that should not bind admin at all -- but an audit log is not a rule
-- that binds anyone, and admin bypassing statement 1 already means
-- admin's own direct edits would be invisible to any logging placed
-- after it, which is exactly the "most privileged, least visible"
-- inversion this migration exists to close. `core.is_system_caller()`
-- IS excluded from 0c explicitly (see the condition below) -- that
-- bypass exists for migrations, `scripts/seed-demo.mjs`, and other
-- fixture/system writes that are not a real user editing a real
-- commitment, and logging every one of those would drown the signal
-- with the exact kind of noise this feature exists to avoid.
--
-- A refused attempt (staff or GM, still caught by 2b further down)
-- never leaves a log behind: 0c fires unconditionally on "did these
-- five columns change on an already-committed, out-of-planning task",
-- before the function knows whether the caller will ultimately be
-- allowed to keep that change. If 2b then raises, the whole statement
-- -- and this INSERT along with it -- rolls back inside the same
-- transaction. No separate "was this actually allowed" check is needed
-- here; Postgres's own transaction boundary already guarantees it, the
-- same reasoning HR/Ops already lean on elsewhere in this schema.
--
-- Deliberately excludes an edit-request approval applying its own
-- change. `ops.enforce_task_edit_request_transition()` (Part 2 of
-- 20260910140000) applies an approval via its own internal
-- `update ops.tasks set ...`, which re-enters THIS trigger on the same
-- row. Without a way to tell "this UPDATE is the approval itself" apart
-- from "this UPDATE is a bare direct edit," every GM-requested,
-- founder-approved change would write TWO audit rows -- the edit
-- request's own (already correct) row, and a second one from here, which
-- is not a second signal, only noise on top of a working feature.
--
-- lesson #7 (docs/AGENT-LESSONS.md) is exactly on point here, but the
-- shape of the fix differs from `v_stamped`: that flag distinguished the
-- trigger's own write from a client's write WITHIN one function
-- invocation, using a plain plpgsql local variable. Here the two writes
-- are in DIFFERENT trigger invocations (the outer UPDATE on
-- ops.task_edit_requests, and the inner UPDATE on ops.tasks it causes) --
-- a plpgsql `declare` variable resets on every call and cannot cross
-- that boundary. The cross-invocation analogue is a transaction-scoped
-- Postgres GUC: `ops.enforce_task_edit_request_transition()` calls
-- `set_config('ops.suppress_direct_edit_audit', 'true', true)`
-- immediately before its own internal `update ops.tasks`
-- (`is_local => true`, so it cannot outlive the current transaction and
-- so cannot leak into any later, unrelated request). 0c reads it back
-- with `current_setting(..., true)` (missing_ok, so an unset GUC reads
-- as null rather than raising) -- on every ordinary request nobody has
-- ever set it, which is the common case this must not slow down or
-- break.
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
  -- True only when statement 0b below stamped the column itself. The
  -- forgery guard at statement 2 must not fire on the trigger's OWN
  -- write: without this flag every legitimate todo -> in_progress move
  -- by a normal (non-system, non-admin) caller raised
  -- 'first_in_progress_at is a server-derived stamp and cannot be
  -- changed', because 0b makes new distinct from old before the guard
  -- compares them. Caught by the RLS suite ("staff CAN still move a
  -- locked committed task's status"), 2026-09-10.
  v_stamped boolean := false;
begin
  -- 0. Read-only refusal, ahead of every other bypass.
  if core.is_read_only() then
    raise exception 'a read-only account may not change a task' using errcode = '42501';
  end if;

  -- 0b. Cycle-time start stamp. First real transition into in_progress
  -- only -- see header. Runs before the system/admin bypass so it
  -- fires for every path that can move a task, not only owner-driven
  -- ones.
  if new.status = 'in_progress'
     and new.status is distinct from old.status
     and old.first_in_progress_at is null then
    new.first_in_progress_at := now();
    v_stamped := true;
  end if;

  -- 0c. Audit a direct edit to a committed task's definition, once its
  -- week has left planning -- see header for why this sits ahead of the
  -- admin/system bypass, and why an edit-request approval is excluded.
  if (new.title is distinct from old.title
      or new.description is distinct from old.description
      or new.task_type_id is distinct from old.task_type_id
      or new.owner_user_id is distinct from old.owner_user_id
      or new.client_ref is distinct from old.client_ref)
     and old.is_committed
     and not core.is_system_caller()
     and coalesce(current_setting('ops.suppress_direct_edit_audit', true), '') <> 'true' then

    -- `for share`: same TOCTOU reasoning as 2a/2b below (20260909190000)
    -- -- a lock on the week row this read depends on.
    select w.state into v_week_state from ops.weeks w where w.id = new.week_id for share;

    if v_week_state is not null and v_week_state <> 'planning' then
      select u.email, u.authority into v_actor_email, v_actor_authority
      from core.users u where u.id = core.auth_user_id();

      insert into core.audit_logs
        (actor_id, actor_email, actor_authority, module, action, entity_type, entity_id, old_values, new_values)
      values
        (core.auth_user_id(), v_actor_email, v_actor_authority, 'ops',
         'ops.task.definition_edited_directly', 'ops.task', new.id,
         -- Same merge-not-strip construction ops.task_edit_requests
         -- already uses for before_values/after_values, and for the
         -- same reason: a field genuinely being set to null (clearing a
         -- description) must still carry its key, not be stripped by
         -- treating null as "field not present."
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

  -- founder_id / founder_acted_at / cleared_at / points_awarded are all
  -- stamped in exactly one place below: the verified -> cleared branch.
  -- Both WHO (only a founder, ever) and WHEN (only on that one real
  -- transition) must hold, or a founder can forge a "settled" value on
  -- a task that was never cleared -- 2026-09-10 sweep, defect 2.
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
-- Part 2 -- suppress the tasks-level audit above when an edit request's
-- OWN approval applies the change. Reproduced in full from
-- 20260910140000's copy (the only migration ever to define this
-- function), plus one line: `perform set_config(...)` immediately
-- before the internal `update ops.tasks`.
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

      -- Transaction-scoped flag (see Part 1's header) so the internal
      -- UPDATE below does not ALSO trip the tasks-level direct-edit
      -- audit -- this approval's own audit row, written further down in
      -- THIS function, is already the correct, complete record of this
      -- change. `is_local => true`: reverts automatically at the end of
      -- this transaction (one PostgREST request), so it can never leak
      -- into a later, unrelated request.
      perform set_config('ops.suppress_direct_edit_audit', 'true', true);

      update ops.tasks set
        title         = case when old.change_title then old.proposed_title else title end,
        description   = case when old.change_description then old.proposed_description else description end,
        task_type_id  = case when old.change_task_type_id then old.proposed_task_type_id else task_type_id end,
        owner_user_id = case when old.change_owner_user_id then old.proposed_owner_user_id else owner_user_id end,
        client_ref    = case when old.change_client_ref then old.proposed_client_ref else client_ref end
      where id = old.task_id;

      -- ...and cleared again the instant that UPDATE is done. `is_local`
      -- scopes the flag to the TRANSACTION, not to the statement, so
      -- without this line it stays 'true' for everything that follows.
      -- Under PostgREST one request is one transaction and the leak was
      -- invisible -- but in ANY transaction that does more than this one
      -- approval, every LATER direct definition edit would silently skip
      -- its audit row: precisely the "most privileged, least visible"
      -- inversion Part 1 exists to close, reintroduced by the mechanism
      -- meant to keep it quiet. Reproduced and caught by the RLS suite's
      -- own 'that direct edit wrote exactly one audit_logs row'
      -- assertion, 2026-09-10 -- it went red on the first live run of
      -- this migration, which is exactly what that assertion is for.
      perform set_config('ops.suppress_direct_edit_audit', 'false', true);

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

-- ---------------------------------------------------------------------
-- Part 3 -- refuse creating a task in a closed week. Reproduced in full
-- from 20260909090200's copy (the only migration ever to define this
-- function), plus the week-state check.
--
-- `open` vs `closed`, reasoned explicitly since Chan asked for it:
--
--   - `planning` -- the normal creation window, untouched. This is what
--     the week IS before Monday's briefing closes it.
--   - `open` -- mid-week, after the briefing has closed and
--     commitments are locked. Discovering NEW work mid-week is
--     completely ordinary here (a client calls in with an unplanned
--     shipment on Wednesday; someone opens a task for it same-day) --
--     PRD.md never says new tasks stop being creatable once the week is
--     underway, only that EXISTING commitments freeze. Refusing INSERT
--     here would make it impossible to log any work discovered after
--     Monday, which is a much larger regression than the defect this
--     migration fixes. `open` is therefore explicitly NOT refused.
--   - `closed` -- the week is fully wound down: it has been scored,
--     read aloud at the following Monday's briefing, and nothing about
--     it can be acted on any more (no commit, no status transition
--     survives being closed either -- 2a's own week-state check already
--     refuses altering a commitment in a non-planning week, and no
--     other function ever un-closes a week). A NEW task materializing
--     inside it is pure retroactive fabrication with no legitimate
--     case behind it. This is the one state refused.
--
-- Same bypass shape as every guard already in this schema
-- (`core.is_system_caller() or core.is_admin()` returns immediately) --
-- admin is deliberately outside every business ladder (PRD.md §2), and
-- `scripts/seed-demo.mjs` needs to seed historical tasks into weeks that
-- are `closed` by the time the script runs (the "exonerating miss" demo
-- scenario, 20260910160000's header) -- refusing system-caller inserts
-- here would break that seed the same way refusing it in
-- ops.stamp_task_block_timestamps would have.
--
-- The check runs as a `raise exception` inside this existing BEFORE
-- INSERT trigger, not as an added clause on the `tasks_insert` RLS
-- policy. Two reasons: (1) it produces the same clear, human-readable
-- refusal message every other rule in this schema already gives,
-- instead of Postgres's generic "new row violates row-level security
-- policy" -- `apps/api/src/routes/tasks.ts`'s POST handler already
-- forwards a trigger's own message verbatim (matching every other
-- write route in this file), so this is the one change needed for
-- Chan's "return a clear error rather than a raw database refusal"
-- ask; (2) a WITH CHECK clause on `ops.tasks` reading `ops.weeks` would
-- be subject to `ops.weeks`'s own SELECT policy the way
-- `core.memberships`' self-referencing policy was (the 2026-09-10
-- adversarial sweep's defect 1) -- not a recursion here, but the same
-- family of risk: if the inserting caller could not SELECT the row for
-- any reason, an EXISTS/subquery-based check could silently see zero
-- rows and let the insert through. A SECURITY DEFINER trigger reading
-- `ops.weeks` directly (exactly as 2a/2b in `ops.enforce_task_transition`
-- already do) has no such blind spot.
-- ---------------------------------------------------------------------
create or replace function ops.enforce_initial_task_status()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_catalog_points int;
  v_week_state ops.week_state;
begin
  if core.is_system_caller() or core.is_admin() then
    return new;
  end if;

  select w.state into v_week_state from ops.weeks w where w.id = new.week_id for share;
  if v_week_state = 'closed' then
    raise exception 'this week is closed and cannot take a new task' using errcode = '42501';
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

comment on function ops.enforce_task_transition() is
  'The task ladder, plus (0c) an audit row for a direct founder/admin '
  'edit to a committed, out-of-planning task''s definition -- the same '
  'shape ops.task_edit_requests'' own approval audit already writes, so '
  'the two are readable side by side. 2026-09-10, closing the gap left '
  'by the founder/admin direct-edit UI feature.';

comment on function ops.enforce_initial_task_status() is
  'A new task must start at todo/in_progress, un-stamped, owned by its '
  'creator, and -- as of 2026-09-10 -- not be inserted into an '
  'already-closed week. `open` (mid-week) and `planning` both remain '
  'legal creation windows; only `closed` is refused.';
