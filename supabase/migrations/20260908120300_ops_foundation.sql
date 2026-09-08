-- =====================================================================
-- LRA Ops :: ops — settings and weeks
--
-- The only module built now (PLAN.md §0.2). This migration lays the
-- foundation Phase 1 needs -- settings and the week calendar -- so the
-- API and web scaffold have something real to read. Catalog, tasks, the
-- state machine and the ledger are Phase 3/4 migrations; nothing here
-- pre-builds them.
-- =====================================================================

create schema ops;
grant usage on schema ops to anon, authenticated, service_role;
comment on schema ops is
  'The Ops module: weeks, task catalog, tasks, points ledger, blockers, scores. '
  'hr and crm are designed for, not created -- see PRD.md §0.3.';

create type ops.week_state as enum ('planning', 'open', 'closed');

create table ops.settings (
  id boolean primary key default true check (id),
  recurring_cap_pct           numeric(4,3) not null default 0.400
    check (recurring_cap_pct >= 0 and recurring_cap_pct < 1),
  recurring_floor_points      int not null default 3 check (recurring_floor_points >= 0),
  stale_after_days            int not null default 3 check (stale_after_days >= 1),
  reliability_window_weeks    int not null default 8,
  reliability_half_life_weeks numeric(4,2) not null default 3.0,
  min_weeks_for_rating        int not null default 3,
  leaderboard_visibility      text not null default 'all'
    check (leaderboard_visibility in ('all', 'oversight_only')),
  timezone   text not null default 'Asia/Manila',
  updated_by uuid references core.users(id),
  updated_at timestamptz not null default now()
);

-- Exactly one settings row. Seeded here, in the same migration, so the
-- table is never queried empty.
insert into ops.settings (id) values (true);

create trigger trg_ops_settings_updated_at
  before update on ops.settings
  for each row execute function core.set_updated_at();

-- Manila, always. Never UTC, never the browser's clock. A UTC-naive
-- implementation is wrong for 8 hours in every 24 -- Manila midnight is
-- 16:00 UTC the previous day.
create or replace function ops.week_start_for(p_ts timestamptz default now())
returns date
language sql
immutable
as $$
  select (date_trunc('week', (p_ts at time zone 'Asia/Manila')))::date;
$$;   -- date_trunc('week') is ISO: Monday.

create table ops.weeks (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique check (extract(isodow from week_start) = 1),
  week_end   date generated always as (week_start + 6) stored,
  state      ops.week_state not null default 'planning',
  briefing_opened_at timestamptz,
  briefing_closed_at timestamptz,
  briefing_closed_by uuid references core.users(id),
  closed_at timestamptz,
  closed_by uuid references core.users(id),
  rolled_over_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_ops_weeks_updated_at
  before update on ops.weeks
  for each row execute function core.set_updated_at();
