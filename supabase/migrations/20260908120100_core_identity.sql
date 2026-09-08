-- =====================================================================
-- LRA Ops :: core — identity, authority, membership
--
-- Two ideas kept deliberately separate (PLAN.md §0.4 / PRD.md §2), because
-- conflating them is exactly what produced HR's "a manager can forge
-- hr_id" class of defect:
--
--   core.authority   -- company rank. staff / gm / founder / admin.
--                        Rarely changes. Multiple people can hold
--                        `founder` (Chan's father, and later his
--                        brothers), each their own row -- so authority
--                        lives on a plain column, not a hardcoded id.
--   core.memberships -- module participation + position. Additive.
--                        NOT an authority level. This is the seam that
--                        lets HR and CRM slot in later as `insert`, not
--                        `alter table`.
-- =====================================================================

create schema core;
grant usage on schema core to anon, authenticated, service_role;
comment on schema core is
  'Identity, authority, membership, notifications and audit history. '
  'The foundation HR and CRM will sit on. Owned by LRA-OpsSystem.';

create type core.authority as enum ('staff', 'gm', 'founder', 'admin');
create type core.module    as enum ('ops', 'hr', 'crm');
create type core.position  as enum
  ('founder', 'gm', 'sales', 'broker', 'hr_officer', 'accounting', 'other');

-- ---------------------------------------------------------------------
-- core.people — a human. May exist without a login (a new hire, someone
-- who has left). Deliberately thin: no salary, no government IDs, no
-- manager relation. Those are HR-module data and arrive as additive
-- columns in `hr` when HR is built (PLAN.md §0.3).
-- ---------------------------------------------------------------------
create table core.people (
  id           uuid primary key default gen_random_uuid(),
  person_code  text unique not null,          -- 'LRA-001'
  first_name   text not null,
  last_name    text not null,
  display_name text,                          -- short label for the board
  email        text unique not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- core.users — a login. Mirrors auth.users. Authority is a plain column
-- so three founders can each hold their own account with no schema
-- change.
-- ---------------------------------------------------------------------
create table core.users (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text unique not null,
  authority  core.authority not null default 'staff',
  person_id  uuid unique references core.people(id) on delete set null,
  is_active  boolean not null default true,
  last_login timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_core_users_authority on core.users(authority) where is_active;

-- ---------------------------------------------------------------------
-- core.memberships — participation in a module, in a position. NOT an
-- authority level. Position drives recurring-task templates and
-- scoreboard grouping.
-- ---------------------------------------------------------------------
create table core.memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references core.users(id) on delete cascade,
  module     core.module not null,
  position   core.position not null default 'other',
  is_active  boolean not null default true,
  joined_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, module)
);
create index idx_core_memberships_module on core.memberships(module, position)
  where is_active;

-- ---------------------------------------------------------------------
-- Helper functions — the single source of authority. Modules call
-- these; modules never re-derive authority from a JWT. All
-- `security definer` so they can read core.users/core.memberships
-- regardless of the caller's own row-level visibility, and all
-- `set search_path` to close the classic search-path injection hole
-- that a SECURITY DEFINER function opens.
-- ---------------------------------------------------------------------

create or replace function core.auth_user_id()
returns uuid
language sql
stable
as $$
  select auth.uid();
$$;

-- Copied verbatim from LRA-HR migration 009, including the fix: absent
-- claims mean a direct connection (migration, psql, cron) and are
-- privileged; claims that EXIST but carry no `role` key are not. HR
-- shipped the naive version -- treating an empty role as privileged --
-- and one such token voided every guard in two migrations at once.
create or replace function core.is_system_caller()
returns boolean
language sql
stable
as $$
  select case
    -- No claims at all: a direct connection (migration, psql, cron).
    when nullif(current_setting('request.jwt.claims', true), '') is null
      then true
    -- Claims present: they must actually say service_role.
    else coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role',
      ''
    ) = 'service_role'
  end;
$$;

create or replace function core.authority()
returns core.authority
language sql
stable
security definer
set search_path = core, public
as $$
  select u.authority from core.users u where u.id = core.auth_user_id();
$$;

create or replace function core.is_admin()
returns boolean
language sql
stable
security definer
set search_path = core, public
as $$
  select coalesce(core.authority() = 'admin', false);
$$;

create or replace function core.is_founder()
returns boolean
language sql
stable
security definer
set search_path = core, public
as $$
  select coalesce(core.authority() in ('founder', 'admin'), false);
$$;

create or replace function core.is_gm()
returns boolean
language sql
stable
security definer
set search_path = core, public
as $$
  select coalesce(core.authority() in ('gm', 'admin'), false);
$$;

create or replace function core.is_oversight()
returns boolean
language sql
stable
security definer
set search_path = core, public
as $$
  select coalesce(core.authority() in ('gm', 'founder', 'admin'), false);
$$;

-- Admin counts as a member of every module for support purposes, same as
-- HR's COMPANY_WIDE_ROLES precedent -- but every other module capability
-- comes from an actual row, never an inference.
create or replace function core.is_member(p_module core.module)
returns boolean
language sql
stable
security definer
set search_path = core, public
as $$
  select core.is_admin() or exists (
    select 1 from core.memberships m
    where m.user_id = core.auth_user_id()
      and m.module = p_module
      and m.is_active
  );
$$;

-- ---------------------------------------------------------------------
-- Privilege-column guard on core.users. HR's migration 005 lesson,
-- written correctly the first time this round: only an admin may change
-- authority, person_id or is_active. Everything else (email sync,
-- last_login) is left open to the row owner and the system client.
-- ---------------------------------------------------------------------
create or replace function core.guard_user_privilege_columns()
returns trigger
language plpgsql
security definer
set search_path = core, public
as $$
begin
  if core.is_system_caller() or core.is_admin() then
    return new;
  end if;

  if new.authority is distinct from old.authority
     or new.person_id is distinct from old.person_id
     or new.is_active is distinct from old.is_active then
    raise exception 'authority, person_id and is_active may only be changed by an admin'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger trg_guard_user_privilege_columns
  before update on core.users
  for each row execute function core.guard_user_privilege_columns();

-- updated_at maintenance, generic enough to reuse across schemas.
create or replace function core.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_core_people_updated_at
  before update on core.people
  for each row execute function core.set_updated_at();

create trigger trg_core_users_updated_at
  before update on core.users
  for each row execute function core.set_updated_at();

create trigger trg_core_memberships_updated_at
  before update on core.memberships
  for each row execute function core.set_updated_at();
