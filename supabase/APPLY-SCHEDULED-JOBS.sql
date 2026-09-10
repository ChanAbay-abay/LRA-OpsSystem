-- =====================================================================
-- LRA Ops :: the four scheduled jobs, moved INTO the database
--
-- WHY THIS EXISTS. PLAN.md Phase 9 names four scheduled jobs. Two of
-- them (`drain-outbox`, `flag-stale`) shipped as admin-authenticated
-- POST routes on the Fastify API, and 20260910130000 explained plainly
-- why it did not schedule them: pg_cron runs inside Postgres, the API
-- runs on a laptop, and pg_cron cannot reach it. Scheduling them from
-- the database would have meant pg_net pointed at a base URL that does
-- not exist yet. The other two -- week rollover and week close -- were
-- left unscheduled because neither function chooses its own week.
--
-- Both drainer and flagger are pure table-to-table set operations. SQL
-- is their natural home, and moving them here unblocks scheduling with
-- no deployment at all. The HTTP routes stay exactly as they are; their
-- TypeScript now calls these functions instead of reimplementing them,
-- so there is ONE implementation, not two that can drift.
--
-- AUTHORIZATION UNDER CRON. `core.is_system_caller()` returns true when
-- `request.jwt.claims` is absent entirely -- a direct connection, which
-- is what a pg_cron job is. Confirmed by reading the function body
-- (20260908120100) and, for the week functions specifically, by calling
-- `ops.close_current_week()` on the live database inside an aborted
-- transaction over a direct connection: it passed the
-- `is_system_caller() or is_oversight()` guard rather than raising
-- 42501. `core.auth_user_id()` IS null under cron, which matters in
-- exactly one place: `ops.close_week` stamps `closed_by =
-- core.auth_user_id()`, so a cron-closed week has a null `closed_by`.
-- That column is nullable with no FK requirement to be present, and a
-- null there is the honest record: no person closed this week, the
-- schedule did. `closed_at` still carries the moment.
--
-- WHAT IS DELIBERATELY NOT HERE. `ops.generate_recurring_tasks` is not
-- called by the Monday wrapper. It is idempotent and would be safe, but
-- populating a week with tasks nobody has seen yet is a separate
-- decision from opening the week, and it was not asked for. The
-- briefing screen still generates them.
--
-- THE GOVERNANCE CONTRADICTION, STATED OUT LOUD. 20260910130000 argued
-- that week close should NOT be automated: OPEN-QUESTIONS.md #7 says the
-- GM or founder opens and closes the briefing, closing is audit-logged
-- and cannot be undone from the UI, so auto-closing takes a governance
-- decision away from a person. This migration schedules it anyway,
-- because that is what was asked for -- but it narrows the blast radius
-- as far as the semantics allow (see `ops.close_current_week` below: it
-- refuses to close a week still in `planning`). If Chan wants the human
-- to keep the close, unschedule `lra-close-week` and nothing else
-- changes.
-- =====================================================================

create extension if not exists pg_cron;

-- ---------------------------------------------------------------------
-- core.drain_notification_outbox(limit) -- the outbox drainer
--
-- Same semantics as the TypeScript in apps/api/src/services/outbox.ts:
-- `pending` + `in_app` rows whose `available_at` has arrived, oldest
-- first, each inserted into core.notifications and then marked `sent`;
-- a row whose insert raises is marked `failed` with the message and an
-- incremented attempt count, and the loop continues.
--
-- created_at IS CARRIED ACROSS. `core.notifications.created_at`
-- defaults to now(), and letting it default dates every notification to
-- the drain rather than to the moment the thing happened. That was
-- invisible while the drainer ran often and obvious the first time a
-- backlog drained -- hundreds of notifications spanning two days all
-- reading the same minute, an inbox that could not be ordered. The
-- explicit `o.created_at` below is the whole point of this column list.
--
-- FOR UPDATE SKIP LOCKED is new, and is not an embellishment: this is
-- scheduled every minute, and pg_cron will happily start run N+1 while
-- run N is still going. Without the lock two concurrent drains select
-- the same pending rows and each inserts a notification -- a duplicate
-- in a user's inbox. Skipping locked rows makes the overlap harmless.
-- ---------------------------------------------------------------------
create or replace function core.drain_notification_outbox(p_limit int default 500)
returns table (drained int, failed int)
language plpgsql
security definer
set search_path = core, public, pg_temp
as $$
declare
  v_row core.notification_outbox%rowtype;
  v_drained int := 0;
  v_failed  int := 0;
