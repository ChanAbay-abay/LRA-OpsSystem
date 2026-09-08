-- =====================================================================
-- LRA Ops :: 000 — the rebuild
--
-- Verified safe: a live row census on 2026-09-08 found 47 rows total,
-- every one seed data or derived from a single employee record, zero
-- transactional data (no payroll run, no leave request, no attendance
-- log, no audit row). Full dump at backup/pre-rebuild-snapshot.json
-- (gitignored, contains PII) -- verified to exist and parse before this
-- migration was written. PLAN.md §0.1 and §2.1.
--
-- This drops `public` ONLY. `auth`, `storage`, `graphql`, `extensions`
-- and `realtime` are never touched. Chan's one auth.users row
-- (chanabayabay@gmail.com) survives -- confirm in the Supabase dashboard
-- under Authentication immediately after this runs.
-- =====================================================================

drop schema public cascade;
create schema public;
grant usage on schema public to anon, authenticated, service_role;
comment on schema public is
  'Intentionally empty. LRA data lives in core and per-module schemas (ops, later hr/crm). '
  'public exists only because Postgres requires it and because extensions land near it.';
