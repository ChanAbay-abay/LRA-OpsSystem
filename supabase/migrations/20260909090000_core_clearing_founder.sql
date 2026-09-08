-- =====================================================================
-- LRA Ops :: core — the clearing founder capability
--
-- Chan's ask tonight: "give it to me as an admin account... GM/Sales/
-- Broker should be a role with their own access roles... exactly one
-- clearing founder (whoever runs the briefing)."
--
-- `core.authority = 'founder'` already allows *multiple* rows (Chan's
-- father and his two eldest brothers, PLAN.md §0.4) -- that is rank, not
-- a seat. The thing that must stay singular is *which* founder is the
-- one whose approval actually clears points, because the task state
-- machine's `verified -> cleared` rung is a control, and a control two
-- people can both satisfy is not a control (PLAN.md §2.5 item 6 makes
-- exactly this argument for GM self-verification).
--
-- Modelled as a capability flag on `core.users`, not a hardcoded user
-- id, so a second founder can be promoted to clearing founder later with
-- a single UPDATE -- no migration, no code change. A partial unique
-- index is the actual "exactly one" guarantee; the database enforces it,
-- not application code remembering to unset the old one.
-- =====================================================================

alter table core.users
  add column is_clearing_founder boolean not null default false;

-- At most one true value across the whole table. A second admin trying
-- to flip a second row raises a unique-violation, not a silent overwrite.
create unique index uq_core_users_one_clearing_founder
  on core.users (is_clearing_founder)
  where is_clearing_founder;

-- Extend the Phase 1 privilege guard (create or replace, not an edit of
-- the applied migration) so `is_clearing_founder` joins `authority` /
-- `person_id` / `is_active` as admin-only. Letting a non-admin flip
-- their own flag would let them promote themselves to the one seat that
-- can clear the whole company's points.
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
     or new.is_active is distinct from old.is_active
     or new.is_clearing_founder is distinct from old.is_clearing_founder then
    raise exception
      'authority, person_id, is_active and is_clearing_founder may only be changed by an admin'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create or replace function core.is_clearing_founder()
returns boolean
language sql
stable
security definer
set search_path = core, public
as $$
  select coalesce(
    (select u.is_clearing_founder from core.users u where u.id = core.auth_user_id()),
    false
  );
$$;

comment on column core.users.is_clearing_founder is
  'Exactly one true row (partial unique index). The founder who runs the '
  'Monday briefing and whose approval actually clears points. Any '
  'authority=founder account can be promoted to this seat with one '
  'UPDATE by an admin -- no migration needed to add a second founder or '
  'to hand the seat to a different one.';