begin
  if not core.is_system_caller() then
    raise exception 'only the system may drain the outbox' using errcode = '42501';
  end if;

  for v_row in
    select *
    from core.notification_outbox
    where channel = 'in_app'
      and state = 'pending'
      and available_at <= now()
    order by created_at asc
    limit greatest(p_limit, 0)
    for update skip locked
  loop
    begin
      insert into core.notifications
        (user_id, title, message, entity_type, entity_id, link, created_at)
      values
        (v_row.recipient_id, v_row.title, v_row.body, v_row.entity_type,
         v_row.entity_id, v_row.link, v_row.created_at);

      update core.notification_outbox
      set state = 'sent', sent_at = now(), attempts = v_row.attempts + 1
      where id = v_row.id;

      v_drained := v_drained + 1;
    exception when others then
      -- The failed INSERT is rolled back with this subtransaction; the
      -- UPDATE that records the failure is not, because it runs after.
      update core.notification_outbox
      set state = 'failed', attempts = v_row.attempts + 1, last_error = sqlerrm
      where id = v_row.id;

      v_failed := v_failed + 1;
    end;
  end loop;

  return query select v_drained, v_failed;
end;
$$;

-- ---------------------------------------------------------------------
-- ops.flag_stale_tasks() -- the daily stale-task flagger
--
-- Same semantics as apps/api/src/services/stale.ts: a `todo` or
-- `in_progress` task whose `last_activity_at` is older than
-- `ops.settings.stale_after_days` is stale, and its owner is notified
-- through the outbox.
--
-- IDEMPOTENT PER TASK PER DAY, AND STILL WITHOUT A NEW COLUMN. The
-- obvious design is a `last_stale_notified_at` column on ops.tasks. The
-- TypeScript could not add one (its lane did not own supabase/) and
-- instead checked core.notification_outbox itself for an
-- `ops.task.stale` row enqueued for that task since midnight UTC. That
-- property is preserved here verbatim rather than "fixed" now that a
-- migration is available -- adding the column would change the meaning
-- of the two behaviours the route's callers already rely on
-- (`already_notified_today` counts outbox rows, not column stamps), and
-- the outbox check costs one indexed scan a day.
--
-- Midnight is UTC, not Manila, exactly as the TypeScript had it. The
-- job fires at 08:00 Manila = 00:00 UTC, so the day boundary lands
-- immediately before the run either way; making it Manila-local here
-- would be a silent behaviour change for the HTTP route.
-- ---------------------------------------------------------------------
create or replace function ops.flag_stale_tasks()
returns table (considered int, flagged int, already_notified_today int)
language plpgsql
security definer
set search_path = ops, core, public, pg_temp
as $$
declare
  v_stale_after_days int;
  v_cutoff timestamptz;
  v_today_start timestamptz;
  v_considered int := 0;
  v_flagged int := 0;
  v_already int := 0;
  v_task record;
  v_days int;
begin
  if not core.is_system_caller() then
    raise exception 'only the system may flag stale tasks' using errcode = '42501';
  end if;

  select s.stale_after_days into v_stale_after_days from ops.settings s where s.id;
  v_stale_after_days := coalesce(v_stale_after_days, 3);

  v_cutoff := now() - make_interval(days => v_stale_after_days);
  v_today_start := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';

  -- The candidate predicate is spelled out three times below rather
  -- than materialised into a temp table. now() is fixed for the
  -- transaction, so v_cutoff is fixed, so all three see exactly the same
  -- set -- and a `security definer` function that creates temp tables
  -- carries its own problems for no gain at this row count.
  select count(*) into v_considered
  from ops.tasks t
  where t.status in ('todo', 'in_progress')
    and t.last_activity_at < v_cutoff;

  if v_considered = 0 then
    return query select 0, 0, 0;
    return;
  end if;

  select count(distinct o.entity_id) into v_already
  from core.notification_outbox o
  where o.event_type = 'ops.task.stale'
    and o.created_at >= v_today_start
    and o.entity_id in (
      select t.id from ops.tasks t
      where t.status in ('todo', 'in_progress')
        and t.last_activity_at < v_cutoff
    );

  for v_task in
    select t.id, t.title, t.owner_user_id, t.last_activity_at
    from ops.tasks t
    where t.status in ('todo', 'in_progress')
      and t.last_activity_at < v_cutoff
      and not exists (
        select 1 from core.notification_outbox o
        where o.event_type = 'ops.task.stale'
          and o.created_at >= v_today_start
          and o.entity_id = t.id
      )
  loop
    v_days := floor(extract(epoch from (now() - v_task.last_activity_at)) / 86400)::int;

    insert into core.notification_outbox
      (recipient_id, module, event_type, entity_type, entity_id, title, body, link, payload)
    values
      (v_task.owner_user_id, 'ops', 'ops.task.stale', 'ops.task', v_task.id,
       'Task has gone stale',
       format('"%s" has had no movement in %s day%s.',
              v_task.title, v_days, case when v_days = 1 then '' else 's' end),
       '/board', '{}'::jsonb);

    v_flagged := v_flagged + 1;
  end loop;

  return query select v_considered, v_flagged, v_already;
