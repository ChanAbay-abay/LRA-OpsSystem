-- =====================================================================
-- LRA Ops :: soft-delete + 14-day purge for core.users
--
-- Chan: "admin should also be able to delete the accounts when needed
-- and the accounts will have 2 weeks before being deleted permanently."
--
-- Soft delete is immediate and reversible for 14 days: `deleted_at` /
-- `deleted_by` / `purge_due_at` are stamped, `is_active` is forced
-- false (which the existing `authenticate()` middleware already refuses
-- to log in), and the account is fully restorable with its tasks,
-- points and history untouched. Permanent purge, at 14 days, does NOT
-- cascade-delete that work: `ops.point_ledger` is append-only and
-- `core.audit_logs` already refuses UPDATE/DELETE outright, so the
-- accountability record this system exists to keep must survive.
-- Instead purge deletes only the `auth.users` login and scrubs the
-- identifying fields on `core.people` to a tombstone -- `core.users`
-- and every task/ledger/audit row keep pointing at the same id,
-- correctly attributed, forever.
--
-- That last part requires one structural change: `core.users.id`
-- currently has `references auth.users(id) on delete cascade`, so
-- deleting the auth login would delete the core.users row (and, via
-- foreign keys through ops.tasks/ops.point_ledger, drag the person's
-- entire history down with it). The FK is dropped below -- deliberately
-- and permanently -- because there is no FK action that means "delete
-- the parent, keep the child": CASCADE takes the child with it, NO
-- ACTION/RESTRICT refuses the delete outright. Referential integrity
-- between `core.users` and `auth.users` is enforced by the invite flow
-- and this migration's guards from here on, not by the constraint.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Drop the FK that would otherwise cascade-delete core.users (and
--    everything that references it) the moment an auth login is
--    purged. Found by introspection rather than hardcoding a
--    constraint name, since Postgres's default naming is not
--    guaranteed across environments.
-- ---------------------------------------------------------------------
do $$
declare
  v_conname text;
begin
  select c.conname into v_conname
  from pg_constraint c
  where c.conrelid = 'core.users'::regclass
    and c.contype = 'f'
    and c.confrelid = 'auth.users'::regclass;

  if v_conname is not null then
    execute format('alter table core.users drop constraint %I', v_conname);
  end if;
end $$;

comment on column core.users.id is
  'Same id as the auth.users row this account was provisioned from. '
  'Deliberately NOT foreign-keyed to auth.users (see 20260910090000): '
  'core.purge_due_accounts() deletes the auth.users login while keeping '
  'this row, and every task/ledger/audit row it owns, intact.';

-- ---------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------
alter table core.users
  add column deleted_at   timestamptz,
  add column deleted_by   uuid references core.users(id),
  add column purge_due_at timestamptz;

comment on column core.users.deleted_at is
  'Soft delete, set by an admin. Access ends immediately (is_active is '
  'forced false in the same transition); the account is restorable '
  'until purge_due_at.';
comment on column core.users.purge_due_at is
  'deleted_at + 14 days, computed server-side by the guard trigger -- '
  'never accepted from a client. core.purge_due_accounts() only touches '
  'rows where this has actually passed.';

create index idx_core_users_purge_due on core.users(purge_due_at)
  where deleted_at is not null;

-- ---------------------------------------------------------------------
-- 2. core.caller_is_active() -- the caller (not the target row) has a
--    core.users row that is active and not soft-deleted. Used to close
--    the gap the self-referencing policies below would otherwise leave
--    open: `id = core.auth_user_id()` is true for a soft-deleted user's
--    own row forever, no matter what their authority/membership is.
-- ---------------------------------------------------------------------
create or replace function core.caller_is_active()
returns boolean
language sql
stable
security definer
set search_path = core, public
as $$
  select coalesce(
    (select u.is_active and u.deleted_at is null
     from core.users u where u.id = core.auth_user_id()),
    false
  );
$$;

