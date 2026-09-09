-- =====================================================================
-- LRA Ops :: keep the new functions off the public RPC surface
--
-- Supabase's advisor flagged the functions added for the briefing,
-- catalog deletion and task notes. Postgres grants EXECUTE to PUBLIC by
-- default, so each one became reachable as /rest/v1/rpc/<name> -- to
-- `anon` as well as `authenticated`. Same class of exposure already
-- closed for the week routines in 20260909120000.
--
-- Each of these carries its own authorization guard internally, so this
-- is defence in depth rather than an open door. But an anonymous caller
-- has no business reaching open_briefing at all, and a trigger function
-- should never be an API endpoint.
--
-- The split mirrors the decision in 20260909130000: `authenticated` KEEPS
-- execute on the routines the API deliberately calls through userClient,
-- so each function's own guard is evaluated against the real signed-in
-- caller instead of being bypassed by the service role. Only `anon` and
-- PUBLIC lose it. Trigger functions lose it entirely.
-- =====================================================================

-- Callable by the app, on behalf of a real signed-in user.
revoke execute on function ops.open_briefing(uuid)                       from public, anon;
revoke execute on function ops.close_briefing(uuid)                      from public, anon;
revoke execute on function ops.delete_task_type_if_unused(uuid)          from public, anon;
revoke execute on function ops.delete_recurring_template_if_unused(uuid) from public, anon;
grant  execute on function ops.open_briefing(uuid)                       to authenticated;
grant  execute on function ops.close_briefing(uuid)                      to authenticated;
grant  execute on function ops.delete_task_type_if_unused(uuid)          to authenticated;
grant  execute on function ops.delete_recurring_template_if_unused(uuid) to authenticated;

-- Trigger functions: never an endpoint.
revoke execute on function ops.enforce_task_note_insert()   from public, anon, authenticated;
revoke execute on function ops.forbid_task_note_mutation()  from public, anon, authenticated;

-- Advisor 0011: the one new function that never had search_path pinned.
alter function ops.forbid_task_note_mutation() set search_path = ops, core, public, pg_temp;
