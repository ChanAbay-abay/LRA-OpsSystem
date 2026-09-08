-- =====================================================================
-- LRA Ops :: freeze a task once it is cleared
--
-- Found by actually running supabase/tests/rls_test.sql against the live
-- database (the suite had never executed before -- no Docker locally --
-- and hand-review had passed it). The assertion
--
--     'a cleared task cannot be edited, even by the clearing founder'
--
-- reported ALLOWED - 1 row(s) changed.
--
-- Why it matters: `cleared` is the terminal state that credits points and
-- writes the final ledger row. If the row stays editable afterwards, the
-- founder can silently restate history -- change the title, the points,
-- the owner -- after the ledger has already recorded the award. The
-- ledger is append-only and core.audit_logs refuses even the service
-- role, so the task row was the one place the record could still drift
-- out of agreement with its own history. That is precisely the guarantee
-- this system is being built to make.
--
-- `ops.roll_over_week` only moves tasks in
-- ('todo','in_progress','submitted','verified','rejected') -- cleared is
-- deliberately excluded -- so nothing legitimate updates a cleared task
-- and this freeze breaks no existing path. Verified before writing it.
--
-- Scope matches the ledger's own immutability rule: only a direct,
-- claimless connection (a migration or a deliberate correction on the
-- service path) may touch a cleared row. Not the founder, not an admin
-- through the API's user client.
-- =====================================================================

create or replace function ops.freeze_cleared_task()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  if core.is_system_caller() then
    return new;
  end if;

  if old.status = 'cleared' then
    raise exception
      'a cleared task is frozen; points are already credited and the ledger is append-only'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function ops.freeze_cleared_task() from public, anon, authenticated;

-- Named so it sorts before trg_ops_enforce_task_transition: BEFORE row
-- triggers fire in alphabetical order, and the clearer error should win.
create trigger trg_ops_a_freeze_cleared_task
  before update on ops.tasks
  for each row execute function ops.freeze_cleared_task();
