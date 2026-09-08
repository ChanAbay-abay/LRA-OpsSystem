-- =====================================================================
-- LRA Ops :: RLS and grants for core + ops (Phase 1 tables)
--
-- Every table in core and ops gets `enable row level security`. Every
-- UPDATE policy carries an explicit WITH CHECK -- Postgres silently
-- reuses USING as the check when it is omitted, which is how HR's
-- `users.role` became freely writable. A policy cannot express a state
-- machine; that arrives with the task triggers in Phase 3.
--
-- The revoke block at the bottom is the step that is easy to forget and
-- catastrophic to skip: Supabase grants ALL on new tables to
-- anon/authenticated and relies on RLS, but RLS does not apply to
-- TRUNCATE at all -- only the table grant stands in front of it, and
-- `truncate employees cascade` from the public anon key once emptied 23
-- HR tables with no login. `alter default privileges` is per schema, so
-- a fresh schema does NOT inherit another schema's revokes -- core and
-- ops each get their own full set here, and every future module schema
-- must repeat this block.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Baseline grants (mirrors what Supabase sets up automatically for
--    `public`; a schema we create ourselves does not inherit it).
-- ---------------------------------------------------------------------

grant select, insert, update, delete, truncate, trigger, references
  on all tables in schema core to anon, authenticated;
grant select, insert, update, delete, truncate, trigger, references
  on all tables in schema ops to anon, authenticated;
grant all on all tables in schema core to service_role;
grant all on all tables in schema ops to service_role;

alter default privileges in schema core
  grant select, insert, update, delete, truncate, trigger, references
  on tables to anon, authenticated;
alter default privileges in schema ops
  grant select, insert, update, delete, truncate, trigger, references
  on tables to anon, authenticated;
alter default privileges in schema core grant all on tables to service_role;
alter default privileges in schema ops  grant all on tables to service_role;

-- ---------------------------------------------------------------------
-- 1. Enable RLS everywhere.
-- ---------------------------------------------------------------------

alter table core.people enable row level security;
alter table core.users enable row level security;
alter table core.memberships enable row level security;
alter table core.notifications enable row level security;
alter table core.notification_outbox enable row level security;
alter table core.audit_logs enable row level security;
alter table ops.settings enable row level security;
alter table ops.weeks enable row level security;

-- ---------------------------------------------------------------------
-- 2. core.people — self, or oversight / admin write / admin write / none
-- ---------------------------------------------------------------------

create policy people_select on core.people for select to authenticated
using (
  core.is_oversight()
  or exists (
    select 1 from core.users u
    where u.id = core.auth_user_id() and u.person_id = core.people.id
  )
);

create policy people_insert on core.people for insert to authenticated
with check (core.is_admin());

create policy people_update on core.people for update to authenticated
using (core.is_admin())
with check (core.is_admin());

-- no DELETE policy: people are deactivated, never deleted.

-- ---------------------------------------------------------------------
-- 3. core.users — self or oversight / admin / self (guarded) + admin / none
-- ---------------------------------------------------------------------

create policy users_select on core.users for select to authenticated
using (id = core.auth_user_id() or core.is_oversight());

create policy users_insert on core.users for insert to authenticated
with check (core.is_admin());

-- The row owner may update their own row; an admin may update any row.
-- `trg_guard_user_privilege_columns` (core_identity.sql) is the real
-- enforcement of *which* columns a non-admin owner may touch.
create policy users_update on core.users for update to authenticated
using (id = core.auth_user_id() or core.is_admin())
with check (id = core.auth_user_id() or core.is_admin());

-- no DELETE policy: accounts are deactivated, never deleted.

-- ---------------------------------------------------------------------
-- 4. core.memberships — any active member reads / admin writes / none
-- ---------------------------------------------------------------------

create policy memberships_select on core.memberships for select to authenticated
using (
  core.is_admin()
  or (
    is_active
    and exists (
      select 1 from core.memberships caller
      where caller.user_id = core.auth_user_id() and caller.is_active
    )
  )
);