end;
$$;

-- ---------------------------------------------------------------------
-- ops.ensure_current_week() -- the Monday wrapper
--
-- `ops.roll_over_week(uuid)` takes a week id. Cron has none, so this
-- resolves the current week itself from ops.settings.timezone (the
-- company runs on Asia/Manila) and does two things, both no-ops when
-- there is nothing to do:
--
--   1. Create this week's row if it does not exist. Weeks are keyed by
--      a unique `week_start`, so ON CONFLICT DO NOTHING makes a second
--      run add nothing. The week is created in `planning`; nothing here
--      opens or closes a briefing.
--   2. Roll the PREVIOUS week over, but only if a previous week row
--      exists AND its `rolled_over_at` is still null. This is a safety
--      net behind `lra-close-week`, which already rolls over as part of
--      closing. `ops.roll_over_week` is independently idempotent via
--      that same column, so even if both fire the second is a no-op.
--
-- Never acts twice on the same week, and returns a row saying what it
-- did rather than raising when the answer is "nothing".
-- ---------------------------------------------------------------------
create or replace function ops.ensure_current_week()
returns table (week_id uuid, week_created boolean, carried_count int)
language plpgsql
security definer
set search_path = ops, core, public, pg_temp
as $$
declare
  v_tz text;
  v_this_monday date;
  v_week_id uuid;
  v_created boolean := false;
  v_prev ops.weeks%rowtype;
  v_carried int := 0;
  v_rollover record;
begin
  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may open the week' using errcode = '42501';
  end if;

  select coalesce(s.timezone, 'Asia/Manila') into v_tz from ops.settings s where s.id;
  v_tz := coalesce(v_tz, 'Asia/Manila');

  v_this_monday := (date_trunc('week', now() at time zone v_tz))::date;

  select w.id into v_week_id from ops.weeks w where w.week_start = v_this_monday;
  if v_week_id is null then
    insert into ops.weeks (week_start) values (v_this_monday)
    on conflict (week_start) do nothing;
    select w.id into v_week_id from ops.weeks w where w.week_start = v_this_monday;
    v_created := true;
  end if;

  select * into v_prev from ops.weeks w where w.week_start = v_this_monday - 7;
  if v_prev.id is not null and v_prev.rolled_over_at is null then
    select * into v_rollover from ops.roll_over_week(v_prev.id);
    v_carried := coalesce(v_rollover.carried_count, 0);
  end if;

  return query select v_week_id, v_created, v_carried;
end;
$$;

-- ---------------------------------------------------------------------
-- ops.close_current_week() -- the Sunday-night wrapper
--
-- Resolves the week that is ending tonight (the Monday of the current
-- Manila week) and closes it through the existing `ops.close_week`.
--
-- THREE REFUSALS, all silent no-ops rather than errors, because this
-- writes the locked Monday record and an unattended job must never be
-- the thing that guesses:
--
--   * No week row for this week      -> nothing to close.
--   * The week is already `closed`   -> already done; does not call
--     `ops.close_week` a second time (which would be harmless, both
--     halves being idempotent, but there is no reason to touch it).
--   * The week is still in `planning` -> the briefing never happened.
--     Closing it would jump planning -> closed and lock a set of
--     commitments nobody ever committed to. A person has to deal with
--     that; the schedule leaves it alone and says so in `action`.
--
-- `closed_by` will be null on a cron close -- see the header.
-- ---------------------------------------------------------------------
create or replace function ops.close_current_week()
returns table (week_id uuid, action text, carried_count int)
language plpgsql
security definer
set search_path = ops, core, public, pg_temp
as $$
declare
  v_tz text;
  v_this_monday date;
  v_week ops.weeks%rowtype;
  v_result record;
