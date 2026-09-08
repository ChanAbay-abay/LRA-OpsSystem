-- =====================================================================
-- LRA Ops :: RLS for the Phase 3 tables (catalog, tasks, blocks)
--
-- `ops` already carries the per-schema revoke block from
-- core_ops_rls.sql, and `alter default privileges in schema ops` is
-- role-scoped, not table-scoped -- new tables created by the same
-- migration role inherit it automatically. Verified live with
-- `has_table_privilege` after this migration applies (see the coder's
-- report); this file does not re-issue the revoke block because doing
-- so blindly, without checking, is exactly the "assume it inherited"
-- mistake PLAN.md §2.7 warns against. If verification had failed this
-- file would carry an explicit revoke instead of a comment.
-- =====================================================================

alter table ops.task_types enable row level security;
alter table ops.task_type_revisions enable row level security;
alter table ops.recurring_templates enable row level security;
alter table ops.tasks enable row level security;
alter table ops.task_blocks enable row level security;

-- ---------------------------------------------------------------------
-- ops.task_types — member read / oversight write / no delete (deactivate)
-- ---------------------------------------------------------------------
create policy task_types_select on ops.task_types for select to authenticated
using (core.is_member('ops'));

create policy task_types_insert on ops.task_types for insert to authenticated
with check (core.is_oversight());

create policy task_types_update on ops.task_types for update to authenticated
using (core.is_oversight())
with check (core.is_oversight());

-- ---------------------------------------------------------------------
-- ops.task_type_revisions — member read / no direct writes (the AFTER
-- trigger on task_types is security definer and bypasses RLS entirely,
-- which is the only path in).
-- ---------------------------------------------------------------------
create policy task_type_revisions_select on ops.task_type_revisions for select to authenticated
using (core.is_member('ops'));

-- ---------------------------------------------------------------------
-- ops.recurring_templates — member read / oversight write / no delete
-- ---------------------------------------------------------------------
create policy recurring_templates_select on ops.recurring_templates for select to authenticated
using (core.is_member('ops'));

create policy recurring_templates_insert on ops.recurring_templates for insert to authenticated
with check (core.is_oversight());

create policy recurring_templates_update on ops.recurring_templates for update to authenticated
using (core.is_oversight())
with check (core.is_oversight());

-- ---------------------------------------------------------------------
-- ops.tasks — any ops member reads everything, by design (PRD.md §6.1);
-- owner or oversight write; the trigger is the real enforcement of which
-- transitions and which columns, so WITH CHECK mirrors USING exactly.
-- ---------------------------------------------------------------------
create policy tasks_select on ops.tasks for select to authenticated
using (core.is_member('ops'));

create policy tasks_insert on ops.tasks for insert to authenticated
with check (owner_user_id = core.auth_user_id() or core.is_oversight());

create policy tasks_update on ops.tasks for update to authenticated
using (owner_user_id = core.auth_user_id() or core.is_oversight())
with check (owner_user_id = core.auth_user_id() or core.is_oversight());

-- A task may be deleted by its owner only while it is harmless to
-- remove -- todo or cancelled. Anything further along has already
-- entered the accountability trail and is cancelled, not deleted.
create policy tasks_delete on ops.tasks for delete to authenticated
using (owner_user_id = core.auth_user_id() and status in ('todo', 'cancelled'));

-- ---------------------------------------------------------------------
-- ops.task_blocks — member read / member creates (self-attributed) /
-- creator, the named blocking user, or oversight resolves / no delete
-- ---------------------------------------------------------------------
create policy task_blocks_select on ops.task_blocks for select to authenticated
using (core.is_member('ops'));

create policy task_blocks_insert on ops.task_blocks for insert to authenticated
with check (core.is_member('ops') and created_by = core.auth_user_id());

create policy task_blocks_update on ops.task_blocks for update to authenticated
using (
  created_by = core.auth_user_id()
  or blocking_user_id = core.auth_user_id()
  or core.is_oversight()
)
with check (
  created_by = core.auth_user_id()
  or blocking_user_id = core.auth_user_id()
  or core.is_oversight()
);

-- ---------------------------------------------------------------------
-- Ops's branch of core.can_read_audit — a task's owner may read its own
-- audit timeline, not just oversight (core_notifications_audit.sql
-- flagged this as a gap left open on purpose for the module that first
-- needs it; this is that module).
-- ---------------------------------------------------------------------
create or replace function core.can_read_audit(p_entity_type text, p_entity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = core, ops, public
as $$
  select core.is_oversight()
    or (
      p_entity_type = 'ops.task'
      and exists (
        select 1 from ops.tasks t
        where t.id = p_entity_id and t.owner_user_id = core.auth_user_id()
      )
    );
$$;