-- ---------------------------------------------------------------------
-- 3. Close the gap at its root: `core.authority()` and `core.is_member()`
--    are the single source every oversight/admin/membership check in
--    the whole system reads from (PLAN.md §0.4). Making a soft-deleted
--    or deactivated caller's authority resolve to NULL, and their
--    membership resolve to false, means `is_admin()`, `is_founder()`,
--    `is_gm()` and `is_oversight()` all correctly go false in the same
--    stroke -- no per-policy patch needed for anything gated by those.
-- ---------------------------------------------------------------------
create or replace function core.authority()
returns core.authority
language sql
stable
security definer
set search_path = core, public
as $$
  select u.authority
  from core.users u
  where u.id = core.auth_user_id()
    and u.is_active
    and u.deleted_at is null;
$$;

create or replace function core.is_member(p_module core.module)
returns boolean
language sql
stable
security definer
set search_path = core, public
as $$
  select core.is_admin() or exists (
    select 1 from core.memberships m
    join core.users u on u.id = m.user_id
    where m.user_id = core.auth_user_id()
      and m.module = p_module
      and m.is_active
      and u.is_active
      and u.deleted_at is null
  );
$$;

-- ---------------------------------------------------------------------
-- 4. Extend the privilege-column guard (core_identity.sql, extended
--    once already by core_clearing_founder.sql) so a non-admin cannot
--    touch deleted_at/deleted_by/purge_due_at either -- otherwise a
--    self-update could restore or backdate their own deletion.
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
     or new.is_active is distinct from old.is_active
     or new.is_clearing_founder is distinct from old.is_clearing_founder
     or new.deleted_at is distinct from old.deleted_at
     or new.deleted_by is distinct from old.deleted_by
     or new.purge_due_at is distinct from old.purge_due_at then
    raise exception
      'authority, person_id, is_active, is_clearing_founder and deletion '
      'fields may only be changed by an admin'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Account-deletion invariants. Deliberately NOT bypassed by
--    `core.is_system_caller()` the way the privilege-column guard is:
--    these are structural invariants ("an admin never deletes
--    themselves", "the company is never left with zero active admins")
--    that must hold no matter which role is doing the writing,
--    including the API's own service-role client. A guard that only
--    a hijacked user JWT has to respect, and the app's own service key
--    can quietly bypass, is not a guard.
--
--    Also normalises the timestamps server-side on every transition so
--    a client can never backdate a deletion to shorten (or extend) the
--    14-day grace period, and never revive privilege fields via the
--    same UPDATE that restores an account.
-- ---------------------------------------------------------------------
create or replace function core.guard_account_deletion_invariants()
returns trigger
language plpgsql
security definer
set search_path = core, public
as $$
declare
  v_other_active_admins int;
begin
  -- A fresh soft-delete: old.deleted_at is null, new.deleted_at is not.
  if old.deleted_at is null and new.deleted_at is not null then

    -- An admin cannot delete their own account. Checked two ways so
    -- neither the API's own service-role write (which sets deleted_by
    -- to the acting admin's id) nor a direct PostgREST attack (which
    -- controls its own JWT but not necessarily what it puts in
    -- deleted_by) can slip past it.
    if new.deleted_by = new.id
       or (not core.is_system_caller() and core.auth_user_id() = new.id) then
      raise exception 'an admin cannot delete their own account'
        using errcode = '42501';
    end if;

    -- The last remaining active admin cannot be deleted, by anyone,
    -- including the system caller. Counted excluding the row being
    -- deleted so this also fails correctly when it is the only admin.
    if old.authority = 'admin' and old.is_active then
      select count(*) into v_other_active_admins
      from core.users u
      where u.authority = 'admin'
        and u.is_active
        and u.deleted_at is null
        and u.id <> new.id;

      if v_other_active_admins = 0 then
        raise exception 'the last remaining active admin cannot be deleted'
          using errcode = '42501';
      end if;
    end if;

    -- Server-computed, always. A client's deleted_at/purge_due_at is
    -- never trusted -- see the column comments above.
    new.deleted_at   := now();
    new.purge_due_at := new.deleted_at + interval '14 days';
    new.is_active    := false;

  -- An explicit admin restore: deleted_at was set, now cleared.
  elsif old.deleted_at is not null and new.deleted_at is null then
    new.deleted_by   := null;
    new.purge_due_at := null;
    new.is_active    := true;

  -- Still deleted (no transition either way this update): a deleted
  -- account can never be granted authority, silently or otherwise --
  -- "cannot be re-activated except by an explicit admin restore" cuts
  -- both ways.
  elsif old.deleted_at is not null and new.deleted_at is not null then
    if new.authority is distinct from old.authority then
      raise exception 'a soft-deleted account cannot be granted authority'
        using errcode = '42501';
    end if;
    new.is_active := false;
  end if;

  return new;