begin
  if not (core.is_system_caller() or core.is_oversight()) then
    raise exception 'only oversight may close the week' using errcode = '42501';
  end if;

  select coalesce(s.timezone, 'Asia/Manila') into v_tz from ops.settings s where s.id;
  v_tz := coalesce(v_tz, 'Asia/Manila');

  v_this_monday := (date_trunc('week', now() at time zone v_tz))::date;

  select * into v_week from ops.weeks w where w.week_start = v_this_monday;

  if v_week.id is null then
    return query select null::uuid, 'no_week'::text, 0;
    return;
  end if;

  if v_week.state = 'closed' then
    return query select v_week.id, 'already_closed'::text, 0;
    return;
  end if;

  if v_week.state = 'planning' then
    return query select v_week.id, 'skipped_briefing_never_held'::text, 0;
    return;
  end if;

  select * into v_result from ops.close_week(v_week.id);
  return query select v_week.id, 'closed'::text, coalesce(v_result.carried_count, 0);
end;
$$;

-- ---------------------------------------------------------------------
-- Keep all four off the public RPC surface (same reasoning as
-- 20260909170000: Postgres grants EXECUTE to PUBLIC by default, which
-- would make each of these reachable as /rest/v1/rpc/<name> to `anon`).
-- These are system jobs. `service_role` keeps execute because the two
-- /api/jobs routes call the first two through serviceClient().rpc();
-- `authenticated` gets nothing, unlike the week routines, because no
-- signed-in user calls a wrapper that picks its own week.
-- ---------------------------------------------------------------------
revoke execute on function core.drain_notification_outbox(int) from public, anon, authenticated;
revoke execute on function ops.flag_stale_tasks()               from public, anon, authenticated;
revoke execute on function ops.ensure_current_week()            from public, anon, authenticated;
revoke execute on function ops.close_current_week()             from public, anon, authenticated;

grant execute on function core.drain_notification_outbox(int) to service_role;
grant execute on function ops.flag_stale_tasks()               to service_role;
grant execute on function ops.ensure_current_week()            to service_role;
grant execute on function ops.close_current_week()             to service_role;

-- =====================================================================
-- The schedules.
--
-- MANILA -> UTC. Asia/Manila is UTC+8 and has observed no DST since
-- 1978, so the offset is a constant: UTC = Manila - 8h. pg_cron
-- schedules are always UTC (`cron.timezone` is not settable on Supabase).
--
--   drain-outbox   every minute        -> * * * * *   (no offset to apply)
--   flag-stale     08:00 Mon-Sun Manila
--                    08:00 - 8h = 00:00 UTC, same day  -> 0 0 * * *
--   open-week      Mon 06:00 Manila
--                    06:00 - 8h = 22:00 UTC, previous day
--                    Monday - 1 day = Sunday (cron dow 0)  -> 0 22 * * 0
--   close-week     Sun 23:59 Manila
--                    23:59 - 8h = 15:59 UTC, same day
--                    Sunday stays Sunday (dow 0)           -> 59 15 * * 0
--
-- Both weekly jobs land on cron dow 0. The order is right: close-week
-- runs at 15:59 UTC Sunday, open-week at 22:00 UTC Sunday six hours
-- later -- the week is closed and rolled over before the next one is
-- created, which is also why open-week's own rollover is only a net.
--
-- `cron.schedule` upserts on job name, so this file is re-runnable on
-- its own. The explicit unschedule below is belt and braces: it also
-- clears a job that was renamed or duplicated by hand, and it makes the
-- migration safe to re-run on a database where the names were reused
-- for different commands.
-- =====================================================================

do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'lra-drain-outbox', 'lra-flag-stale', 'lra-open-week', 'lra-close-week'
  ] loop
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = v_name;
  end loop;
end;
$$;

select cron.schedule(
  'lra-drain-outbox',
  '* * * * *',
  $job$select core.drain_notification_outbox();$job$
);

select cron.schedule(
  'lra-flag-stale',
  '0 0 * * *',
  $job$select ops.flag_stale_tasks();$job$
);

select cron.schedule(
  'lra-open-week',
  '0 22 * * 0',
  $job$select ops.ensure_current_week();$job$
);

-- DELIBERATELY NOT SCHEDULED: lra-close-week.
--
-- Chan's decision, 2026-09-10, asked directly because scheduling it
-- contradicted a decision this project had already made in writing.
-- Migration 20260910130000 and OPEN-QUESTIONS #7 both argue that closing
-- a week must belong to a person: it is irreversible, there is no reopen
-- path, and a week that closes itself while somebody is still working
-- mid-week cannot be undone. An unattended irreversible write is a
-- different risk from an unattended idempotent one, which is why the
-- other three jobs are here and this one is not.
--
-- `ops.close_current_week()` IS created above and is correct -- it
-- refuses a week still in `planning` and refuses to re-close. It is left
-- callable so the close can be automated later by scheduling it, or
-- driven from a script, without another migration. Only the schedule is
-- withheld.
--
--   select cron.schedule('lra-close-week', '59 15 * * 0',
--     $job$select ops.close_current_week();$job$);
