-- =====================================================================
-- LRA Ops :: pin search_path on the non-SECURITY-DEFINER functions
--
-- Supabase's security advisor (0011_function_search_path_mutable) flagged
-- the five functions that are not SECURITY DEFINER and so never had
-- search_path pinned by the earlier migrations. None of them resolve an
-- unqualified object today, so this is hardening rather than a fix for an
-- observed defect -- but an unpinned search_path is exactly how a later
-- edit turns a harmless helper into an injection point, and pinning costs
-- nothing. Applied 2026-09-08; advisor re-run afterwards reports clean.
-- =====================================================================

alter function core.auth_user_id()        set search_path = core, public, pg_temp;
alter function core.is_system_caller()    set search_path = core, public, pg_temp;
alter function core.set_updated_at()      set search_path = core, public, pg_temp;
alter function core.forbid_audit_mutation() set search_path = core, public, pg_temp;
alter function ops.week_start_for(timestamptz) set search_path = ops, core, public, pg_temp;
