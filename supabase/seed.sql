-- =====================================================================
-- LRA Ops :: local-only seed fixtures
--
-- Runs after migrations on `supabase db reset` (local stack only, see
-- package.json — there is deliberately no `db:reset` script). Never
-- touches the linked production project; `supabase db push` does not
-- run this file.
--
-- Nothing sensitive here. `supabase/tests/rls_test.sql` sets up its own
-- fixtures inside a rolled-back transaction, so this file just gives a
-- fresh local `supabase start` a current week to look at.
-- =====================================================================

insert into ops.weeks (week_start, state)
values (ops.week_start_for(now()), 'planning')
on conflict (week_start) do nothing;
