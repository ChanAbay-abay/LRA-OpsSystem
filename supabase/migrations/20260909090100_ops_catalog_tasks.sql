-- =====================================================================
-- LRA Ops :: ops — task catalog, tasks, and blocks (Phase 3 tables)
--
-- PLAN.md §2.4/§2.6, PRD.md §3.2-3.3, §3.8. State-machine triggers land
-- in the next migration (ops_task_state_machine.sql) -- INSERT and
-- UPDATE guards ship together there, deliberately, because shipping them
-- a migration apart is exactly the gap HR's history says gets exploited.
--
-- Point values are NOT seeded here or anywhere in this phase.
-- `default_points` is nullable on purpose: a DRAFT catalog entry has no
-- price yet, and ranking the value of LRA's own work is the founder's
-- judgement, not a guess an agent launders into company policy
-- (OPEN-QUESTIONS.md #3). Every non-null value is still Fibonacci-only.
-- =====================================================================

create type ops.task_status as enum
  ('todo', 'in_progress', 'submitted', 'verified', 'cleared', 'rejected', 'cancelled');

-- 'external' matters in this trade: BOC, carriers and clients block work
-- constantly, and that time must be measured even though nobody here can
-- chase it (PRD.md §3.8).
create type ops.block_target as enum ('task', 'person', 'external');

-- ---------------------------------------------------------------------
-- ops.task_types — the catalog. A mandatory guideline note; a nullable,
-- Fibonacci-only point value.
-- ---------------------------------------------------------------------
create table ops.task_types (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  category       text not null,
  guideline_note text not null check (length(trim(guideline_note)) > 0),
  default_points int check (default_points is null or default_points in (1, 2, 3, 5, 8, 13, 21)),
  is_recurring   boolean not null default false,
  is_active      boolean not null default true,
  created_by     uuid references core.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index uq_ops_task_types_name on ops.task_types (lower(name)) where is_active;

-- Append-only history of every catalog edit -- the founder re-pricing a
-- type must never be invisible, and it must never move last month's
-- scores (tasks snapshot `catalog_points` at creation, below).
create table ops.task_type_revisions (
  id             uuid primary key default gen_random_uuid(),
  task_type_id   uuid not null references ops.task_types(id) on delete cascade,
  name           text not null,
  category       text not null,
  guideline_note text not null,
  default_points int,
  changed_by     uuid references core.users(id),
  changed_at     timestamptz not null default now()
);
create index idx_ops_task_type_revisions_type
  on ops.task_type_revisions (task_type_id, changed_at desc);

-- ---------------------------------------------------------------------
-- ops.recurring_templates — keyed on core.position, NOT a user. Adding a
-- position later (`alter type core.position add value 'x'`) is a
-- one-value enum change plus template rows; this table needs no
-- migration and no code change to pick it up, because generation reads
-- the enum's live member list from core.memberships, not a hardcoded
-- switch (see ops.generate_recurring_tasks in the Phase 5 migration).
-- ---------------------------------------------------------------------
create table ops.recurring_templates (
  id           uuid primary key default gen_random_uuid(),
  position     core.position not null,
  task_type_id uuid not null references ops.task_types(id),
  title        text not null,
  description  text,
  is_active    boolean not null default true,
  created_by   uuid references core.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index idx_ops_recurring_templates_position
  on ops.recurring_templates (position) where is_active;

-- ---------------------------------------------------------------------
-- ops.tasks — the working object. `catalog_points` is snapshotted at
-- creation; `points_awarded` is written by the trigger at `cleared`
-- only, never accepted from the client (PLAN.md §2.4).
-- ---------------------------------------------------------------------
create table ops.tasks (
  id            uuid primary key default gen_random_uuid(),
  week_id       uuid not null references ops.weeks(id),
  owner_user_id uuid not null references core.users(id),
  task_type_id  uuid references ops.task_types(id),

  title         text not null check (length(trim(title)) > 0),
  description   text,
  client_ref    text,

  status        ops.task_status not null default 'todo',

  -- Points -- catalog_points is a server-set snapshot, never client input.
  catalog_points          int,
  points_override         int check (points_override is null or points_override in (1, 2, 3, 5, 8, 13, 21)),
  points_override_reason  text,
  points_awarded          int,

  -- Stamp columns. Only the trigger may set these (ops_task_state_machine.sql).
  gm_id           uuid references core.users(id),
  gm_acted_at     timestamptz,
  founder_id      uuid references core.users(id),
  founder_acted_at timestamptz,
  cleared_at      timestamptz,
  rejected_reason text,

  -- Recurring provenance.
  is_recurring          boolean not null default false,
  recurring_template_id uuid references ops.recurring_templates(id),

  -- Commitments -- columns exist now (the state-machine and board need
  -- them), but the lock trigger and the briefing flow that populate them
  -- for real are Phase 6, deliberately not built yet (blocked on the
  -- founder pricing the catalog).
  is_committed      boolean not null default false,
  committed_week_id uuid references ops.weeks(id),
  committed_points  int,

  -- Carry-over.
  first_week_id     uuid references ops.weeks(id),
  carry_over_count  int not null default 0,

  last_activity_at timestamptz not null default now(),
  created_by  uuid not null references core.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_ops_tasks_week on ops.tasks (week_id);
create index idx_ops_tasks_owner on ops.tasks (owner_user_id, week_id);
create index idx_ops_tasks_status on ops.tasks (status);
create index idx_ops_tasks_first_week on ops.tasks (first_week_id);

-- Recurring generation must be idempotent -- one row per (owner, week,
-- template), enforced here so a retried generation call cannot double a
-- person's recurring load (the `apply_loan_deductions()` lesson).
create unique index uq_ops_tasks_recurring
  on ops.tasks (owner_user_id, week_id, recurring_template_id)
  where recurring_template_id is not null;

create trigger trg_ops_task_types_updated_at
  before update on ops.task_types
  for each row execute function core.set_updated_at();
create trigger trg_ops_recurring_templates_updated_at
  before update on ops.recurring_templates
  for each row execute function core.set_updated_at();
create trigger trg_ops_tasks_updated_at
  before update on ops.tasks
  for each row execute function core.set_updated_at();

-- ---------------------------------------------------------------------
-- ops.task_blocks — "blocked" is derived, never a task status
-- (PRD.md §3.2). Exactly one of the three target columns is populated,
-- enforced by CHECK, plus a non-trivial reason. The cycle guard
-- (task -> task edges) ships with the state-machine migration since it
-- is a BEFORE INSERT trigger of the same family.
-- ---------------------------------------------------------------------
create table ops.task_blocks (
  id                  uuid primary key default gen_random_uuid(),
  task_id             uuid not null references ops.tasks(id) on delete cascade,
  target              ops.block_target not null,
  blocking_task_id    uuid references ops.tasks(id),
  blocking_user_id    uuid references core.users(id),
  blocking_external   text,
  reason              text not null check (length(trim(reason)) > 0),
  created_by          uuid not null references core.users(id),
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by         uuid references core.users(id),

  constraint chk_ops_task_blocks_one_target check (
    (target = 'task'     and blocking_task_id is not null and blocking_user_id is null and blocking_external is null) or
    (target = 'person'   and blocking_user_id is not null and blocking_task_id is null and blocking_external is null) or
    (target = 'external' and blocking_external is not null and length(trim(blocking_external)) > 0
       and blocking_task_id is null and blocking_user_id is null)
  )
);
create index idx_ops_task_blocks_task on ops.task_blocks (task_id) where resolved_at is null;
create index idx_ops_task_blocks_open on ops.task_blocks (resolved_at) where resolved_at is null;
