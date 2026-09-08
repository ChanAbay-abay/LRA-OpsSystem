-- =====================================================================
-- LRA Ops :: recurring generation stamps created_by with the CALLER
--
-- `ops.generate_recurring_tasks` set `created_by = m.user_id` -- the
-- member who will own the task. But that member did not create it: the
-- GM did, by running generation from a template. The INSERT guard
-- (`created_by must be the creating user`) was therefore correct to
-- refuse, and recurring generation could never have worked for any
-- non-admin caller. Caught by scripts/seed-demo.mjs driving the call
-- through the GM's own token rather than the service role.
--
-- Fixed semantically rather than by weakening the guard: created_by is
-- now the authenticated caller, falling back to the owner only for a
-- claimless system connection (a migration or cron), where
-- core.auth_user_id() is null and the guard is bypassed anyway.
-- `owner_user_id` is untouched -- the member still owns the task.
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
  join core.memberships m
    on m.position = rt.position and m.module = 'ops' and m.is_active
  join core.users u on u.id = m.user_id and u.is_active
  where rt.is_active
  on conflict (owner_user_id, week_id, recurring_template_id) where recurring_template_id is not null
  do nothing;

  select count(*) into v_after from ops.tasks where week_id = p_week_id and is_recurring;

  return query select (v_after - v_before)::int;
end;
$function$;

revoke execute on function ops.generate_recurring_tasks(uuid) from public, anon;
grant  execute on function ops.generate_recurring_tasks(uuid) to authenticated;
