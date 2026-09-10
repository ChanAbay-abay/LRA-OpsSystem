-- =====================================================================
-- LRA Ops :: fixes for the 2026-09-10 adversarial sweep
-- (docs/test-evidence/2026-09-10-adversarial-sweep.md)
--
-- Three real defects, reproduced live by the tester against PostgREST.
-- All three are fixed here in one migration because none of them
-- touches `apps/**` and none of them is separable from the others in a
-- way that would let the RLS suite pass on one without the rest.
-- =====================================================================

-- =====================================================================
-- 1. [Major] core.memberships SELECT policy is infinitely recursive.
--
-- `20260910090000_core_soft_delete_accounts.sql:309-321`'s policy does:
--
--   is_active and caller_is_active() and exists (
--     select 1 from core.memberships caller
--     where caller.user_id = auth_user_id() and caller.is_active)
--
-- The EXISTS subquery selects the very table the policy guards, so
-- Postgres re-evaluates the same RLS-checked policy against the
-- subquery, which re-evaluates it again, forever: 42P17 infinite
-- recursion on every single caller (verified live for founder, gm and
-- broker alike). The fix is the same shape every other cross-table
-- check in `core` already uses (`core.is_member()`, `core.is_admin()`)
-- -- a `security definer` helper, which bypasses RLS on its own read
-- and so cannot recurse into the policy that calls it.
--
-- Meaning preserved exactly: admin sees all; otherwise you see active
-- memberships only if you are yourself an active member (any module,
-- matching the original policy's own module-agnostic EXISTS).
--
-- Checked whether this self-referencing-policy pattern appears
-- anywhere else in the schema: it does not. `memberships_select` is the
-- only policy in the whole database that selects its own table in its
-- USING clause. Not re-checking this elsewhere; there is nowhere else
-- to check.
-- =====================================================================

create or replace function core.caller_has_active_membership()
returns boolean
language sql
stable
security definer
set search_path = core, public
as $$
  select exists (
    select 1 from core.memberships m
    where m.user_id = core.auth_user_id()
      and m.is_active
  );
$$;

comment on function core.caller_has_active_membership() is
  'Module-agnostic "does the caller hold any active membership row" '
  'check, security definer so it bypasses RLS on its own read. Exists '
  'solely so core.memberships'' own SELECT policy does not have to '
  'select core.memberships from inside itself -- that self-reference is '
  'exactly what produced the 42P17 infinite recursion fixed by this '
  'migration (2026-09-10 adversarial sweep, defect 1).';

drop policy memberships_select on core.memberships;
create policy memberships_select on core.memberships for select to authenticated
using (
  core.is_admin()
  or (
    is_active
    and core.caller_is_active()
    and core.caller_has_active_membership()
  )
);

-- =====================================================================
-- 2. [High] founder_id / founder_acted_at / cleared_at / points_awarded
--    can be forged at ANY status, not just points_awarded.
--
-- The tester's live repro forged `points_awarded` on a `todo`-status
-- task via a bare PATCH with no status change, and the forged value
-- survived a rejection and a rework. Root cause: the existing guard in
-- `ops.enforce_task_transition()` --
--
--   if (new.founder_id is distinct from old.founder_id
--       or new.founder_acted_at is distinct from old.founder_acted_at
--       or new.cleared_at is distinct from old.cleared_at
--       or new.points_awarded is distinct from old.points_awarded)
--      and not core.is_founder() then raise ...
--
-- -- only checks WHO may touch these four columns, never WHEN. All four
-- are written by the trigger itself, and ONLY by the trigger, in
-- exactly one place: the `verified -> cleared` branch. Grepped every
-- migration in this repo for `founder_id :=` / `founder_acted_at :=` /
-- `cleared_at :=` / `points_awarded :=` to confirm -- no other legal
-- write path for any of the four exists anywhere in the function's
-- history. So the WHO-only guard leaves all four forgeable by any
-- founder on any status-unchanged update, not just points_awarded --
-- the same root cause, same blast radius, same fix. Fixing only
-- points_awarded and leaving founder_id/founder_acted_at/cleared_at
-- forgeable by the identical mechanism would be patching one instance
-- of the pattern and leaving the rest live.
--
-- Fix: keep the WHO check (only a founder may ever touch these), and
-- add a WHEN check -- none of the four may change on any transition
-- other than the real `verified -> cleared` move. This is NOT the
-- lesson-#7 trap (a trigger tripping its own guard): the guard below
-- runs BEFORE the `case ... when 'verified' then ... new.points_awarded
-- := ...` block that does the real stamping, so at the point this guard
-- evaluates, the trigger has not yet touched any of the four columns --
-- comparing `new` to `old` here still reflects only what the CLIENT
-- sent, not a self-inflicted trip. A legitimate `verified -> cleared`
-- PATCH normally sends no value for these columns at all, so
-- `new.<col> is distinct from old.<col>` is false and the guard never
-- fires; the case block downstream then stamps all four for real. No
-- v_stamped-style flag is needed here because, unlike
-- first_in_progress_at, the guard does not run after its own write.
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

-- =====================================================================
-- 3. [High] ops.task_blocks.created_at / resolved_at are fully
--    client-controlled.
--
-- `created_at` merely defaults to `now()` (client can override at
-- INSERT) and `resolved_at` has no protection at all (client can set it
-- to anything on UPDATE) -- reproduced live: a block backdated 9 days,
-- and an arbitrary literal accepted for `resolved_at`. PRD.md §5.2
-- lets a block declared before a week ends exonerate a missed
-- commitment, and PRD.md §4 defines both Blocked time
-- (Σ resolved_at − created_at) and Cycle time (cleared_at −
-- first_in_progress_at, MINUS blocked time) from these two columns --
-- both are read aloud at the Monday briefing. A client-controlled
-- timestamp here lets anyone retroactively fabricate an excuse or
-- inflate someone's cycle-time-looking-good number.
--
-- Fix, following the same `ops.tasks` stamping/guard pattern already in
-- this file (cleared_at, founder_acted_at, first_in_progress_at):
--   - created_at: stamped by the server at INSERT, immutable after.
--   - resolved_at: forced server-side (now()) the moment it transitions
--     from null to non-null (an actual resolve action); any further
--     change once set is refused. Never accepted verbatim from the
--     client at any point.
--
-- The ONE deliberate exception: `core.is_system_caller()` may supply an
-- explicit created_at at INSERT time. This is not a loophole for an
-- ordinary user -- `core.is_system_caller()` is true only for a direct
-- connection with no JWT claims or a genuine service_role JWT, neither
-- of which a PostgREST-authenticated end user can ever present (see
-- `core.is_system_caller()`'s own comment, core_soft_delete_accounts's
-- HR-lesson copy). It exists because `scripts/seed-demo.mjs` needs to
-- backdate a block on purpose, to build the "exonerating miss" demo
-- scenario -- see the note below and the artifact file for exactly what
-- that script must change to keep working.
--
-- Same v_stamped-avoidance reasoning as first_in_progress_at above does
-- NOT apply here: this is a dedicated trigger with no other guard
-- clause downstream that could re-inspect new vs old after its own
-- write within the same invocation, so no flag is needed -- the
-- INSERT and UPDATE branches are mutually exclusive (TG_OP), and the
-- UPDATE branch's own stamp (setting resolved_at := now()) is the last
-- thing that branch does before returning.
-- =====================================================================

create or replace function ops.stamp_task_block_timestamps()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  if tg_op = 'INSERT' then
    -- Only a genuine system caller (no JWT / real service_role JWT --
    -- never an ordinary authenticated user) may supply an explicit
    -- created_at, for scripts/seed-demo.mjs's deliberate backdating.
    -- Every other caller is stamped with the real time, full stop.
    if core.is_system_caller() then
      new.created_at := coalesce(new.created_at, now());
    else
      new.created_at := now();
    end if;

    -- A block always starts open. resolved_at is never accepted at
    -- creation, from anyone -- there is no legitimate reason to create
    -- an already-resolved block, and allowing it would be an equally
    -- easy way to fabricate a clean resolved_at/created_at pair.
    new.resolved_at := null;
    return new;
  end if;

  -- UPDATE. Admin/system may fix a mis-stamped row directly (support,
  -- data repair) -- same bypass shape as every other guard in this
  -- schema. Everyone else is held to the two rules below.
  if core.is_system_caller() or core.is_admin() then
    return new;
  end if;

  if new.created_at is distinct from old.created_at then
    raise exception 'created_at is a server-derived stamp and cannot be changed'
      using errcode = '42501';
  end if;

  if new.resolved_at is distinct from old.resolved_at then
    if old.resolved_at is null and new.resolved_at is not null then
      -- The real resolve action. Whatever timestamp the client sent is
      -- discarded outright and replaced with the real time -- this is
      -- what closes the "backdated 9 days" attack even when the client
      -- supplies a value rather than merely omitting one.
      new.resolved_at := now();
    else
      -- Either re-nulling an already-resolved block, or moving an
      -- already-set resolved_at to a different value. Neither is a
      -- real product action today; both are exactly the forgery this
      -- fix exists to close.
      raise exception 'resolved_at is a server-derived stamp and cannot be changed once set'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function ops.stamp_task_block_timestamps() is
  'Server-stamps ops.task_blocks.created_at (at INSERT, immutable after) '
  'and resolved_at (forced to now() the moment it is first set, never '
  'accepted verbatim from the client, immutable once set). The one '
  'exception -- an explicit created_at at INSERT -- is reachable only by '
  'core.is_system_caller(), for scripts/seed-demo.mjs''s deliberate '
  'backdated-block demo scenario. 2026-09-10 adversarial sweep, defect 3.';

create trigger trg_ops_stamp_task_block_timestamps
  before insert or update on ops.task_blocks
  for each row execute function ops.stamp_task_block_timestamps();

-- Runs alongside trg_ops_reject_block_cycle (BEFORE INSERT, same table,
-- 20260909090200_ops_task_state_machine.sql). Trigger execution order
-- within the same event is alphabetical by trigger name in Postgres:
-- 'trg_ops_reject_block_cycle' sorts before 'trg_ops_stamp_task_block_
-- timestamps', so the cycle check runs first and can still reject the
-- insert before any timestamp is stamped. Order does not matter for
-- correctness here either way -- the cycle guard reads task_id/
-- blocking_task_id/target/resolved_at, none of which this trigger
-- touches -- but noted for anyone auditing trigger order later.
