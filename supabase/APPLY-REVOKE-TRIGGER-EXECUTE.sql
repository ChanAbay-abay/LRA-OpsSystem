-- =====================================================================
-- LRA Global Ops :: trigger functions are not an API
--
-- Supabase's own security advisor flags every SECURITY DEFINER function
-- reachable through PostgREST. Most of what it lists here is correct and
-- deliberate; this migration closes only the part that is neither.
--
-- WHAT IS CLOSED. Nine functions that exist ONLY to be fired by a trigger
-- (or, for purge, by a scheduler) were callable directly as
-- `/rest/v1/rpc/<name>` by `anon` and `authenticated`:
--
--   ops.enforce_task_edit_batch_insert / _transition
--   ops.enforce_task_edit_request_insert / _transition
--   ops.enforce_task_transfer_invite
--   ops.stamp_task_block_timestamps
--   ops.stamp_task_transfer_invite_decision
--   core.guard_account_deletion_invariants
--
-- Calling a trigger function outside a trigger raises, so this is
-- hardening rather than a live exploit -- but a guard that is reachable
-- as an endpoint is a guard someone will eventually find a way to call,
-- and none of these were ever meant to be an API surface.
--
-- WHAT IS DELIBERATELY LEFT ALONE, and why the advisor is wrong about it:
--
-- 1. `core.authority()`, `is_admin()`, `is_founder()`, `is_gm()`,
--    `is_oversight()`, `is_member()`, `is_read_only()`, `caller_is_active()`,
--    `caller_has_active_membership()`, `can_read_audit()`.
--    These are the predicates RLS POLICIES are written in. Policy
--    expressions are evaluated as the querying user, so `authenticated`
--    MUST hold EXECUTE on them or every policy in the system fails closed
--    and nobody can read anything. Revoking them would not harden this
--    database, it would break it.
--
-- 2. `core.purge_due_accounts()`. TESTED, AND THE REVOKE WAS WRONG.
--    Revoking it from `authenticated` broke five `purge` assertions on
--    the local stack, because an admin calls it over RPC and an admin IS
--    an authenticated role. Its real control is the guard inside the
--    function ("may only be run by an admin or the system caller"), which
--    the suite proves. The advisor sees an exposed SECURITY DEFINER
--    function and cannot see the guard inside it.
--
--    This is recorded rather than quietly dropped because it is the
--    interesting half: the plausible hardening and the correct hardening
--    were mixed together in one advisor report, and only running the
--    suite separated them.
--
-- 3. The deliberately public RPCs -- `close_briefing`, `close_week`,
--    `create_edit_batch`, `decide_edit_batch`, `withdraw_edit_batch`,
--    `admin_correct_task`, `admin_force_transition`, `accept_task_transfer`,
--    `open_briefing`, `roll_over_week`, `generate_recurring_tasks`,
--    `delete_task_type_if_unused`, `delete_recurring_template_if_unused`.
--    Every one is SECURITY DEFINER ON PURPOSE so its own authority checks
--    run against the real signed-in caller, and every one begins by
--    checking read-only, authority and ops membership. 20260909130000
--    records why they must NOT be routed through the service role: on a
--    service-role connection `core.auth_user_id()` is null, so
--    `core.is_read_only()` returns false for everyone and the
--    authorization decision silently leaves the database.
--
-- VERIFIED: with these revokes applied to the local stack, the full RLS
-- suite reads 290 passed / 0 failed, canary correctly red -- so no
-- trigger stopped firing. Postgres checks EXECUTE on a trigger function
-- at CREATE TRIGGER time, not at fire time; that is the claim this
-- migration rests on, and it was tested rather than assumed.
-- =====================================================================

revoke execute on function ops.enforce_task_edit_batch_insert() from public, anon, authenticated;
revoke execute on function ops.enforce_task_edit_batch_transition() from public, anon, authenticated;
revoke execute on function ops.enforce_task_edit_request_insert() from public, anon, authenticated;
revoke execute on function ops.enforce_task_edit_request_transition() from public, anon, authenticated;
revoke execute on function ops.enforce_task_transfer_invite() from public, anon, authenticated;
revoke execute on function ops.stamp_task_block_timestamps() from public, anon, authenticated;
revoke execute on function ops.stamp_task_transfer_invite_decision() from public, anon, authenticated;
revoke execute on function core.guard_account_deletion_invariants() from public, anon, authenticated;

-- `core.purge_due_accounts()` is INTENTIONALLY still executable by
-- `authenticated`. See note 2 above -- an admin calls it over RPC, and
-- revoking it breaks that path. Do not "fix" this by pattern-matching
-- the advisor.
