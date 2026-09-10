-- =====================================================================
-- LRA Global Ops :: task assignment -- unassigned tasks, self-claim,
-- oversight assignment, transfer by invite+accept, and the provenance
-- a committed task's handoff needs.
--
-- Chan's decisions (2026-09-11), binding, in order:
--
--  1. Unassigned tasks exist. `owner_user_id` becomes nullable. An
--     unassigned task cannot change status, cannot be committed, and
--     therefore cannot be submitted -- one early refusal in
--     `enforce_task_transition`, so none of the ladder's existing
--     `new.owner_user_id <> core.auth_user_id()` comparisons silently
--     evaluate to NULL and fall through the wrong branch.
--     `close_briefing` is NOT given a redundant guard for "committed +
--     unassigned" -- that combination is made structurally unreachable
--     here, and proven unreachable in rls_test.sql instead.
--  2. Self-claim: any active ops member may take an UNASSIGNED task for
--     themselves. Never an already-assigned one.
--  3. GM/founder/admin assign directly (`core.is_oversight()` minus
--     read-only, same set `core.is_oversight()` has meant everywhere
--     else in this codebase).
--  4. Transfer by invite + accept, no oversight approval. The current
--     assignee invites another active member; that member accepts or
--     declines; either side may cancel. New table
--     `ops.task_assignment_invites`, RLS-gated so accepting an invite
--     addressed to someone else is not merely refused by a check --
--     the value 'accepted' is UNREACHABLE via any direct client write,
--     full stop; only `ops.accept_task_transfer()` (SECURITY DEFINER,
--     which is how this project already lets one controlled function
--     move a value RLS would otherwise refuse -- see
--     `ops.admin_correct_task`) can produce it, and that function
--     re-checks the identity RLS would have checked anyway.
--  5. A committed task's promise stays with the person who made it.
--     Transferring OWNERSHIP does not move the COMMITMENT --
--     `committed_by_user_id` (new column) is stamped once, at the
--     moment a task becomes committed, and is immutable outside that
--     moment; reliability/hit-rate must read it, not `owner_user_id`.
--     The handoff itself is never invisible: every owner change writes
--     a `core.audit_logs` row, so `GET /api/tasks/:id/history` (which
--     already assembles a timeline from `ops.point_ledger` and
--     `core.audit_logs`) carries it for free -- no new store invented.
--  6. Notify on assign, on transfer invite, and on accept. Notify the
--     previous owner too. Accept reuses the same assign/unassign
--     notification pair every other owner change already writes --
--     the accepter is the actor and is skipped by the existing
--     "unless they are the actor" rule (they just clicked it), the
--     inviter (the previous owner) is not, so they hear that their
--     invite landed.
--
-- Also fixed in this pass, per Chan's explicit ask (defect a):
-- `stamp_catalog_points` was BEFORE INSERT only, so changing a task's
-- type never re-derived `catalog_points` on UPDATE -- a task moved from
-- a 3-point type to a 21-point type silently stayed at 3, including
-- through `admin_correct_task` and an approved GM edit request. Fixed
-- by firing the trigger `OR UPDATE OF task_type_id` too, scoped to
-- `todo`/`in_progress`/`rejected` (a type change past `submitted` is
-- refused outright, by `enforce_task_transition`, which runs first),
-- and re-deriving `committed_points` alongside it ONLY while the task's
-- week is still `planning` -- never touching the Monday record once it
-- is locked.
--
-- REPRODUCED-AGAINST, not assumed: `ops.enforce_task_transition`'s body
-- below is `pg_get_functiondef` off the RUNNING local database
-- (2026-09-11), not hand-diffed from the migration files, per
-- AGENT-LESSONS.md and this migration's own risk note -- it has been
-- `create or replace`d thirteen times and two of those were live string
-- patches. The only intended deltas from that live body are:
--   * new statement 1b (unassigned-task refusal)
--   * statement 2a gains `committed_by_user_id` stamping
--   * new statement 2a2 (committed_by_user_id direct-write guard)
--   * new statement 2b2 (type change refused past submitted)
--   * statement 2b's founder exception also admits the transfer-accept GUC
--   * new statement 2c (ownership authority, notifications, provenance)
-- Nothing else in the ~500-line body is touched.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The schema change.
-- ---------------------------------------------------------------------

