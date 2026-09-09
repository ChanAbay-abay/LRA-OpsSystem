-- =====================================================================
-- LRA Ops :: cast 'ops' to core.module on the cancellation-refusal notify
--
-- Found by running the RLS suite against the live database. The assertion
--
--   'the CLEARING founder CAN refuse a flagged cancellation, with a reason'
--
-- failed with:
--   column "module" is of type module but expression is of type text
--
-- Every other notification branch in ops.enforce_task_transition uses
-- INSERT ... VALUES, where Postgres casts the bare literal 'ops' to
-- core.module happily. The refusal branch is the only one written as
-- INSERT ... SELECT, and there the literal stays text -- so refusing a
-- cancellation raised 42804 and the whole refusal path was dead. Approval
-- worked, refusal did not: the founder could cancel work but could not
-- decline to.
--
-- 20260909150300 has been corrected at source for a fresh database; this
-- migration carries the same fix to the already-migrated project. The
-- function body is otherwise untouched.
-- =====================================================================

-- Applied to the live project by rewriting the stored definition with the
-- single literal cast; see 20260909150300 for the full, corrected body.
do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'ops' and p.proname = 'enforce_task_transition';

  if position('''ops''::core.module' in v_def) > 0 then
    return;  -- already carries the cast
  end if;

  v_def := replace(v_def,
    'select distinct r, ''ops'',',
    'select distinct r, ''ops''::core.module,');
  execute v_def;
end $$;
