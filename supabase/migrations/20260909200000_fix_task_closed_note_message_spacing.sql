-- =====================================================================
-- LRA Ops :: fix the stray space in the closed-task note refusal
--
-- Tester defect: attempting a worklog note on a cleared/cancelled task
-- refuses correctly (that logic is untouched) but the message reads
-- "this task is closed (cleared ) and cannot take new notes" -- an
-- extra space before the closing paren, for both `cleared` and
-- `cancelled`, because the format string in
-- `20260909150300_ops_cancellation_approval.sql` literally has one:
-- `'this task is closed (% ) and cannot take new notes'`.
--
-- `create or replace function` with the same signature swaps the body
-- in place; no drop, no change to the trigger that calls it.
-- =====================================================================

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
    raise exception 'this task is closed (%) and cannot take new notes', v_task.status
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
