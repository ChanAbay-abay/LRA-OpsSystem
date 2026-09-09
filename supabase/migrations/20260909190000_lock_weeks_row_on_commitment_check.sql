-- =====================================================================
-- LRA Ops :: take a row lock when checking whether commitments are open
--
-- Found by the tester reading ops.enforce_task_transition. The
-- commitment-lock guard read the week's state with a plain, non-locking
-- SELECT:
--
--     select w.state into v_week_state from ops.weeks w
--     where w.id = new.week_id;
--
-- Under READ COMMITTED (Postgres's default, and Supabase's) that reads
-- the last COMMITTED snapshot. If ops.close_briefing has already issued
-- its UPDATE on ops.weeks but has not yet committed, a concurrent
-- commit-a-task transaction still sees state = 'planning', passes the
-- guard, and can commit its own write AFTER the briefing close commits
-- -- landing a commitment the close was supposed to have locked out.
--
-- Every other guard in this function checks the row being written. This
-- was the only one depending on a different table's concurrently
-- changing state, which is exactly where a read-committed TOCTOU window
-- opens.
--
-- `for share` makes the reader block on the row lock close_briefing's
-- UPDATE already holds, then re-read the committed version -- so it sees
-- 'open'/'closed' and refuses. ops.weeks rows are written rarely (open,
-- close, roll over), so the contention cost is negligible.
--
-- Honest scope: the mechanism is confirmed by reading the function and
-- knowing the isolation level; the race itself was NOT reproduced with
-- two concurrent sessions. The fix is correct either way and costs
-- nothing, which is why it is worth taking without a reproduction.
--
-- Applied to the live project by rewriting the stored definition; the
-- full corrected body lives in 20260909150100 / 20260909150300.
-- =====================================================================

do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'ops' and p.proname = 'enforce_task_transition';

  if position('new.week_id for share' in v_def) > 0 then
    return;  -- already locking
  end if;

  v_def := replace(v_def,
    'select w.state into v_week_state from ops.weeks w where w.id = new.week_id;',
    'select w.state into v_week_state from ops.weeks w where w.id = new.week_id for share;');
  execute v_def;
end $$;
