-- =====================================================================
-- LRA Ops :: allow a claimless connection to delete task notes
--
-- ops.task_notes is append-only and must stay that way: what someone
-- wrote while doing the work is exactly the thing that must not be
-- rewritable afterwards. But the guard was written with NO exception at
-- all, which makes the table impossible to clear even from a direct,
-- claimless postgres connection -- and that blocks the one legitimate
-- case: tearing down demo/test data. ops.tasks cannot be deleted either,
-- since task_notes references it.
--
-- Found when `scripts/seed-demo.mjs --purge` failed with
-- "ops.task_notes is append-only; DELETE is not permitted".
--
-- This mirrors ops_ledger_purge_exception.sql exactly, and keeps the
-- same shape of promise: UPDATE stays forbidden to everyone without
-- exception (a note must never be rewritten), and DELETE is permitted
-- ONLY to core.is_system_caller() -- a direct connection with no JWT
-- claims, i.e. a migration or a maintenance script. Neither the API's
-- user client nor its service client can reach it, so nothing a signed-in
-- founder or admin can do will remove a note.
--
-- core.audit_logs deliberately gets NO equivalent: the audit trail
-- outlives even the data it describes.
-- =====================================================================

create or replace function ops.forbid_task_note_mutation()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and core.is_system_caller() then
    return old;
  end if;

  raise exception 'ops.task_notes is append-only; % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

revoke execute on function ops.forbid_task_note_mutation() from public, anon, authenticated;
