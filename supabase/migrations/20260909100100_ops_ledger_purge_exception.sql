-- =====================================================================
-- LRA Ops :: a narrow, explicit exception for purging synthetic data
--
-- Chan tonight: he wants to test the whole system solo before inviting
-- the real GM/Sales/Broker/Founder, via `scripts/seed-demo.mjs --purge`
-- restoring the database to its current clean state (1 real auth user)
-- before the real invites go out.
--
-- `ops.point_ledger` is append-only "even to the service role" by the
-- same absolutism as `core.audit_logs` (PLAN.md §2.6/§0.5 lesson 7). A
-- purge of ledger rows generated entirely by throwaway `.invalid`-domain
-- demo accounts is not a rewrite of real company history, but the
-- original trigger did not distinguish the two cases at all -- it
-- refused every DELETE unconditionally.
--
-- This migration narrows, not removes, the guarantee:
--   UPDATE remains forbidden unconditionally, for every role, always --
--     a ledger row's recorded facts can never be edited, full stop.
--   DELETE is forbidden for every real business actor. It is permitted
--     ONLY for a direct system connection (`core.is_system_caller()`,
--     the same "no JWT claims" check the migrations and cron jobs use)
--     -- i.e. a service-role script run by Chan himself, never a caller
--     reachable through the API on behalf of any authenticated user.
--
-- `core.audit_logs` gets NO equivalent exception. It is the actual
-- accountability record, it has no throwaway-demo carve-out, and the
-- HR lesson it exists to fix stays absolute. Demo actors' audit rows
-- (email domain `.invalid`) are left in place by the purge script on
-- purpose -- harmless, clearly synthetic, and the guarantee that
-- nothing rewrites audit history is worth more than a perfectly empty
-- table.
--
-- Both FKs on ops.point_ledger are widened to `on delete cascade` in
-- the same migration: without it, deleting a demo task or demo user
-- would still fail with a foreign-key violation before this trigger
-- change is ever reached.
-- =====================================================================

alter table ops.point_ledger drop constraint point_ledger_task_id_fkey;
alter table ops.point_ledger
  add constraint point_ledger_task_id_fkey
  foreign key (task_id) references ops.tasks(id) on delete cascade;

alter table ops.point_ledger drop constraint point_ledger_user_id_fkey;
alter table ops.point_ledger
  add constraint point_ledger_user_id_fkey
  foreign key (user_id) references core.users(id) on delete cascade;

create or replace function ops.forbid_ledger_mutation()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  if tg_op = 'DELETE' and core.is_system_caller() then
    return old;
  end if;

  raise exception 'ops.point_ledger is append-only; % is not permitted', tg_op
    using errcode = '42501';
end;
$$;
