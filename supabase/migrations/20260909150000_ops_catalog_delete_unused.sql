-- =====================================================================
-- LRA Ops :: hard-delete a catalog type or recurring template, but only
-- when it has never been used
--
-- Chan: "add an option where you can CRUD the task types... delete
-- means deactivate, never a hard delete... offer a true hard delete
-- ONLY when the type has never been referenced by any task, and
-- confirm that in the UI."
--
-- `ops.task_types` and `ops.recurring_templates` carry no DELETE policy
-- at all (ops_catalog_rls.sql) -- the ordinary write path is `is_active`
-- via the existing oversight UPDATE policy, which is the correct
-- "delete" for anything with history. Historical `ops.tasks` and
-- `ops.point_ledger` rows reference a task type; hard-deleting a
-- referenced row would orphan the very record this system exists to
-- preserve (PLAN.md, PRD.md §3.3's snapshot rule).
--
-- These two functions are the ONLY path to a real DELETE, and each
-- checks the reference count itself rather than trusting the caller's
-- claim that a row is unused -- the API route calls this function; it
-- never issues `delete from ops.task_types` directly.
-- =====================================================================

create or replace function ops.delete_task_type_if_unused(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may delete a task type' using errcode = '42501';
  end if;

  if not exists (select 1 from ops.task_types where id = p_id) then
    raise exception 'no such task type' using errcode = 'P0002';
  end if;

  if exists (select 1 from ops.tasks where task_type_id = p_id) then
    raise exception
      'this task type has been used by at least one task and cannot be hard-deleted; deactivate it instead'
      using errcode = '23503';
  end if;

  if exists (select 1 from ops.recurring_templates where task_type_id = p_id) then
    raise exception
      'this task type is used by a recurring template and cannot be hard-deleted; retire the template first'
      using errcode = '23503';
  end if;

  -- The task_type_revisions history for this type is deleted with it --
  -- there is nothing left to snapshot once no task ever used the type,
  -- and `on delete cascade` on that FK already expresses this.
  delete from ops.task_types where id = p_id;
end;
$$;

create or replace function ops.delete_recurring_template_if_unused(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may delete a recurring template' using errcode = '42501';
  end if;

  if not exists (select 1 from ops.recurring_templates where id = p_id) then
    raise exception 'no such recurring template' using errcode = 'P0002';
  end if;

  if exists (select 1 from ops.tasks where recurring_template_id = p_id) then
    raise exception
      'this template has already generated at least one task and cannot be hard-deleted; deactivate it instead'
      using errcode = '23503';
  end if;

  delete from ops.recurring_templates where id = p_id;
end;
$$;

comment on function ops.delete_task_type_if_unused(uuid) is
  'The only DELETE path for ops.task_types. Refuses if any ops.tasks or '
  'ops.recurring_templates row references it -- deactivate (is_active = '
  'false) instead. Never called with the service role to skip the check.';
comment on function ops.delete_recurring_template_if_unused(uuid) is
  'The only DELETE path for ops.recurring_templates. Refuses if it has '
  'ever generated a task -- deactivate instead.';