create policy memberships_insert on core.memberships for insert to authenticated
with check (core.is_admin());

create policy memberships_update on core.memberships for update to authenticated
using (core.is_admin())
with check (core.is_admin());

-- no DELETE policy: memberships are deactivated, never deleted.

-- ---------------------------------------------------------------------
-- 5. core.notifications — own inbox / NO insert for authenticated /
--    own row, is_read only (trigger-enforced) / own row delete
-- ---------------------------------------------------------------------

create policy notifications_select on core.notifications for select to authenticated
using (user_id = core.auth_user_id());

-- Deliberately no INSERT policy for `authenticated`. Notifications
-- originate only from the outbox drain, which runs on the service
-- client and therefore bypasses RLS entirely -- that is the point.

create policy notifications_update on core.notifications for update to authenticated
using (user_id = core.auth_user_id())
with check (user_id = core.auth_user_id());

create policy notifications_delete on core.notifications for delete to authenticated
using (user_id = core.auth_user_id());

-- ---------------------------------------------------------------------
-- 6. core.notification_outbox — recipient/oversight read / system-only write
-- ---------------------------------------------------------------------

create policy outbox_select on core.notification_outbox for select to authenticated
using (recipient_id = core.auth_user_id() or core.is_oversight());

-- No INSERT/UPDATE policy for `authenticated`: the outbox is written and
-- drained only by the service client.

-- ---------------------------------------------------------------------
-- 7. core.audit_logs — actor/entity-owner/oversight read / actor-stamped
--    insert / append-only (trigger already forbids UPDATE/DELETE outright)
-- ---------------------------------------------------------------------

create policy audit_select on core.audit_logs for select to authenticated
using (
  actor_id = core.auth_user_id()
  or core.can_read_audit(entity_type, entity_id)
);

create policy audit_insert on core.audit_logs for insert to authenticated
with check (actor_id = core.auth_user_id());

-- no UPDATE/DELETE policy, and the BEFORE triggers refuse both outright
-- with 42501 even for the table owner and the service role.

-- ---------------------------------------------------------------------
-- 8. ops.settings — ops member read / none insert / founder update / none
-- ---------------------------------------------------------------------

create policy settings_select on ops.settings for select to authenticated
using (core.is_member('ops'));

create policy settings_update on ops.settings for update to authenticated
using (core.is_founder())
with check (core.is_founder());

-- no INSERT/DELETE policy: exactly one settings row, seeded once.

-- ---------------------------------------------------------------------
-- 9. ops.weeks — ops member read / oversight insert / oversight update / none
-- ---------------------------------------------------------------------

create policy weeks_select on ops.weeks for select to authenticated
using (core.is_member('ops'));

create policy weeks_insert on ops.weeks for insert to authenticated
with check (core.is_oversight());

create policy weeks_update on ops.weeks for update to authenticated
using (core.is_oversight())
with check (core.is_oversight());

-- no DELETE policy: a week is closed, never deleted.

-- ---------------------------------------------------------------------
-- 10. The mandatory per-schema revoke block. RLS does not cover
--     TRUNCATE at all -- only this grant stands in front of it.
--     Every future module schema (hr, crm, ...) must repeat this block
--     in the same migration that creates it.
-- ---------------------------------------------------------------------

revoke truncate, trigger, references on all tables in schema core from anon, authenticated;
revoke truncate, trigger, references on all tables in schema ops  from anon, authenticated;
revoke delete on all tables in schema core from anon;
revoke delete on all tables in schema ops  from anon;
alter default privileges in schema core
  revoke truncate, trigger, references on tables from anon, authenticated;
alter default privileges in schema ops
  revoke truncate, trigger, references on tables from anon, authenticated;
alter default privileges in schema core revoke delete on tables from anon;
alter default privileges in schema ops  revoke delete on tables from anon;
