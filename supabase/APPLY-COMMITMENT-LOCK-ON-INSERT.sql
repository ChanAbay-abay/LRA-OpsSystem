-- =====================================================================
-- LRA Global Ops :: the Monday record was forgeable with one INSERT
--
-- THE DEFECT. `ops.enforce_task_transition()` carries the commitment
-- lock (its statement 2a): once a week leaves `planning`, nobody may
-- change `is_committed` / `committed_week_id` / `committed_points`. That
-- trigger is BEFORE **UPDATE** only.
--
-- `ops.enforce_initial_task_status()` is the BEFORE INSERT trigger, and
-- it never mentioned the commitment triple at all. It checks the week is
-- not closed, that the status starts at todo/in_progress, that no
-- signature or points stamp is pre-set, and that `created_by` is the
-- caller — and then lets `is_committed = true, committed_points = 21`
-- straight through.
--
-- So the lock only ever applied to CHANGING a commitment, never to
-- arriving with one. A staff member could forge a Monday commitment on a
-- week whose briefing was already closed, for as many points as they
-- liked, and the row would be indistinguishable from a real promise.
-- PostgREST is reachable with any staff login, so this needed no API
-- call and no UI.
--
-- This is the exact thing the product exists to prevent. From PLAN.md:
-- every feature is there to make "what each person committed to on
-- Monday visible, and the record of what they actually did impossible to
-- quietly rewrite afterwards."
--
-- REPRODUCED, not reasoned, against a local stack built from these
-- migrations, as `broker-demo` (staff, not oversight), inside a
-- rolled-back transaction, with a control:
--
--   CONTROL, the UPDATE path, committing an existing task on a locked
--   week:  ERROR: commitments are locked for this week      <- correct
--   PROBE, the INSERT path, a new task carrying the commitment:
--          INSERT ACCEPTED: committed_points=21             <- the hole
--
-- (6 eligible tasks existed for the control, so it was a real test and
-- not a query that matched nothing — checked, because an UPDATE that
-- touches no row also raises no error and would have looked like a pass.)
--
-- THE FIX. `enforce_initial_task_status` now applies the SAME rule
-- statement 2a applies on update, deliberately mirrored rather than
-- invented:
--
--   * a new task may only arrive committed while its week is `planning`;
--   * only the task's owner or oversight may commit it; and
--   * `committed_week_id` must be the task's own week — otherwise a task
--     in one week could carry a promise recorded against another.
--
-- Mirroring matters. A stricter rule ("a new task may never arrive
-- committed") would have been easier to argue for, and would have been a
-- behaviour change beyond the defect — the briefing legitimately creates
-- committed work while the week is still in planning, and that is the
-- ritual this system is built around.
--
-- WHAT THIS DOES NOT FIX, stated rather than left to be discovered.
-- `committed_points` is not checked against the task's own
-- `catalog_points`/`points_override` on EITHER path — so during a
-- `planning` week an owner can still record a promise worth more than
-- the work is priced at. That is pre-existing on the update path, is a
-- smaller hole (the week is still open, so the promise is still being
-- negotiated in the room), and tightening it is a separate decision
-- about where `committed_points` is derived. It is NOT fixed here on
-- purpose: this migration closes the lock that was missing, and does not
-- quietly change a second rule while nobody is looking.
--
-- The system-caller and admin bypasses are left exactly as they were.
-- Seeds, cron and `roll_over_week` run as the service role and must keep
-- creating committed history.
-- =====================================================================

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

  -- THE COMMITMENT LOCK, on the way in. Mirrors statement 2a of
  -- ops.enforce_task_transition() -- same conditions, same sentences, so
  -- the two paths cannot drift into disagreeing about what a commitment
  -- is allowed to be.
  if new.is_committed or new.committed_week_id is not null or new.committed_points is not null then

    if new.owner_user_id <> core.auth_user_id() and not core.is_oversight() then
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
  end if;

  if new.created_by is distinct from core.auth_user_id() then
    raise exception 'created_by must be the creating user'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function ops.enforce_initial_task_status() is
  'BEFORE INSERT trigger on ops.tasks. Mirrors ops.enforce_task_transition()''s '
  'statement 2a: a new task may arrive committed only while its week is in '
  'planning, only from its owner or oversight, and only for its own week. '
  'Before 20260911000000 this trigger ignored the commitment triple entirely, '
  'so the Monday record could be forged with a single INSERT.';