end;
$$;

-- Runs before the privilege-column guard alphabetically
-- ("trg_guard_account_deletion..." < "trg_guard_user_privilege..."), so
-- the timestamps/is_active this trigger derives are what the privilege
-- guard compares against OLD -- irrelevant to that guard's own logic
-- (it only cares whether a *non-admin* attempted a change), but keeping
-- the derivation upstream of every other BEFORE trigger on this table
-- is the least surprising order.
create trigger trg_guard_account_deletion_invariants
  before update on core.users
  for each row execute function core.guard_account_deletion_invariants();

-- ---------------------------------------------------------------------
-- 6. RLS -- close the remaining self-referencing policies that do not
--    route through authority()/is_member() and would otherwise stay
--    open to a soft-deleted caller until their JWT expires.
-- ---------------------------------------------------------------------

-- core.people: self-branch required the caller's own core.users row to
-- exist and match; now also requires it to be active.
drop policy people_select on core.people;
create policy people_select on core.people for select to authenticated
using (
  core.is_oversight()
  or exists (
    select 1 from core.users u
    where u.id = core.auth_user_id()
      and u.person_id = core.people.id
      and u.is_active
      and u.deleted_at is null
  )
);

-- core.users: self-read/self-update both required `id = auth_user_id()`
-- alone, which stays true forever for a soft-deleted user's own row.
drop policy users_select on core.users;
create policy users_select on core.users for select to authenticated
using (
  (id = core.auth_user_id() and core.caller_is_active())
  or core.is_oversight()
);

drop policy users_update on core.users;
create policy users_update on core.users for update to authenticated
using ((id = core.auth_user_id() and core.caller_is_active()) or core.is_admin())
with check ((id = core.auth_user_id() and core.caller_is_active()) or core.is_admin());

-- core.memberships: "any active member reads" checked the caller's
-- membership row's own is_active flag, never the caller's core.users
-- row -- so a soft-deleted user with an untouched membership row could
-- still read the whole roster.
drop policy memberships_select on core.memberships;
create policy memberships_select on core.memberships for select to authenticated
using (
  core.is_admin()
  or (
    is_active
    and core.caller_is_active()
    and exists (
      select 1 from core.memberships caller
      where caller.user_id = core.auth_user_id() and caller.is_active
    )
  )
);

-- core.notifications: own inbox, gated on caller identity alone.
drop policy notifications_select on core.notifications;
create policy notifications_select on core.notifications for select to authenticated
using (user_id = core.auth_user_id() and core.caller_is_active());

drop policy notifications_update on core.notifications;
create policy notifications_update on core.notifications for update to authenticated
using (user_id = core.auth_user_id() and core.caller_is_active())
with check (user_id = core.auth_user_id() and core.caller_is_active());

drop policy notifications_delete on core.notifications;
create policy notifications_delete on core.notifications for delete to authenticated
using (user_id = core.auth_user_id() and core.caller_is_active());

-- core.audit_logs: a soft-deleted account should not be able to write
-- an audit row claiming its own (now inactive) identity either.
drop policy audit_insert on core.audit_logs;
create policy audit_insert on core.audit_logs for insert to authenticated
with check (actor_id = core.auth_user_id() and core.caller_is_active());

