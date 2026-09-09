-- =====================================================================
-- LRA Ops :: recurring generation skips a deactivated task type
--
-- Chan's catalog-CRUD ask: "deactivated types must not appear when
-- creating new work." Deactivating an `ops.task_types` row already
-- keeps it out of the manual task-creation path (the API/UI simply
-- lists active types), but `ops.generate_recurring_tasks` only checked
-- `rt.is_active` on the TEMPLATE -- a template can stay active while
-- the task type it points at gets deactivated, and generation would
-- keep manufacturing new work against a retired type every week.
--
-- Extended (`create or replace`, never editing the applied migration):
-- join `ops.task_types` and require `tt.is_active` too. Everything else
-- is reproduced verbatim from `20260909140000_...caller.sql`.
-- =====================================================================

create or replace function ops.generate_recurring_tasks(p_week_id uuid)
returns table(created_count integer)
language plpgsql
security definer
set search_path to 'ops', 'core', 'public'
as $function$
declare
  v_before bigint;
  v_after bigint;
begin
  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may generate recurring tasks' using errcode = '42501';
  end if;

  if not exists (select 1 from ops.weeks where id = p_week_id) then
    raise exception 'unknown week %', p_week_id using errcode = 'P0002';
  end if;

  select count(*) into v_before from ops.tasks where week_id = p_week_id and is_recurring;

  insert into ops.tasks
    (week_id, owner_user_id, task_type_id, title, description, status,
     is_recurring, recurring_template_id, created_by)
  select
    p_week_id,
    m.user_id,
    rt.task_type_id,
    rt.title,
    rt.description,
    'todo',
    true,
    rt.id,
    coalesce(core.auth_user_id(), m.user_id)
  from ops.recurring_templates rt
  join ops.task_types tt on tt.id = rt.task_type_id
  join core.memberships m
    on m.position = rt.position and m.module = 'ops' and m.is_active
  join core.users u on u.id = m.user_id and u.is_active
  where rt.is_active and tt.is_active
  on conflict (owner_user_id, week_id, recurring_template_id) where recurring_template_id is not null
  do nothing;

  select count(*) into v_after from ops.tasks where week_id = p_week_id and is_recurring;

  return query select (v_after - v_before)::int;
end;
$function$;

revoke execute on function ops.generate_recurring_tasks(uuid) from public, anon;
grant  execute on function ops.generate_recurring_tasks(uuid) to authenticated;
