-- =====================================================================
-- LRA Ops :: restore EXECUTE on the three week routines to `authenticated`
--
-- Correcting an overcorrection. The previous migration revoked EXECUTE on
-- close_week / roll_over_week / generate_recurring_tasks from
-- authenticated, reasoning that an internal routine should not be a
-- public API endpoint. That was wrong here: apps/api/src/routes/weeks.ts
-- calls all three through `userClient`, ON PURPOSE, so that each
-- function's own `core.is_system_caller() or core.is_oversight()` guard
-- is evaluated against the real signed-in caller rather than bypassed by
-- the service role. Routing them through the service client instead would
-- move the authorization decision out of the database and into
-- application code -- the exact mistake this schema exists to avoid.
--
-- Caught by scripts/seed-demo.mjs, which drives every write through a
-- real persona's own token: "permission denied for function
-- generate_recurring_tasks".
--
-- `anon` and PUBLIC stay revoked.
-- =====================================================================

grant execute on function ops.close_week(uuid)               to authenticated;
grant execute on function ops.roll_over_week(uuid)           to authenticated;
grant execute on function ops.generate_recurring_tasks(uuid) to authenticated;
