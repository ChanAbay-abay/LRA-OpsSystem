-- =====================================================================
-- LRA Ops :: schedule the 14-day account purge
--
-- `core.purge_due_accounts()` has existed since the soft-delete feature
-- shipped, but nothing ever called it -- the 14-day purge only happened
-- if a human remembered. This installs pg_cron and schedules it.
--
-- Why this is safe to run unattended: it only touches accounts that were
-- ALREADY soft-deleted by an admin and whose 14-day grace period has
-- expired. It never decides to delete anyone; it carries out a decision
-- a human made two weeks earlier. It also never destroys history -- it
-- deletes the login and tombstones core.people while every task, ledger
-- and audit row stays attributed.
--
-- It is `security definer` and guarded by `core.is_system_caller()`,
-- which returns true when there are no `request.jwt.claims`. pg_cron
-- sets none, so the guard passes. Verified by reading the live function
-- body AND by executing the function in that exact context (returned 0,
-- nothing due) -- not assumed.
--
-- Schedule: 19:00 UTC daily = 03:00 next day in Asia/Manila, which is
-- what ops.settings.timezone says the company runs on. pg_cron schedules
-- are always UTC. Deliberately in the small hours; a purge that runs
-- mid-morning competes with real usage for nothing.
--
-- `cron.schedule` upserts on job name, so re-running this re-points the
-- same job rather than creating a duplicate.
--
-- NOT scheduled here, on purpose:
--   * `flag-stale` and `drain-outbox` are HTTP endpoints on the API,
--     which is not deployed. Scheduling them needs pg_net pointed at a
--     real base URL, so they belong to Phase 9.
--   * Week creation and week close are NOT automated. PLAN.md Phase 9
--     lists them as cron jobs, but OPEN-QUESTIONS.md #7 says the GM or
--     founder opens and closes the briefing, closing is audit-logged and
--     cannot be undone from the UI. Auto-closing a week would take a
--     governance decision away from a person and silently lock their
--     commitments. That contradiction is Chan's to resolve, not an
--     agent's -- and both functions take a week id that no wrapper
--     currently chooses.
-- =====================================================================

create extension if not exists pg_cron;

select cron.schedule(
  'lra-purge-due-accounts',
  '0 19 * * *',
  $job$select core.purge_due_accounts();$job$
);