alter table ops.tasks alter column owner_user_id drop not null;

alter table ops.tasks
  add column committed_by_user_id uuid references core.users(id);

comment on column ops.tasks.committed_by_user_id is
  'Who made THIS promise -- stamped from owner_user_id the moment is_committed/'
  'committed_week_id/committed_points last changed, server-derived, and never '
  'touched by an ordinary owner_user_id reassignment or transfer. Reliability/'
  'hit-rate must read this, not owner_user_id, so a transferred task''s Monday '
  'commitment still measures the person who made it, per Chan 2026-09-11: '
  '"the task should have a description update that it was originally x'' then '
  'it became y''s."';

-- Backfill: every task committed before this migration existed was
-- necessarily still owned by its committer (transfer did not exist yet),
-- so the current owner IS the historical committer -- the best, and only
-- honest, answer available.
update ops.tasks
set committed_by_user_id = owner_user_id
where is_committed and committed_by_user_id is null;

-- ---------------------------------------------------------------------
-- 2. ops.enforce_initial_task_status -- BEFORE INSERT.
--    Null owner allowed; a null-owner task cannot arrive committed;
--    committed_by_user_id is stamped alongside a legitimate commit; the
--    silent-assignment notice (§3.1(C) of the earlier plan) is added.
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

  -- An unassigned task has nobody to keep a promise, so it cannot arrive
  -- carrying one. Checked before the owner/oversight test below so that
  -- test never has to reason about a null owner.
  if new.owner_user_id is null
     and (new.is_committed or new.committed_week_id is not null or new.committed_points is not null) then
    raise exception 'an unassigned task cannot be committed' using errcode = '42501';
  end if;

  -- THE COMMITMENT LOCK, on the way in. Mirrors statement 2a of
  -- ops.enforce_task_transition() -- same conditions, same sentences, so
  -- the two paths cannot drift into disagreeing about what a commitment
  -- is allowed to be.
  if new.is_committed or new.committed_week_id is not null or new.committed_points is not null then

    if new.owner_user_id is distinct from core.auth_user_id() and not core.is_oversight() then
      raise exception 'only the task owner or oversight may change this task''s commitment'
        using errcode = '42501';
    end if;

    if v_week_state is not null and v_week_state <> 'planning' then
      raise exception 'commitments are locked for this week' using errcode = '42501';
    end if;

    -- A promise belongs to the week the work is in. Without this, a task
    -- created in one week could arrive carrying a commitment recorded
    -- against a different (perhaps already locked) week -- which is the
    -- same forgery by another route.
    if new.committed_week_id is distinct from new.week_id then
      raise exception 'a task''s commitment must belong to its own week'
        using errcode = '42501';
    end if;

    -- Who actually made this promise, stamped once and (per statement
    -- 2a2 in the transition trigger) never client-writable afterward.
    new.committed_by_user_id := new.owner_user_id;
  end if;

  if new.created_by is distinct from core.auth_user_id() then
    raise exception 'created_by must be the creating user'
      using errcode = '42501';
  end if;

  -- Creating a task FOR someone else was, until now, completely silent.
  -- Half of "notify on assign": the other half is
  -- enforce_task_transition's statement 2c, for every owner change on
  -- an existing row.
  if new.owner_user_id is not null and new.owner_user_id is distinct from core.auth_user_id() then
    insert into core.notification_outbox
      (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
    values
      (new.owner_user_id, 'ops', 'ops.task.assigned', 'ops.task', new.id,
       'You have a new task', new.title, '/board');
  end if;

  return new;
end;
$$;

comment on function ops.enforce_initial_task_status() is
  'BEFORE INSERT trigger on ops.tasks. Mirrors ops.enforce_task_transition()''s '
  'statement 2a: a new task may arrive committed only while its week is in '
  'planning, only from its owner or oversight, only for its own week, and '
  'never unassigned. Stamps committed_by_user_id on a legitimate commit and '
  'notifies an owner assigned by someone else.';

-- ---------------------------------------------------------------------
-- 3. ops.enforce_task_transition -- BEFORE UPDATE. Full body copied from
--    the running database (see header), with six deltas: 1b, 2a's
--    committed_by_user_id stamp, 2a2, 2b2, 2b's transfer-GUC exception,
--    and 2c.
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
  -- week has left planning. Suppressed ONLY when both the GUC is set AND
  -- the actor is founder/admin -- see this migration's own note, filed
  -- with the tasks_update RLS fix below, on why the actor check is added
  -- here even though every reachable setter of this GUC today
  -- (ops.admin_correct_task, ops.decide_edit_batch's two paths) already
  -- requires core.is_founder() internally before setting it.
  if (new.title is distinct from old.title
      or new.description is distinct from old.description
      or new.task_type_id is distinct from old.task_type_id
      or new.owner_user_id is distinct from old.owner_user_id
      or new.client_ref is distinct from old.client_ref)
     and old.is_committed
     and not core.is_system_caller()
     and not (
       core.is_founder()
       and coalesce(current_setting('ops.suppress_direct_edit_audit', true), '') = 'true'
     ) then

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

  -- 1b. An unassigned task is inert. Placed here, ABOVE every comparison
  -- in the guards and ladder below that reads new.owner_user_id, so none
  -- of them silently evaluates `NULL <> uuid` to NULL and falls through
  -- the wrong branch -- Chan, 2026-09-11: "tasks cannot move from the
  -- week's list until someone is assigned." An unassigned task cannot
  -- change status (so it cannot be submitted either -- submission is a
  -- status change), and cannot be committed (a commitment is a person's
  -- promise). This makes "committed + unassigned" unreachable, so
  -- ops.close_briefing needs no separate guard for it -- proven, not
  -- assumed, in rls_test.sql.
  if new.owner_user_id is null then
    if new.status is distinct from old.status then
      raise exception 'a task with nobody assigned cannot change status; assign it first'
        using errcode = '42501';
    end if;
    if new.is_committed or new.committed_week_id is not null or new.committed_points is not null then
      raise exception 'an unassigned task cannot be committed' using errcode = '42501';
    end if;
  end if;

  -- An assigned task is never handed back to nobody -- there is no
  -- "unassign" action in this product, only reassignment (claim,
  -- oversight assign, or transfer). Keeps every downstream comparison
  -- that assumes "once non-null, stays non-null" honest.
  if old.owner_user_id is not null and new.owner_user_id is null then
    raise exception 'a task cannot be unassigned once it has an owner; reassign it instead'
      using errcode = '42501';
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

    if new.owner_user_id is distinct from core.auth_user_id() and not core.is_oversight() then
      raise exception 'only the task owner or oversight may change this task''s commitment'
        using errcode = '42501';
    end if;

    select w.state into v_week_state from ops.weeks w where w.id = new.week_id for share;
    if v_week_state is not null and v_week_state <> 'planning' then
      raise exception 'commitments are locked for this week' using errcode = '42501';
    end if;

    -- Who made THIS promise -- always the owner at the moment the
    -- commitment triple last changed, stamped here so a later
    -- reassignment or transfer (which does NOT touch this triple) can
    -- never move it. Uncommitting clears it: there is no promise to
    -- attribute once is_committed is false.
    new.committed_by_user_id := case when new.is_committed then new.owner_user_id else null end;
  end if;

  -- 2a2. committed_by_user_id is a server-derived snapshot, exactly like
  -- catalog_points above -- writable only as a SIDE EFFECT of 2a, never
  -- directly. Without this, a direct PATCH could move the commitment's
  -- attribution to a different person while leaving is_committed/
  -- committed_week_id/committed_points untouched, which is precisely
  -- the thing decision 5 exists to prevent.
  if new.committed_by_user_id is distinct from old.committed_by_user_id
     and new.is_committed is not distinct from old.is_committed
     and new.committed_week_id is not distinct from old.committed_week_id
     and new.committed_points is not distinct from old.committed_points then
    raise exception 'committed_by_user_id is a server-derived snapshot and cannot be changed'
      using errcode = '42501';
  end if;

  -- 2b. Definition lock. The transfer-accept GUC is admitted alongside
  -- the founder exception -- `ops.accept_task_transfer()` is the ONE
  -- controlled path that may move owner_user_id on a committed, locked
  -- task without a founder in the room, because the promise itself
  -- (committed_by_user_id, committed_points, committed_week_id) does not
  -- move with it. An ordinary GM reassignment of a committed, locked
  -- task is still refused here exactly as before.
  if (new.title is distinct from old.title
      or new.description is distinct from old.description
      or new.task_type_id is distinct from old.task_type_id
      or new.owner_user_id is distinct from old.owner_user_id
      or new.client_ref is distinct from old.client_ref)
     and old.is_committed
     and not core.is_founder()
     and current_setting('ops.transfer_accept_task', true) is distinct from new.id::text then

    select w.state into v_week_state from ops.weeks w where w.id = new.week_id for share;
    if v_week_state is not null and v_week_state <> 'planning' then
      raise exception
        'a committed task''s definition (title/description/type/owner/client reference) is locked '
        'once the week has left planning; ask the GM to raise a task edit request'
        using errcode = '42501';
    end if;
  end if;

  -- 2b2. A task's catalog type may not change once it has moved past the
  -- point a reviewer has looked at it -- re-pricing behind their back is
  -- the same defect 2b guards against, wearing a different hat. This is
  -- the primary gate for the re-pricing fix: it runs before
  -- trg_ops_stamp_catalog_points (alphabetically 'enforce_task_transition'
  -- < 'stamp_catalog_points', so this trigger always fires first), so an
  -- illegal type change never reaches the stamp trigger at all.
  if new.task_type_id is distinct from old.task_type_id
     and old.status not in ('todo', 'in_progress', 'rejected') then
    raise exception 'a task''s catalog type cannot change once it has been submitted'
      using errcode = '42501';
  end if;

  -- 2c. Ownership is a controlled decision, and never a silent one.
  -- Three, and only three, ways new.owner_user_id may differ from
  -- old.owner_user_id:
  --   * self-claim: the task is unassigned and the new owner is the
  --     caller themselves, and an active ops member (Chan, 2026-09-11:
  --     "any of the employees can take up the task");
  --   * ops.accept_task_transfer() executing the one UPDATE its own
  --     invite acceptance produces, proven by the transaction-local GUC
  --     it sets immediately before that UPDATE and clears immediately
  --     after (same pattern as ops.admin_correct_task);
  --   * oversight (GM, founder or admin, not read-only) assigning it to
  --     anyone.
  if new.owner_user_id is distinct from old.owner_user_id then

    if old.owner_user_id is null
       and new.owner_user_id = core.auth_user_id()
       and core.is_member('ops') then
      null; -- self-claim
    elsif current_setting('ops.transfer_accept_task', true) = new.id::text
          and new.owner_user_id = core.auth_user_id() then
      null; -- ops.accept_task_transfer() is executing this exact UPDATE
    elsif core.is_oversight() then
      null; -- statement 0 already refused read-only accounts entirely
    else
      raise exception
        'only a GM, founder or admin may change who a task is assigned to -- or, if it is '
        'unassigned, the new owner may claim it themselves'
        using errcode = '42501';
    end if;

    -- The ladder in statement 5 compares against new.owner_user_id, so a
    -- combined reassign+move is checked against the WRONG person. Refuse
    -- the combination rather than silently checking the wrong rule.
    if new.status is distinct from old.status then
      raise exception 'reassign the task, then move it — not both in one write'
        using errcode = '42501';
    end if;

    if new.owner_user_id is distinct from core.auth_user_id() then
      insert into core.notification_outbox
        (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
      values
        (new.owner_user_id, 'ops', 'ops.task.assigned', 'ops.task', new.id,
         'You have a new task', new.title, '/board');
    end if;

    if old.owner_user_id is not null
       and old.owner_user_id is distinct from core.auth_user_id()
       and coalesce(current_setting('ops.suppress_assignment_notice', true), '') <> 'true' then
      insert into core.notification_outbox
        (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
      values
        (old.owner_user_id, 'ops', 'ops.task.unassigned', 'ops.task', new.id,
         'A task moved off your list', new.title, '/board');
    end if;

    -- Provenance. Always written, on every owner change, so the handoff
    -- is never invisible -- GET /api/tasks/:id/history already reads
    -- core.audit_logs for this entity, so it appears there for free.
    -- For a committed task the promise itself does not move (2a's
    -- committed_by_user_id above is untouched by this branch), and that
    -- fact is recorded on the row so the timeline can say so.
    select u.email, u.authority into v_actor_email, v_actor_authority
    from core.users u where u.id = core.auth_user_id();

    insert into core.audit_logs
      (actor_id, actor_email, actor_authority, module, action, entity_type, entity_id, old_values, new_values)
    values
      (core.auth_user_id(), v_actor_email, v_actor_authority, 'ops',
       'ops.task.owner_changed', 'ops.task', new.id,
       jsonb_build_object('owner_user_id', to_jsonb(old.owner_user_id)),
       jsonb_build_object(
         'owner_user_id', to_jsonb(new.owner_user_id),
         'is_committed', new.is_committed,
         'committed_by_user_id', to_jsonb(new.committed_by_user_id)
       ));
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
-- 4. ops.generate_recurring_tasks -- suppress the assignment notice for
--    Monday's automatic generation, exactly the pattern
--    ops.suppress_direct_edit_audit already established. Without this,
--    Monday's generation notifies every person for every recurring task,
--    every week -- it runs as the system caller and 2c is skipped
--    entirely for it (statement 1 returns before 2c is ever reached), so
--    this bracket is dead code today and becomes load-bearing the day
--    generate_recurring_tasks stops running as service role. Added now
--    so that day does not silently reopen this hole.
-- ---------------------------------------------------------------------

do $$
declare
  v_body text;
begin
  select pg_get_functiondef(oid) into v_body
  from pg_proc where proname = 'generate_recurring_tasks' and pronamespace = 'ops'::regnamespace;

  if v_body is not null and v_body not like '%ops.suppress_assignment_notice%' then
    raise notice 'ops.generate_recurring_tasks does not yet set ops.suppress_assignment_notice -- '
      'harmless today (it runs as the system caller, which statement 1 exempts before 2c is ever '
      'reached), but noted so it is not forgotten if that ever changes.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. ops.stamp_catalog_points -- now fires on a type change too, and
--    re-derives committed_points alongside it while (and only while)
--    the task's week is still planning.
-- ---------------------------------------------------------------------

create or replace function ops.stamp_catalog_points()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_week_state ops.week_state;
begin
  if tg_op = 'INSERT' then
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
  end if;

  -- UPDATE: only when the type actually changed. Whether this change is
  -- LEGAL (status must be todo/in_progress/rejected) is decided by
  -- ops.enforce_task_transition's statement 2b2, which fires first
  -- (trigger names are ordered alphabetically and 'enforce_task_transition'
  -- sorts before 'stamp_catalog_points') and raises before this trigger
  -- ever sees an illegal change -- nothing here re-checks status.
  if new.task_type_id is distinct from old.task_type_id then
    if new.task_type_id is null then
      new.catalog_points := null;
    else
      select tt.default_points into new.catalog_points
      from ops.task_types tt
      where tt.id = new.task_type_id;
    end if;

    -- The promise isn't locked yet while the week is still planning, so
    -- a stale committed_points figure is simply wrong and follows the
    -- re-price. Once the week has left planning, committed_points is
    -- the Monday record and is left untouched, exactly like every other
    -- commitment field once the lock applies.
    if new.is_committed then
      select w.state into v_week_state from ops.weeks w where w.id = new.week_id;
      if v_week_state = 'planning' then
        new.committed_points := new.catalog_points;
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_ops_stamp_catalog_points on ops.tasks;
create trigger trg_ops_stamp_catalog_points
  before insert or update of task_type_id on ops.tasks
  for each row execute function ops.stamp_catalog_points();

-- ---------------------------------------------------------------------
-- 6. Transfer by invite + accept.
-- ---------------------------------------------------------------------

create table ops.task_assignment_invites (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references ops.tasks(id),
  from_user_id uuid not null references core.users(id),
  to_user_id   uuid not null references core.users(id),
  status       text not null default 'pending'
                 check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  constraint task_assignment_invites_distinct_users check (from_user_id <> to_user_id)
);

comment on table ops.task_assignment_invites is
  'A transfer offer: the current owner (from_user_id) invites another active ops '
  'member (to_user_id) to take a task over. Either side may cancel/decline via a '
  'direct UPDATE (RLS-gated below); "accepted" is UNREACHABLE by any direct write '
  '-- only ops.accept_task_transfer() can produce it, per Chan 2026-09-11: "invite '
  '+ accept is enough," with the identity check that guarantees an invite can '
  'only ever be accepted by the person it names.';

create index idx_ops_task_invites_task on ops.task_assignment_invites (task_id);
create index idx_ops_task_invites_pending_to on ops.task_assignment_invites (to_user_id) where status = 'pending';
create index idx_ops_task_invites_pending_from on ops.task_assignment_invites (from_user_id) where status = 'pending';

alter table ops.task_assignment_invites enable row level security;

create policy task_invites_select on ops.task_assignment_invites
  for select to authenticated
  using (
    from_user_id = core.auth_user_id()
    or to_user_id = core.auth_user_id()
    or core.is_oversight()
  );

create policy task_invites_insert on ops.task_assignment_invites
  for insert to authenticated
  with check (from_user_id = core.auth_user_id() and not core.is_read_only());

-- 'accepted' is deliberately absent from this WITH CHECK -- see the
-- table comment. Only cancel (by the inviter) and decline (by the
-- invitee), and only while still pending.
create policy task_invites_update on ops.task_assignment_invites
  for update to authenticated
  using (
    not core.is_read_only()
    and status = 'pending'
    and (from_user_id = core.auth_user_id() or to_user_id = core.auth_user_id())
  )
  with check (
    (status = 'cancelled' and from_user_id = core.auth_user_id())
    or (status = 'declined' and to_user_id = core.auth_user_id())
  );

create or replace function ops.enforce_task_transfer_invite()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_owner uuid;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not invite a task transfer' using errcode = '42501';
  end if;

  if new.from_user_id is distinct from core.auth_user_id() then
    raise exception 'from_user_id must be the inviting user' using errcode = '42501';
  end if;

  if not core.is_member('ops') then
    raise exception 'ops module membership is required to transfer a task' using errcode = '42501';
  end if;

  select owner_user_id into v_owner from ops.tasks where id = new.task_id for share;
  if v_owner is null then
    raise exception 'an unassigned task has nothing to transfer -- claim it, or ask oversight to assign it'
      using errcode = '42501';
  end if;
  if v_owner is distinct from core.auth_user_id() then
    raise exception 'only the task''s current owner may invite someone else to take it over'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from core.memberships m
    join core.users u on u.id = m.user_id
    where m.user_id = new.to_user_id and m.module = 'ops' and m.is_active
      and u.is_active and u.deleted_at is null
  ) then
    raise exception 'the invited person must be an active ops member' using errcode = '42501';
  end if;

  if exists (
    select 1 from ops.task_assignment_invites
    where task_id = new.task_id and status = 'pending'
  ) then
    raise exception 'this task already has a pending transfer invite' using errcode = '42501';
  end if;

  new.status := 'pending';
  new.decided_at := null;

  insert into core.notification_outbox
    (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
  select new.to_user_id, 'ops', 'ops.task.transfer_invited', 'ops.task', new.task_id,
         'Someone wants to hand you a task', t.title, '/board'
  from ops.tasks t where t.id = new.task_id;

  return new;
end;
$$;

create trigger trg_ops_enforce_task_transfer_invite
  before insert on ops.task_assignment_invites
  for each row execute function ops.enforce_task_transfer_invite();

create or replace function ops.stamp_task_transfer_invite_decision()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  if new.status in ('declined', 'cancelled') and old.status = 'pending' then
    new.decided_at := now();
  end if;
  return new;
end;
$$;

create trigger trg_ops_stamp_task_transfer_invite_decision
  before update on ops.task_assignment_invites
  for each row execute function ops.stamp_task_transfer_invite_decision();

-- The accept side. SECURITY DEFINER, owned by the table owner, so it
-- bypasses RLS on both tables -- which is exactly why every authority
-- check it needs (membership, identity, staleness) is asked explicitly
-- here, same reasoning ops.admin_correct_task's own comment gives.
create or replace function ops.accept_task_transfer(p_invite_id uuid)
returns ops.tasks
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_invite ops.task_assignment_invites%rowtype;
  v_task   ops.tasks%rowtype;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not accept a task transfer' using errcode = '42501';
  end if;

  if core.auth_user_id() is null then
    raise exception 'ops.accept_task_transfer must be called by a signed-in user' using errcode = '42501';
  end if;

  if not core.is_member('ops') then
    raise exception 'ops module membership is required to accept a task transfer' using errcode = '42501';
  end if;

  select * into v_invite from ops.task_assignment_invites where id = p_invite_id for update;
  if v_invite.id is null then
    raise exception 'unknown transfer invite %', p_invite_id using errcode = 'P0002';
  end if;

  if v_invite.to_user_id is distinct from core.auth_user_id() then
    raise exception 'only the invited person may accept this transfer' using errcode = '42501';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'this invite is no longer pending (%)', v_invite.status using errcode = '42501';
  end if;

  select * into v_task from ops.tasks where id = v_invite.task_id for update;
  if v_task.id is null then
    raise exception 'the task behind this invite no longer exists' using errcode = 'P0002';
  end if;

  if v_task.owner_user_id is distinct from v_invite.from_user_id then
    raise exception 'this task has moved on since the invite was sent, and the invite is stale'
      using errcode = '42501';
  end if;

  perform set_config('ops.transfer_accept_task', v_task.id::text, true);

  update ops.tasks set owner_user_id = core.auth_user_id() where id = v_task.id
  returning * into v_task;

  perform set_config('ops.transfer_accept_task', '', true);

  update ops.task_assignment_invites
  set status = 'accepted', decided_at = now()
  where id = p_invite_id;

  -- Any OTHER pending invite on the same task is stale the instant this
  -- one is accepted -- the task has moved. Cancel them rather than
  -- leaving a ghost invite someone could stumble into "accepting" later
  -- (which ops.accept_task_transfer's own staleness check above would
  -- then refuse anyway, but a pending invite that can never succeed is
  -- a worse UI state than an honestly cancelled one).
  update ops.task_assignment_invites
  set status = 'cancelled', decided_at = now()
  where task_id = v_task.id and status = 'pending' and id <> p_invite_id;

  return v_task;
end;
$$;

revoke all on function ops.accept_task_transfer(uuid) from public;
grant execute on function ops.accept_task_transfer(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 7. ops.tasks' own `tasks_update` RLS policy -- widened for self-claim.
--
-- DEFECT FOUND IN REVIEW, reproduced against the local stack as
-- broker-demo (staff) on a genuinely unassigned task: the row was
-- readable (`tasks_select` scopes by module membership, unaffected) but
-- the self-claim UPDATE matched ZERO rows and raised NOTHING -- a
-- silent no-op, not a refusal with a sentence. `tasks_update`'s USING
-- clause predates nullable owners:
--
--   ((owner_user_id = core.auth_user_id() and core.caller_is_active())
--     or core.is_oversight())
--   and not core.is_read_only()
--
-- For an unassigned row (`owner_user_id is null`) the first branch is
-- `null = caller`, which is NULL, not true, and a plain staff member is
-- not oversight -- so the row is filtered out of the UPDATE target set
-- before `ops.enforce_task_transition` (statement 2c, the actual
-- self-claim authority check) ever runs. The trigger was correct; the
-- row never reached it.
--
-- THE FIX. Add a third branch, scoped as tightly as the two it sits
-- beside: an ACTIVE ops member may reach a row that is currently
-- unassigned. This only widens which rows are VISIBLE to an UPDATE --
-- what the update may actually DO to that row is still decided by
-- WITH CHECK below (unchanged in shape: the resulting new.owner_user_id
-- must still be the caller themselves, or the caller must be oversight)
-- and, underneath that, by statement 2c's own authority ladder (self-
-- claim / oversight-assign / the transfer-accept GUC). A staff member
-- reaching an unassigned row and attempting anything OTHER than
-- claiming it for themselves -- editing a field while leaving it
-- unassigned, or assigning it to someone else -- still fails WITH CHECK,
-- because the resulting row's owner_user_id would be neither the caller
-- nor oversight-authorized.
drop policy tasks_update on ops.tasks;
create policy tasks_update on ops.tasks for update to authenticated
using (
  (
    (owner_user_id = core.auth_user_id() and core.caller_is_active())
    or core.is_oversight()
    or (owner_user_id is null and core.is_member('ops'::core.module) and core.caller_is_active())
  )
  and not core.is_read_only()
)
with check (
  ((owner_user_id = core.auth_user_id() and core.caller_is_active()) or core.is_oversight())
  and not core.is_read_only()
);

-- ---------------------------------------------------------------------
-- 8. ops.enforce_task_transition, statement 0c -- the suppression GUC
-- gains an authority gate.
--
-- FOUND IN REVIEW. `ops.suppress_direct_edit_audit` is set (transaction-
-- local, cleared immediately after) by exactly three callers today --
-- `ops.admin_correct_task`, `ops.decide_edit_batch`'s single-item path,
-- and the batch-approval path -- and every one of those functions
-- already requires `core.is_founder()` (founder or admin) internally
-- before it ever reaches the `perform set_config(...)` line. So there is
-- no REACHABLE path today for a GM or staff member to set this GUC to
-- 'true' at all -- PostgREST exposes no way to call `set_config`
-- directly, only through those three RPCs. But statement 0c's own
-- condition did not say so; it trusted the GUC's value unconditionally,
-- which is a structural gap in exactly the shape this codebase's own
-- house style (`not core.is_read_only()` duplicated in every write
-- predicate, never inherited) says not to leave. Gated on
-- `core.is_founder()` specifically, not `core.is_admin()`: a FOUNDER
-- (not merely an admin) decides an edit batch, and an admin-only gate
-- would silently stop suppression working on that path and start
-- writing a duplicate `ops.task.definition_edited_directly` audit row
-- next to `ops.task.admin_corrected` / the batch's own approval record
-- on every founder approval.

-- Applied directly to statement 0c in the function body above (section 3),
-- rather than pasted here as a second copy of the whole ~500-line function --
-- see 0c's own comment there.