-- ops.tasks: owner-branch of insert/update/delete keyed on caller
-- identity alone, same gap.
drop policy tasks_insert on ops.tasks;
create policy tasks_insert on ops.tasks for insert to authenticated
with check ((owner_user_id = core.auth_user_id() and core.caller_is_active()) or core.is_oversight());

drop policy tasks_update on ops.tasks;
create policy tasks_update on ops.tasks for update to authenticated
using ((owner_user_id = core.auth_user_id() and core.caller_is_active()) or core.is_oversight())
with check ((owner_user_id = core.auth_user_id() and core.caller_is_active()) or core.is_oversight());

drop policy tasks_delete on ops.tasks;
create policy tasks_delete on ops.tasks for delete to authenticated
using (owner_user_id = core.auth_user_id() and core.caller_is_active() and status in ('todo', 'cancelled'));

-- ops.task_blocks: creator/blocking-user branches, same gap. Insert
-- already routes through is_member('ops'), which is_member()'s own fix
-- above already closes; only update's identity-only branches need it.
drop policy task_blocks_update on ops.task_blocks;
create policy task_blocks_update on ops.task_blocks for update to authenticated
using (
  (created_by = core.auth_user_id() and core.caller_is_active())
  or (blocking_user_id = core.auth_user_id() and core.caller_is_active())
  or core.is_oversight()
)
with check (
  (created_by = core.auth_user_id() and core.caller_is_active())
  or (blocking_user_id = core.auth_user_id() and core.caller_is_active())
  or core.is_oversight()
);

-- ---------------------------------------------------------------------
-- 7. core.purge_due_accounts() -- the permanent purge. security
--    definer so it can delete from auth.users and scrub core.people
--    regardless of the caller's own row-level visibility; re-checks
--    authorization itself per the standing rule that definer functions
--    must never trust RLS to have already gated the caller (HR lesson
--    #6). Idempotent: re-running only ever finds rows whose auth.users
--    login has not already been deleted, so a second run purges zero.
-- ---------------------------------------------------------------------
create or replace function core.purge_due_accounts()
returns int
language plpgsql
security definer
set search_path = core, public
as $$
declare
  v_purged int := 0;
  r record;
begin
  if not (core.is_admin() or core.is_system_caller()) then
    raise exception 'core.purge_due_accounts may only be run by an admin or the system'
      using errcode = '42501';
  end if;

  for r in
    select u.id, u.person_id
    from core.users u
    where u.deleted_at is not null
      and u.purge_due_at is not null
      and u.purge_due_at <= now()
      -- Already-purged rows have no matching auth.users login left;
      -- this alone makes a re-run a safe no-op without a separate
      -- "purged" flag.
      and exists (select 1 from auth.users a where a.id = u.id)
  loop
    if r.person_id is not null then
      update core.people
      set first_name   = 'Deleted',
          last_name     = 'person',
          display_name  = 'Deleted person ' || person_code,
          email         = lower(person_code) || '+deleted@purged.lra.invalid',
          is_active     = false
      where id = r.person_id;
    end if;

    -- Requires the function owner (the migration role, `postgres` under
    -- the Supabase CLI / hosted project) to hold DELETE on auth.users.
    -- Not verified live -- the coder has no database access -- but this
    -- is the standard shape for a Supabase GDPR-style purge function
    -- and the migration role typically has it. Confirm on first real run.
    delete from auth.users where id = r.id;

    v_purged := v_purged + 1;
  end loop;

  return v_purged;
end;
$$;

revoke all on function core.purge_due_accounts() from public;
grant execute on function core.purge_due_accounts() to authenticated, service_role;

comment on function core.purge_due_accounts() is
  'Permanent purge at the 14-day grace period. Deletes the auth.users '
  'login and scrubs identifying fields on core.people; core.users and '
  'every task/ledger/audit row stay intact and correctly attributed. '
  'security definer, admin/system-only, idempotent. Not yet wired to a '
  'scheduler -- PLAN.md Phase 9 / Chan wires pg_cron.';
