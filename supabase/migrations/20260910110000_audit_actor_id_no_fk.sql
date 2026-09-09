-- =====================================================================
-- LRA Ops :: core.audit_logs.actor_id stops being a foreign key
--
-- core.audit_logs is append-only: forbid_audit_mutation() refuses UPDATE
-- and DELETE outright, to everyone, including a claimless postgres
-- connection. That is the strongest promise in this schema and it is
-- deliberate.
--
-- But actor_id carried `references core.users(id) on delete set null`.
-- That is a contradiction hiding in plain sight: `on delete set null`
-- IS an UPDATE of the audit table, issued by Postgres itself. So
-- deleting any user whose actions were ever audited raised
--
--     42501: core.audit_logs is append-only; UPDATE is not permitted
--     SQL statement "UPDATE ONLY core.audit_logs SET actor_id = NULL ..."
--
-- Two correct rules deadlocking each other: a user could never be
-- deleted, and the demo purge could not complete.
--
-- The FK is the wrong half. An audit row saying "user X approved this"
-- must keep saying that forever -- blanking the actor when the account
-- is removed is precisely the rewriting of history the append-only
-- guard exists to prevent. actor_id stays a plain uuid, retaining the
-- id even after the account is gone; actor_email and actor_authority
-- are already denormalised onto the row for exactly this reason, so the
-- entry stays readable with no join.
--
-- This also makes core.purge_due_accounts() coherent: the 14-day purge
-- erases the person's identity and login while every audit row still
-- attributes their actions to the same id.
-- =====================================================================

do $$
declare v_conname text;
begin
  select c.conname into v_conname
  from pg_constraint c
  where c.conrelid = 'core.audit_logs'::regclass
    and c.contype = 'f'
    and c.confrelid = 'core.users'::regclass;

  if v_conname is not null then
    execute format('alter table core.audit_logs drop constraint %I', v_conname);
  end if;
end $$;

comment on column core.audit_logs.actor_id is
  'The core.users id that performed the action. Deliberately NOT foreign-keyed '
  '(see 20260910110000): `on delete set null` would rewrite history, which this '
  'append-only table forbids. The id is retained even after the account is purged; '
  'actor_email and actor_authority are denormalised here so the row reads without a join.';
