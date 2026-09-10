-- =====================================================================
-- LRA Ops :: admin corrections -- the power stays, the invisibility goes
--
-- Chan, verbatim: "admin should be able to edit stuff and have it update
-- accordingly on the database incase they do anything wrong and ask me
-- for a correction." and "make it so i also have a description to input
-- the same way they have if somethign has to be edited. that way
-- everyone has checks, balances, and logs"
--
-- THE FINDING THIS CLOSES, verified independently against the live
-- policy and the live trigger body before writing a line of this file:
--
--   `tasks_update` (last redefined 20260910120100_core_read_only_accounts.sql)
--   admits `core.is_oversight()`, and `core.is_oversight()` returns true
--   for authority = 'admin'. `ops.enforce_task_transition()` statement 1
--   is `if core.is_system_caller() or core.is_admin() then return new;
--   end if;` -- an UNCONDITIONAL early return sitting above every guard,
--   every stamp, the ledger insert and the outbox insert.
--
--   So an admin holding nothing but the anon key and their own JWT can
--   call `PATCH /rest/v1/tasks?id=eq.<uuid> { "points_override": 21 }`
--   straight at PostgREST -- no API, no reason, no audit row, no
--   ops.point_ledger row -- and it succeeds today. A polite RPC placed
--   beside that unconditional bypass would not close it; it would only
--   give an honest admin a nicer door while the window stays open. The
--   fix has to be IN the bypass, not next to it.
--
-- THE FIX. Statement 1 becomes conditional: the bypass now fires for
-- `core.is_system_caller()` unconditionally (seeds, cron, the outbox
-- drain, migrations -- not people), and for `core.is_admin()` ONLY when
-- two transaction-local GUCs say a specific, reasoned correction is in
-- flight for THIS row. Set those two GUCs is the only way to obtain the
-- bypass, and the two functions below are the only callers that set
-- them -- so obtaining the bypass now costs a written reason and an
-- audit row, every time.
--
-- WHY FALLING THROUGH IS SAFE, AND IS MOST OF THE FIX. `core.is_founder()`,
-- `core.is_gm()` and `core.is_oversight()` all return true for
-- authority = 'admin'. So every action an admin should be doing day to
-- day -- moving a task, verifying someone's submission, rejecting with a
-- reason, flagging a cancellation, editing a locked definition -- still
-- passes, and now passes through the ORDINARY branches, with ZERO new
-- stamping code:
--
--   * `submitted -> verified` now stamps `gm_id`/`gm_acted_at` for an
--     admin the same way it already does for a GM or founder (the two
--     lines 20260910210000 added). Today it does not; that gap closes
--     for free.
--   * the ledger and outbox stop having admin-shaped holes.
--   * the stamp-forgery, points-reason and commitment-lock guards begin
--     applying to admin for the first time.
--   * "a task owner may not verify their own task" now binds admin too.
--     Arguably the single most valuable line in this change.
--
-- WHY THE STAMP-FORGERY GUARD (statement 2) DOES NOT FIRE on the
-- fall-through: at statement 2 the client has sent no signature columns
-- on an ordinary write, so `new.gm_id is not distinct from old.gm_id`
-- and the guard's condition is false -- it never evaluates
-- `core.is_gm()`. The trigger stamps the row afterwards, in a BEFORE
-- trigger, on its own authority. The guard is not widened, weakened or
-- touched.
--
-- WHAT AN ADMIN CORRECTION MAY CHANGE, AND WHY. `ops.admin_correct_task`
-- accepts the five defining fields (the same set `create_edit_batch`
-- whitelists) plus `points_override`/`points_override_reason`.
-- `points_override` is deliberately IN SCOPE here, unlike the GM's bulk
-- edit suggestion, which deliberately CANNOT express it -- the two
-- mechanisms have different security properties. The suggestion's
-- property is inexpressibility: it is raised by a lower authority and
-- applied by a trigger without a human re-reading it field by field, so
-- "the proposal has no column to say it with" is what stops a GM
-- smuggling a re-pricing into a batch of renames. An admin correction is
-- the opposite: the highest authority, acting in the open, on one named
-- task, with a written reason and an audit row carrying old->new for
-- every column touched. Narrowing the field list here buys no security
-- property -- it only pushes the admin back onto the raw PostgREST PATCH,
-- which is the invisible path this file exists to close.
--
-- WHAT IT MAY NEVER CHANGE, STRUCTURALLY -- NOT A PERMISSION CHECK, A
-- MISSING COLUMN. Chan's ruling: the commitment triple
-- (`is_committed`, `committed_week_id`, `committed_points`) and
-- `week_id` are OUT of scope for a correction. That triple IS the
-- Monday record this whole product exists to protect, and an admin
-- correction must not be able to express a change to it -- the same
-- property the bulk-suggestion mechanism relies on for its own five
-- fields. `ops.admin_correct_task`'s whitelist has no key for any of
-- them, so "propose a change to a commitment" is as inexpressible here
-- as "propose a change to points_override" is in a bulk suggestion.
-- Every server-derived stamp (`catalog_points`, `gm_id`, `gm_acted_at`,
-- `founder_id`, `founder_acted_at`, `cleared_at`, `points_awarded`,
-- `first_in_progress_at`, the five cancellation stamps) is likewise
-- absent from the whitelist, from EVERY path -- a signature you can
-- rewrite is not a signature. `status` is deliberately not here either;
-- see `ops.admin_force_transition` below for why a transition is a
-- separate function.
--
-- REASON FLOOR: 10 trimmed characters. Same bar as rejections,
-- cancellations, cancellation refusals and points overrides. No new
-- number invented.
--
-- ADMIN ONLY, NOT FOUNDER. Chan's word was "admin". A founder already
-- has every legal path through the ordinary ladder; giving them a
-- bypass-with-reason would widen authority nobody asked to widen.
--
-- LOG ONLY. No notification is sent on a correction. It is logged and,
-- because `entity_type` stays 'ops.task', readable by the task's own
-- owner through `core.can_read_audit`'s existing second branch -- the
-- "checks and balances" half of Chan's sentence: the person whose
-- record was corrected can see it, not just admins.
--
-- THE DOUBLE-AUDIT PROBLEM. Statement 0c (the direct-edit audit) runs
-- ABOVE statement 1, so a correction touching a defining field on a
-- committed task in a non-planning week would otherwise write TWO audit
-- rows. Both RPCs bracket their UPDATE with
-- `ops.suppress_direct_edit_audit`, exactly as `ops.decide_edit_batch`
-- does, and clear it immediately after -- per AGENT-LESSONS.md §11, a
-- flag that suppresses an audit must be cleared as deliberately as it
-- is set, and the suite below proves a direct edit later in the same
-- transaction still writes its own row.
--
-- SCOPE. `ops.enforce_task_transition` is a BEFORE UPDATE trigger on
-- `ops.tasks` ONLY. Provisioning (`core.users`/`core.people`/
-- `core.memberships`), `ops.settings`, the catalog, weeks, briefing,
-- recurring generation, the outbox drain and stale-flagging are
-- untouched by this migration -- proven below by two `expect_allowed`
-- assertions with no reason attached.
--
-- ONE KNOWN, DELIBERATE FRICTION: `verified -> cleared` will now refuse
-- an admin who is not the clearing founder, because
-- `core.is_clearing_founder()` reads the per-row `core.users.is_clearing_founder`
-- COLUMN, not authority, and today's unconditional bypass hides that.
-- `core.is_clearing_founder()` is deliberately NOT widened to admit
-- admin -- that would quietly re-open the seat the function exists to
-- keep singular. Chan's decision: one `update core.users set
-- is_clearing_founder = true` on his own account, pasted separately in
-- `supabase/APPLY-ADMIN-CORRECTIONS.sql`, never by widening the
-- function. His account is the only non-demo user in `core.users`,
-- found by querying, not assumed.
--
-- BASE BODY. The `create or replace function ops.enforce_task_transition()`
-- below starts from the definition currently deployed in production
-- (verified against `pg_proc.prosrc` via a live query before this file
-- was written: md5 7d2d9362b12e1ff778ad570da6d4e40f, which is
-- 20260910210000's body -- base md5 3085fa1a0c59d6e23b87a16e2962571c
-- plus the `gm_id`/`gm_acted_at` verification-signature stamp). Every
-- comment already in that body is reproduced verbatim. The ONLY change
-- is statement 1.
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

  -- 1. The bypass, no longer unconditional for admin.
  --
  -- `core.is_system_caller()` keeps its unconditional bypass: seeds,
  -- scripts/, the disposable-week script, cron and the outbox drain run
  -- as service role and are not people; they have nothing to write a
  -- reason about.
  if core.is_system_caller() then
    return new;
  end if;

  -- An admin bypasses ONLY when a DECLARED correction is in flight for
  -- THIS row -- the task id in `ops.admin_correction_task` must match
  -- the row currently being written, and `ops.admin_correction_reason`
  -- must carry >= 10 trimmed characters. Both GUCs are set only by
  -- `ops.admin_correct_task` / `ops.admin_force_transition` below, with
  -- `is_local => true`, immediately before their one UPDATE, and cleared
  -- immediately after it -- the task-id match is what stops a reason set
  -- for task A licensing an unrelated write to task B in the same
  -- transaction, the exact shape of the leak AGENT-LESSONS.md §11
  -- documents.
  if core.is_admin() then
    if current_setting('ops.admin_correction_task', true) = new.id::text
       and length(trim(coalesce(current_setting('ops.admin_correction_reason', true), ''))) >= 10
    then
      return new;
    end if;
    -- otherwise: NO bypass. Fall through to every guard below, exactly
    -- like a founder -- see this file's header for what that closes for
    -- free.
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

-- ---------------------------------------------------------------------
-- Part 2 -- ops.admin_correct_task: a named task, a named set of
-- changes from a fixed whitelist, a mandatory reason, one audit row.
-- Body order copies ops.create_edit_batch rung for rung.
-- ---------------------------------------------------------------------

create or replace function ops.admin_correct_task(p_task_id uuid, p_changes jsonb, p_reason text)
returns ops.tasks
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_task        ops.tasks%rowtype;
  v_before      ops.tasks%rowtype;
  v_key         text;
  v_new_override int;
  v_old_values  jsonb := '{}'::jsonb;
  v_new_values  jsonb := '{}'::jsonb;
  v_actor_email text;
  v_actor_authority core.authority;
begin
  -- Read-only refusal FIRST, ahead of every other bypass -- the
  -- read-only admin persona is real (`readonly_admin` in the suite) and
  -- its `admin` authority would otherwise satisfy `is_admin()` below.
  if core.is_read_only() then
    raise exception 'a read-only account may not correct a task' using errcode = '42501';
  end if;

  if core.auth_user_id() is null then
    raise exception 'ops.admin_correct_task must be called by a signed-in user' using errcode = '42501';
  end if;

  if not core.is_admin() then
    raise exception 'only an admin may correct a task' using errcode = '42501';
  end if;

  -- MEMBERSHIP, asked explicitly because SECURITY DEFINER does not ask
  -- it for us -- same reasoning as ops.create_edit_batch's identical
  -- comment: this function runs as the table owner, for whom RLS is not
  -- enforced, so the policy's is_member('ops') clause never fires for
  -- this write.
  if not core.is_member('ops') then
    raise exception 'ops module membership is required to correct a task' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'an admin correction requires a written reason of at least 10 characters'
      using errcode = '42501';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'an admin correction must change at least one field' using errcode = '42501';
  end if;

  -- The whitelist. Deliberately absent: status (a separate function,
  -- ops.admin_force_transition, below); week_id, is_committed,
  -- committed_week_id, committed_points (out of scope by Chan's
  -- ruling -- this IS the Monday record, and there is no column here to
  -- say a change to it with, structurally, the same guarantee the bulk
  -- edit suggestion relies on for its own five fields); every
  -- server-derived stamp (catalog_points, gm_id, gm_acted_at,
  -- founder_id, founder_acted_at, cleared_at, points_awarded,
  -- first_in_progress_at, the five cancellation columns) -- a signature
  -- you can rewrite is not a signature, from any path, ever.
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('title', 'description', 'task_type_id', 'owner_user_id', 'client_ref',
                      'points_override', 'points_override_reason') then
      raise exception
        'an admin correction may only change title, description, task_type_id, owner_user_id, '
        'client_ref, points_override or points_override_reason; it carried "%"', v_key
        using errcode = '42501';
    end if;
  end loop;

  -- `for update`: the row this function reads and then writes must not
  -- move underneath it -- 20260909190000 is the TOCTOU precedent this
  -- project already paid for.
  select * into v_task from ops.tasks where id = p_task_id for update;
  if v_task.id is null then
    raise exception 'unknown task' using errcode = 'P0002';
  end if;
  v_before := v_task;

  -- points_override: re-check the domain and the reason floor here,
  -- because statement 1's bypass means the trigger's own copy of both
  -- checks never runs for a correction. This is what makes the
  -- >= 10-char points_override_reason floor bind for admin for the
  -- first time -- it does not skip the check, it moves where the check
  -- is made.
  if p_changes ? 'points_override' then
    v_new_override := nullif(p_changes ->> 'points_override', '')::int;
    if v_new_override is not null and v_new_override not in (1, 2, 3, 5, 8, 13, 21) then
      raise exception 'points_override must be one of 1, 2, 3, 5, 8, 13, 21' using errcode = '42501';
    end if;
    if v_new_override is not null
       and (not (p_changes ? 'points_override_reason')
            or length(trim(coalesce(p_changes ->> 'points_override_reason', ''))) < 10) then
      raise exception 'a points override requires a written reason of at least 10 characters'
        using errcode = '42501';
    end if;
  end if;

  -- The GUCs that make statement 1's bypass fire for exactly this row,
  -- plus the suppression that stops statement 0c double-auditing a
  -- defining-field change on a committed, non-planning task -- this
  -- correction's own row below is the complete record of that change.
  -- All three are `is_local => true` (transaction-scoped) and cleared
  -- immediately after the one UPDATE, per AGENT-LESSONS.md §11.
  perform set_config('ops.admin_correction_task', p_task_id::text, true);
  perform set_config('ops.admin_correction_reason', p_reason, true);
  perform set_config('ops.suppress_direct_edit_audit', 'true', true);

  update ops.tasks set
    title = case when p_changes ? 'title' then p_changes ->> 'title' else title end,
    description = case when p_changes ? 'description' then p_changes ->> 'description' else description end,
    task_type_id = case when p_changes ? 'task_type_id'
                         then nullif(p_changes ->> 'task_type_id', '')::uuid else task_type_id end,
    owner_user_id = case when p_changes ? 'owner_user_id'
                          then (p_changes ->> 'owner_user_id')::uuid else owner_user_id end,
    client_ref = case when p_changes ? 'client_ref' then p_changes ->> 'client_ref' else client_ref end,
    points_override = case when p_changes ? 'points_override'
                            then nullif(p_changes ->> 'points_override', '')::int else points_override end,
    points_override_reason = case when p_changes ? 'points_override_reason'
                                   then p_changes ->> 'points_override_reason' else points_override_reason end
  where id = p_task_id
  returning * into v_task;

  perform set_config('ops.admin_correction_task', '', true);
  perform set_config('ops.admin_correction_reason', '', true);
  perform set_config('ops.suppress_direct_edit_audit', 'false', true);

  -- Diff old -> new, only for keys the caller actually named -- the
  -- same merge-not-strip (`||`) construction 20260910200000 uses for
  -- after_values, so a change TO null still survives in the row.
  if p_changes ? 'title' then
    v_old_values := v_old_values || jsonb_build_object('title', to_jsonb(v_before.title));
    v_new_values := v_new_values || jsonb_build_object('title', to_jsonb(v_task.title));
  end if;
  if p_changes ? 'description' then
    v_old_values := v_old_values || jsonb_build_object('description', to_jsonb(v_before.description));
    v_new_values := v_new_values || jsonb_build_object('description', to_jsonb(v_task.description));
  end if;
  if p_changes ? 'task_type_id' then
    v_old_values := v_old_values || jsonb_build_object('task_type_id', to_jsonb(v_before.task_type_id));
    v_new_values := v_new_values || jsonb_build_object('task_type_id', to_jsonb(v_task.task_type_id));
  end if;
  if p_changes ? 'owner_user_id' then
    v_old_values := v_old_values || jsonb_build_object('owner_user_id', to_jsonb(v_before.owner_user_id));
    v_new_values := v_new_values || jsonb_build_object('owner_user_id', to_jsonb(v_task.owner_user_id));
  end if;
  if p_changes ? 'client_ref' then
    v_old_values := v_old_values || jsonb_build_object('client_ref', to_jsonb(v_before.client_ref));
    v_new_values := v_new_values || jsonb_build_object('client_ref', to_jsonb(v_task.client_ref));
  end if;
  if p_changes ? 'points_override' then
    v_old_values := v_old_values || jsonb_build_object('points_override', to_jsonb(v_before.points_override));
    v_new_values := v_new_values || jsonb_build_object('points_override', to_jsonb(v_task.points_override));
  end if;
  if p_changes ? 'points_override_reason' then
    v_old_values := v_old_values
      || jsonb_build_object('points_override_reason', to_jsonb(v_before.points_override_reason));
    v_new_values := v_new_values
      || jsonb_build_object('points_override_reason', to_jsonb(v_task.points_override_reason));
  end if;

  -- "reason" is a sibling key in new_values, never a column name on
  -- ops.tasks (title/description/points_override_reason/rejected_reason/
  -- cancellation_reason exist; a bare "reason" does not), so there is no
  -- collision with the diff above.
  v_new_values := v_new_values || jsonb_build_object('reason', p_reason);

  select u.email, u.authority into v_actor_email, v_actor_authority
  from core.users u where u.id = core.auth_user_id();

  insert into core.audit_logs
    (actor_id, actor_email, actor_authority, module, action, entity_type, entity_id, old_values, new_values)
  values
    (core.auth_user_id(), v_actor_email, v_actor_authority, 'ops',
     'ops.task.admin_corrected', 'ops.task', p_task_id, v_old_values, v_new_values);

  return v_task;
end;
$$;

-- ---------------------------------------------------------------------
-- Part 3 -- ops.admin_force_transition: the illegal-transition case,
-- kept deliberately separate from ops.admin_correct_task. A transition
-- is not a column write -- it fires the ledger, the outbox, the stamps
-- and the notifications on the ordinary path, all derived from
-- old.status/new.status -- and this function's whole purpose is
-- transitions the ordinary ladder refuses (revive a cleared task, skip
-- a rung, move a terminal row). Forcing a status is declaring a state,
-- not manufacturing an approval that never happened, so it derives
-- NOTHING: no ledger row, no outbox row, no stamp. `stamps_not_derived`
-- says so explicitly in the audit row rather than leaving it implied.
-- ---------------------------------------------------------------------

create or replace function ops.admin_force_transition(p_task_id uuid, p_to ops.task_status, p_reason text)
returns ops.tasks
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_task ops.tasks%rowtype;
  v_old_status ops.task_status;
  v_actor_email text;
  v_actor_authority core.authority;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not force a task transition' using errcode = '42501';
  end if;

  if core.auth_user_id() is null then
    raise exception 'ops.admin_force_transition must be called by a signed-in user' using errcode = '42501';
  end if;

  if not core.is_admin() then
    raise exception 'only an admin may force a task transition' using errcode = '42501';
  end if;

  if not core.is_member('ops') then
    raise exception 'ops module membership is required to force a task transition' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'forcing a task transition requires a written reason of at least 10 characters'
      using errcode = '42501';
  end if;

  select * into v_task from ops.tasks where id = p_task_id for update;
  if v_task.id is null then
    raise exception 'unknown task' using errcode = 'P0002';
  end if;

  if v_task.status = p_to then
    raise exception 'the task is already %; there is nothing to force', p_to using errcode = '42501';
  end if;
  v_old_status := v_task.status;

  -- Same two GUCs as ops.admin_correct_task, NOT the suppress-direct-edit
  -- flag -- a forced transition changes no defining field, so statement
  -- 0c never fires for it regardless.
  perform set_config('ops.admin_correction_task', p_task_id::text, true);
  perform set_config('ops.admin_correction_reason', p_reason, true);

  update ops.tasks set status = p_to where id = p_task_id returning * into v_task;

  perform set_config('ops.admin_correction_task', '', true);
  perform set_config('ops.admin_correction_reason', '', true);

  select u.email, u.authority into v_actor_email, v_actor_authority
  from core.users u where u.id = core.auth_user_id();

  insert into core.audit_logs
    (actor_id, actor_email, actor_authority, module, action, entity_type, entity_id, old_values, new_values)
  values
    (core.auth_user_id(), v_actor_email, v_actor_authority, 'ops',
     'ops.task.admin_forced_transition', 'ops.task', p_task_id,
     jsonb_build_object('status', v_old_status),
     jsonb_build_object('status', p_to, 'reason', p_reason, 'stamps_not_derived', true));

  return v_task;
end;
$$;

-- ---------------------------------------------------------------------
-- Part 4 -- grants. EXECUTE to `authenticated`, deliberately, and NOT
-- via the service role -- 20260909130000 is the precedent and its
-- reasoning applies verbatim: these functions must run on `userClient`
-- so their own core.is_admin()/core.is_read_only() guards see the real
-- signed-in caller. `core.auth_user_id()` is null on a service-role
-- connection, so core.is_read_only() returns false for everyone there --
-- routing this through the service role would move the authorization
-- decision out of the database and into application code.
-- ---------------------------------------------------------------------

revoke all on function ops.admin_correct_task(uuid, jsonb, text) from public;
revoke all on function ops.admin_force_transition(uuid, ops.task_status, text) from public;

grant execute on function ops.admin_correct_task(uuid, jsonb, text) to authenticated, service_role;
grant execute on function ops.admin_force_transition(uuid, ops.task_status, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Part 5 -- comments, so the rule is discoverable from psql \df+ and not
-- only from this file.
-- ---------------------------------------------------------------------

comment on function ops.enforce_task_transition() is
  'BEFORE UPDATE trigger on ops.tasks. Statement 1''s admin bypass is '
  'CONDITIONAL: it fires only when ops.admin_correction_task (transaction-'
  'local) equals the row being written and ops.admin_correction_reason '
  'carries >= 10 trimmed characters -- both set only by '
  'ops.admin_correct_task / ops.admin_force_transition. Without them an '
  'admin falls through to the ordinary ladder, exactly like a founder.';

comment on function ops.admin_correct_task(uuid, jsonb, text) is
  'The only way an admin may change title/description/task_type_id/'
  'owner_user_id/client_ref/points_override/points_override_reason '
  'outside the ordinary ladder. Requires a written reason of >= 10 '
  'trimmed characters; writes one core.audit_logs row '
  '(ops.task.admin_corrected) with old/new values and the reason. '
  'Cannot touch status, week_id, is_committed, committed_week_id, '
  'committed_points, or any server-derived stamp -- none of those '
  'columns are in the whitelist, on any path.';

comment on function ops.admin_force_transition(uuid, ops.task_status, text) is
  'The only way an admin may force a task past a transition the ordinary '
  'ladder refuses (revive a cleared task, skip a rung). Requires a '
  'written reason of >= 10 trimmed characters; writes one '
  'core.audit_logs row (ops.task.admin_forced_transition) with '
  'stamps_not_derived: true. Derives NO stamp, writes NO ledger row -- '
  'forcing a status declares a state, it does not manufacture an '
  'approval that never happened.';


-- =====================================================================
-- CHAN'S DECISION 1, SEPARATE FROM THE MIGRATION ABOVE, AND DELIBERATELY
-- NOT A create or replace on any function.
--
-- `verified -> cleared` now refuses an admin who is not the clearing
-- founder, because `core.is_clearing_founder()` reads the per-row
-- `core.users.is_clearing_founder` COLUMN, not authority -- and today's
-- unconditional admin bypass was the only thing hiding that friction.
--
-- Chan's ruling (option A): flip the column on his own account, once,
-- rather than widen `core.is_clearing_founder()` to admit `admin` --
-- widening the function would quietly re-open the single clearing seat
-- it exists to keep singular, for every admin account present or future,
-- not just his.
--
-- His account is the only non-demo user in `core.users` -- confirmed by
-- querying live data, not assumed: `chanabayabay@gmail.com`,
-- id b33eefcf-3de8-4fcd-adc0-29df38de3f71, authority = 'admin',
-- is_clearing_founder = false (read at the time this file was written).
-- The column's own comment already says no migration is needed for this
-- kind of one-row change.
--
-- Run this once, after the migration above has been applied. Idempotent
-- -- running it twice sets the same value both times.
-- =====================================================================

update core.users
set is_clearing_founder = true
where email = 'chanabayabay@gmail.com';
