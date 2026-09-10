-- =====================================================================
-- LRA Ops :: bulk edit suggestions -- ops.task_edit_batches
--
-- Chan, 2026-09-10, verbatim: "make sure for the monday briefing one the
-- admin and founder be able to edit stuff. GM can send a request to edit
-- (should be done by bulk like an edit feature on google docs), then
-- approve by admin or founder showing what changed like before and
-- after"
--
-- Two instructions live in that sentence, and this migration is the
-- database half of both.
--
-- 1. BULK. `ops.task_edit_requests` (20260910140000) already carries a
--    proposal as typed data -- a `change_*` flag paired with a
--    `proposed_*` column for each of the five defining fields, a
--    mandatory reason, `before_values` snapshotted server-side at
--    request time and `after_values` stamped from what was actually
--    applied. That IS Chan's before/after, and it already works. So
--    bulk is a BATCH WRAPPER over it, not a second proposal mechanism:
--    one `ops.task_edit_batches` row (the single "suggestion summary"
--    note, exactly like the one comment a Google Docs suggestion
--    carries) owning N ordinary `ops.task_edit_requests` children.
--    Nothing about a child changes; `batch_id` is NULLABLE and a NULL
--    keeps today's single-request behaviour byte-for-byte, so every
--    existing route, policy, trigger and RLS assertion stays valid.
--
--    The property this preserves deliberately: a proposal can only ever
--    express a change to one of the five DEFINING columns. "Propose a
--    change to points_override" remains inexpressible, in bulk as
--    singly, because the batch adds no new columns to express it with.
--
-- 2. APPROVAL WIDENS TO FOUNDER **OR** ADMIN, AND THIS SUPERSEDES
--    20260910140000's HEADER.
--
--    That header records the decision plainly: "Approver:
--    `core.is_clearing_founder()`, per the brief -- admits admin, and
--    the one clearing seat, and excludes a non-clearing founder
--    (founder2 in the test fixtures)". PLAN.md §10.1 records the same.
--    Chan's new instruction is "approve by admin or founder", without
--    the clearing qualifier, so the decider becomes `core.is_founder()`
--    (which admits founder AND admin) on both the batch path and the
--    single-request path, for consistency -- one authority rule for one
--    kind of decision. **The earlier reasoning is not still true and is
--    not being quietly left in place: it is superseded here, on Chan's
--    explicit instruction, and a non-clearing founder (founder2) may now
--    decide an edit request.** The RLS suite's assertion that they may
--    not is inverted in the same commit rather than deleted, so the
--    change is visible as a change.
--
--    AND IT CARRIES `and not core.is_read_only()`, EXPLICITLY.
--    `is_clearing_founder()` excluded ERC and DCA structurally -- they
--    are `authority = 'founder', is_clearing_founder = false`, so the
--    old predicate refused them by construction. `is_founder()` does
--    NOT: it reads authority alone, and ERC/DCA hold `founder`
--    authority. Widening the predicate therefore removes the structural
--    exclusion and the read-only guard has to be written down instead of
--    inherited. Both edit-request paths already refuse a read-only
--    caller at their first statement, and that statement stays; the
--    explicit `and not core.is_read_only()` in the decider predicate is
--    belt AND braces, because two outside observers being able to
--    approve edits to the locked Monday record is the exact defect class
--    this repo spent 2026-09-10 finding three separate times.
--
-- ATOMICITY IS THE WHOLE POINT OF `ops.decide_edit_batch`.
-- PLAN.md §12.7: three of this project's worst defects were "correct
-- response, broken side effect". A batch that applied four of its five
-- edits and answered 200 would be the worst instance of that pattern
-- yet, because the record it half-rewrote is the committed Monday
-- record. So:
--
--   * there is exactly ONE apply path, and it is the proven one --
--     `ops.decide_edit_batch` sets each child's `status`, and the
--     existing per-row trigger
--     (`ops.enforce_task_edit_request_transition`) does the applying,
--     writes each child's `after_values`, and audits each decision. No
--     second copy of the apply logic exists to drift.
--   * the function contains NO exception handler anywhere, on purpose.
--     A `begin ... exception` block in plpgsql opens an implicit
--     savepoint, and catching a child's refusal would leave the batch
--     free to continue past it -- which is precisely how a half-applied
--     batch would come to exist. Any child's refusal propagates and the
--     whole transaction unwinds.
--   * it asserts that the number of children it decided equals the
--     number of children the batch has, so a batch that somehow lost a
--     row (or gained a decided one) aborts instead of reporting success
--     over an incomplete apply.
--
-- AND A BATCH'S PARTS CANNOT BE DECIDED SEPARATELY. All-or-nothing is
-- worth nothing if an approver can still approve one child on its own
-- through PostgREST. A child with a non-null `batch_id`, and the batch
-- row itself, are both decidable only from inside these functions,
-- enforced by a transaction-scoped GUC (`ops.deciding_edit_batch`)
-- carrying the batch id -- the same cross-trigger-invocation mechanism,
-- and the same `is_local => true` discipline, that
-- 20260910170000 established for `ops.suppress_direct_edit_audit`
-- (including clearing it the instant it is no longer needed: that
-- migration's header records the leak that taught the lesson).
--
-- WHAT ELSE IS IN HERE, AND WHY:
--   * `ops.create_edit_batch` -- creation is one function call too. Not
--     named in the build contract, added deliberately: a batch row and
--     its children inserted as two PostgREST calls are two
--     transactions, and a failure on the second leaves a permanent
--     childless pending batch in the approver's queue -- the same
--     "side effect half-happened" family as a half-applied approval.
--     It also refuses any item carrying a key outside the five defining
--     fields, so the "inexpressible" property above survives the jsonb
--     argument it now travels through.
--   * `ops.withdraw_edit_batch` -- because refusing an individual child
--     decision (above) would otherwise strand a submitted batch with no
--     way for its own requester to think better of it. `withdrawn`
--     exists on a single request for exactly that reason
--     (20260910140000's header); a batch keeps it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Part 1 -- the batch table, and the child's link to it.
-- ---------------------------------------------------------------------

create table ops.task_edit_batches (
  id              uuid primary key default gen_random_uuid(),
  requested_by    uuid not null references core.users(id),
  requested_at    timestamptz not null default now(),

  -- The ONE note covering the whole batch -- Chan's "like an edit
  -- feature on google docs", where a suggestion carries a comment, not
  -- a comment per character changed. Same >= 10 char floor as a single
  -- request's reason: a reason nobody can read is not a reason.
  reason          text not null,

  -- Deliberately the SAME enum as a child request
  -- (`ops.edit_request_status`), not a parallel one. A batch and its
  -- children move together and always end in the same state, so two
  -- enums would only be two things to disagree.
  status          ops.edit_request_status not null default 'pending',
  decided_by      uuid references core.users(id),
  decided_at      timestamptz,
  decision_reason text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint task_edit_batches_reason_len check (length(trim(reason)) >= 10)
);

create index idx_ops_task_edit_batches_pending
  on ops.task_edit_batches (status, requested_at)
  where status = 'pending';
create index idx_ops_task_edit_batches_requester
  on ops.task_edit_batches (requested_by, requested_at desc);

create trigger trg_ops_task_edit_batches_updated_at
  before update on ops.task_edit_batches
  for each row execute function core.set_updated_at();

-- NULLABLE, and that is the compatibility guarantee: an
-- `ops.task_edit_requests` row with `batch_id is null` is exactly what
-- it was before this migration -- raised, decided and withdrawn one at
-- a time through the routes and triggers that already exist.
alter table ops.task_edit_requests
  add column batch_id uuid references ops.task_edit_batches(id);

create index idx_ops_task_edit_requests_batch
  on ops.task_edit_requests (batch_id)
  where batch_id is not null;

comment on column ops.task_edit_requests.batch_id is
  'When set, this request is one item of a bulk suggestion '
  '(ops.task_edit_batches) and may ONLY be decided or withdrawn through '
  'ops.decide_edit_batch / ops.withdraw_edit_batch -- all-or-nothing. '
  'NULL means the original single-request behaviour, unchanged.';

comment on table ops.task_edit_batches is
  'A bulk edit suggestion: one reason, N ops.task_edit_requests '
  'children, decided all-or-nothing by a founder or admin '
  '(ops.decide_edit_batch). Chan, 2026-09-10: "GM can send a request to '
  'edit (should be done by bulk like an edit feature on google docs), '
  'then approve by admin or founder showing what changed like before and '
  'after".';

-- ---------------------------------------------------------------------
-- Part 2 -- INSERT guard on a batch. Mirrors
-- ops.enforce_task_edit_request_insert's shape exactly, minus the
-- per-task snapshot (a batch proposes nothing itself; its children do).
-- ---------------------------------------------------------------------
create or replace function ops.enforce_task_edit_batch_insert()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  -- Read-only refusal, ahead of every other bypass -- core.is_read_only()'s
  -- own comment is the rule: it must be checked before
  -- is_system_caller()/is_admin(), because a read-only founder's own
  -- authority would otherwise satisfy every oversight check below it.
  if core.is_read_only() then
    raise exception 'a read-only account may not raise a bulk edit suggestion' using errcode = '42501';
  end if;

  if core.is_system_caller() or core.is_admin() then
    null;  -- fixture/system inserts, same allowance as a single request
  else
    if new.requested_by is distinct from core.auth_user_id() then
      raise exception 'requested_by must be the caller' using errcode = '42501';
    end if;
    if not core.is_oversight() then
      raise exception 'only GM, founder or admin may raise a bulk edit suggestion' using errcode = '42501';
    end if;
  end if;

  if new.status <> 'pending' then
    raise exception 'a new bulk edit suggestion must start pending' using errcode = '42501';
  end if;

  if new.decided_by is not null or new.decided_at is not null or new.decision_reason is not null then
    raise exception 'a new bulk edit suggestion cannot be pre-decided' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger trg_ops_enforce_task_edit_batch_insert
  before insert on ops.task_edit_batches
  for each row execute function ops.enforce_task_edit_batch_insert();

-- ---------------------------------------------------------------------
-- Part 3 -- UPDATE guard on a batch: decidable ONLY through
-- ops.decide_edit_batch / ops.withdraw_edit_batch.
--
-- This trigger deliberately does NOT re-implement the authority ladder.
-- If it did, the ladder would exist in two places and a direct
-- `update ops.task_edit_batches set status = 'approved'` through
-- PostgREST would satisfy it while applying NOTHING to the children --
-- a batch marked approved whose edits never landed, which is the
-- inverse of, and just as bad as, a half-applied batch. So the only
-- question this trigger asks is "did this update come from the function
-- that also moves the children?", and the answer is a transaction-scoped
-- GUC that only those functions set.
-- ---------------------------------------------------------------------
create or replace function ops.enforce_task_edit_batch_transition()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not act on a bulk edit suggestion' using errcode = '42501';
  end if;

  if coalesce(current_setting('ops.deciding_edit_batch', true), '') <> old.id::text then
    raise exception
      'a bulk edit suggestion is decided only through ops.decide_edit_batch / ops.withdraw_edit_batch, '
      'so its items and its own status can never disagree'
      using errcode = '42501';
  end if;

  if old.status <> 'pending' then
    raise exception 'this bulk edit suggestion has already been decided (%) and cannot be changed', old.status
      using errcode = '42501';
  end if;

  -- Provenance is immutable, same rule as a single request's.
  if (new.requested_by is distinct from old.requested_by
      or new.requested_at is distinct from old.requested_at
      or new.reason is distinct from old.reason) then
    raise exception 'a bulk edit suggestion''s requester and reason are immutable once created'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger trg_ops_enforce_task_edit_batch_transition
  before update on ops.task_edit_batches
  for each row execute function ops.enforce_task_edit_batch_transition();

-- ---------------------------------------------------------------------
-- Part 4 -- the child transition guard, reproduced IN FULL from its
-- current live body (20260910170000's copy -- the last migration to
-- define it) with exactly three changes, each marked `-- CHANGED` /
-- `-- NEW` below:
--
--   1. the decider becomes `core.is_founder() and not core.is_read_only()`
--      instead of `core.is_clearing_founder()` (see this file's header
--      -- supersedes 20260910140000);
--   2. `batch_id` joins the immutable-provenance list;
--   3. a child of a batch is decidable only from inside
--      ops.decide_edit_batch / ops.withdraw_edit_batch.
--
-- Everything else -- the read-only refusal at statement 0, the
-- already-decided check, the immutability list, the self-approval
-- refusal, the >=10-char rejection reason, the atomic apply, the
-- suppress-direct-edit-audit flag and its immediate clearing, the
-- after_values merge-not-strip construction, the audit row -- is
-- verbatim. `create or replace`, never an edit of an applied migration.
-- ---------------------------------------------------------------------
create or replace function ops.enforce_task_edit_request_transition()
returns trigger
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_task ops.tasks%rowtype;
  v_actor_email text;
  v_actor_authority core.authority;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not act on a task edit request' using errcode = '42501';
  end if;

  if old.status <> 'pending' then
    raise exception 'this edit request has already been decided (%) and cannot be changed', old.status
      using errcode = '42501';
  end if;

  -- NEW (3). All-or-nothing, enforced at the row: an item of a bulk
  -- suggestion cannot be picked off on its own, not through PostgREST
  -- and not through psql. The GUC is set only by ops.decide_edit_batch
  -- and ops.withdraw_edit_batch, and only for the batch they are
  -- currently deciding -- so it cannot authorise a child of some OTHER
  -- batch that happens to be updated in the same transaction.
  if old.batch_id is not null
     and coalesce(current_setting('ops.deciding_edit_batch', true), '') <> old.batch_id::text then
    raise exception
      'this edit request is one item of a bulk suggestion; decide the whole suggestion '
      '(ops.decide_edit_batch), never one item of it'
      using errcode = '42501';
  end if;

  -- The proposed change and its provenance are immutable once created --
  -- withdraw and resubmit rather than edit a request in place, exactly
  -- like a cancellation flag's reason cannot be rewritten after the
  -- fact.
  if (new.task_id is distinct from old.task_id
      or new.requested_by is distinct from old.requested_by
      or new.requested_at is distinct from old.requested_at
      or new.reason is distinct from old.reason
      -- NEW (2). Re-parenting a pending item into another batch would
      -- move it under a different reason and a different approver's
      -- queue; the diff an approver reviewed must be the diff they
      -- decide.
      or new.batch_id is distinct from old.batch_id
      or new.change_title is distinct from old.change_title
      or new.proposed_title is distinct from old.proposed_title
      or new.change_description is distinct from old.change_description
      or new.proposed_description is distinct from old.proposed_description
      or new.change_task_type_id is distinct from old.change_task_type_id
      or new.proposed_task_type_id is distinct from old.proposed_task_type_id
      or new.change_owner_user_id is distinct from old.change_owner_user_id
      or new.proposed_owner_user_id is distinct from old.proposed_owner_user_id
      or new.change_client_ref is distinct from old.change_client_ref
      or new.proposed_client_ref is distinct from old.proposed_client_ref
      or new.before_values is distinct from old.before_values) then
    raise exception 'the proposed change on an edit request is immutable once created; withdraw and resubmit instead'
      using errcode = '42501';
  end if;

  if new.status = 'withdrawn' then
    if not (core.is_system_caller() or core.is_admin() or old.requested_by = core.auth_user_id()) then
      raise exception 'only the requester may withdraw their own edit request' using errcode = '42501';
    end if;
    new.decided_by := core.auth_user_id();
    new.decided_at := now();

  elsif new.status in ('approved', 'rejected') then
    -- CHANGED (1). Was `core.is_clearing_founder()`. Chan, 2026-09-10:
    -- "then approve by admin or founder". `core.is_founder()` admits
    -- founder and admin, which is his list; the read-only clause is
    -- explicit because `is_clearing_founder()` used to exclude ERC/DCA
    -- structurally (is_clearing_founder = false) and `is_founder()`
    -- does not -- they hold `founder` authority. Statement 0 above
    -- already refuses them; this repeats it in the predicate itself so
    -- the widening cannot be read as also widening to the two accounts
    -- that exist to observe and never to act.
    if not (core.is_system_caller() or (core.is_founder() and not core.is_read_only())) then
      raise exception 'only a founder or admin may decide a task edit request' using errcode = '42501';
    end if;

    if not core.is_system_caller() and old.requested_by = core.auth_user_id() then
      raise exception 'the requester may not approve or reject their own edit request' using errcode = '42501';
    end if;

    if new.status = 'rejected'
       and (new.decision_reason is null or length(trim(new.decision_reason)) < 10) then
      raise exception 'rejecting an edit request requires a written reason of at least 10 characters'
        using errcode = '42501';
    end if;

    new.decided_by := core.auth_user_id();
    new.decided_at := now();

    if new.status = 'approved' then
      select * into v_task from ops.tasks where id = old.task_id for update;
      if v_task.id is null then
        raise exception 'the task this request was raised against no longer exists' using errcode = 'P0002';
      end if;
      if v_task.status in ('cleared', 'cancelled') then
        raise exception 'this task is closed (%) and its definition can no longer be changed', v_task.status
          using errcode = '42501';
      end if;

      -- Transaction-scoped flag (20260910170000) so the internal UPDATE
      -- below does not ALSO trip the tasks-level direct-edit audit --
      -- this approval's own audit row, written further down in THIS
      -- function, is already the correct, complete record of this
      -- change. `is_local => true`: reverts at the end of the
      -- transaction, so it can never leak into a later request.
      perform set_config('ops.suppress_direct_edit_audit', 'true', true);

      update ops.tasks set
        title         = case when old.change_title then old.proposed_title else title end,
        description   = case when old.change_description then old.proposed_description else description end,
        task_type_id  = case when old.change_task_type_id then old.proposed_task_type_id else task_type_id end,
        owner_user_id = case when old.change_owner_user_id then old.proposed_owner_user_id else owner_user_id end,
        client_ref    = case when old.change_client_ref then old.proposed_client_ref else client_ref end
      where id = old.task_id;

      -- ...and cleared again the instant that UPDATE is done. `is_local`
      -- scopes the flag to the TRANSACTION, not the statement. Under a
      -- bulk approval this matters far more than it did when the line
      -- was written: ops.decide_edit_batch drives this trigger N times
      -- in ONE transaction, so a flag left set by item 1 would silence
      -- the direct-edit audit for every later item, and for any
      -- unrelated direct edit in the same transaction. The leak was
      -- found by the RLS suite on 2026-09-10 with N = 1.
      perform set_config('ops.suppress_direct_edit_audit', 'false', true);

      -- Same merge-not-strip construction as before_values, and for the
      -- same reason: a proposed value of null is a real, intentional
      -- part of the applied change, not an absence to be stripped.
      new.after_values :=
        (case when old.change_title then jsonb_build_object('title', to_jsonb(old.proposed_title)) else '{}'::jsonb end)
        || (case when old.change_description then jsonb_build_object('description', to_jsonb(old.proposed_description)) else '{}'::jsonb end)
        || (case when old.change_task_type_id then jsonb_build_object('task_type_id', to_jsonb(old.proposed_task_type_id)) else '{}'::jsonb end)
        || (case when old.change_owner_user_id then jsonb_build_object('owner_user_id', to_jsonb(old.proposed_owner_user_id)) else '{}'::jsonb end)
        || (case when old.change_client_ref then jsonb_build_object('client_ref', to_jsonb(old.proposed_client_ref)) else '{}'::jsonb end);
    end if;

  else
    raise exception 'illegal edit-request transition pending -> %', new.status using errcode = '42501';
  end if;

  select u.email, u.authority into v_actor_email, v_actor_authority
  from core.users u where u.id = core.auth_user_id();

  insert into core.audit_logs
    (actor_id, actor_email, actor_authority, module, action, entity_type, entity_id, old_values, new_values)
  values
    (core.auth_user_id(), v_actor_email, v_actor_authority, 'ops',
     case new.status
       when 'approved'  then 'ops.task_edit_request.approved'
       when 'rejected'  then 'ops.task_edit_request.rejected'
       when 'withdrawn' then 'ops.task_edit_request.withdrawn'
     end,
     'ops.task_edit_request', new.id,
     jsonb_build_object('status', old.status, 'before_values', old.before_values, 'task_id', old.task_id,
                        'batch_id', old.batch_id),
     jsonb_build_object('status', new.status, 'reason', coalesce(new.decision_reason, old.reason),
                         'after_values', new.after_values));

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Part 5 -- ops.create_edit_batch: the batch and every item, in one
-- call, or none of them.
--
-- WHY THIS IS A FUNCTION AND NOT TWO INSERTS FROM THE API. Under
-- PostgREST one request is one transaction, so "insert the batch, then
-- insert the children" is TWO transactions: if the second half fails
-- (an unknown task, a closed task, a task whose week is untouched by the
-- lock) the batch row survives with no items, permanently pending, in
-- an approver's queue, where ops.decide_edit_batch will refuse it as
-- empty forever. That is the same "the side effect half-happened" family
-- as a half-applied approval (PLAN.md §12.7), so it gets the same
-- answer.
--
-- WHY IT VALIDATES KEYS. `p_items` is jsonb, which is the one place in
-- this design where an untyped payload touches a typed proposal. The
-- guarantee that "propose a change to points_override" is
-- INEXPRESSIBLE lives in the fact that ops.task_edit_requests has a
-- column per proposable field and no others -- so this function refuses
-- any item key outside those five (plus `task_id`) rather than ignoring
-- it. Silently dropping an unknown key would let a caller believe they
-- had proposed something they had not, which on this table is worse
-- than a refusal.
--
-- Every real gate is still the child INSERT trigger's:
-- `requested_by` = caller, oversight-only, task exists and is not
-- closed, and `before_values` snapshotted from the task's own current
-- row. Nothing here trusts the client for a "before".
-- ---------------------------------------------------------------------
create or replace function ops.create_edit_batch(p_reason text, p_items jsonb)
returns ops.task_edit_batches
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_batch ops.task_edit_batches;
  v_item  jsonb;
  v_key   text;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not raise a bulk edit suggestion' using errcode = '42501';
  end if;

  -- A batch is always somebody's suggestion. There is no system-caller
  -- path here on purpose: nothing in this app generates a bulk edit
  -- suggestion on its own behalf, and `requested_by` is not nullable
  -- because "who is suggesting this" is the whole provenance.
  if core.auth_user_id() is null then
    raise exception 'ops.create_edit_batch must be called by a signed-in user' using errcode = '42501';
  end if;

  -- MEMBERSHIP, asked explicitly because SECURITY DEFINER does not ask it
  -- for us. Every policy on ops.task_edit_batches / ops.task_edit_requests
  -- carries `core.is_member('ops')`, but this function runs as the table
  -- owner, for whom RLS is not enforced -- so the policy clause does NOT
  -- apply to the writes below. `core.is_founder()` reads authority alone
  -- and would otherwise let a founder outside the ops module act on the
  -- ops week's committed record. The API's requireMembership('ops') hook
  -- says the same thing one layer up; this is the layer that counts.
  if not (core.is_system_caller() or core.is_member('ops')) then
    raise exception 'ops module membership is required to act on a bulk edit suggestion'
      using errcode = '42501';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a bulk edit suggestion must contain at least one item' using errcode = '42501';
  end if;

  insert into ops.task_edit_batches (requested_by, reason)
  values (core.auth_user_id(), p_reason)
  returning * into v_batch;

  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'each item of a bulk edit suggestion must be an object' using errcode = '42501';
    end if;
    if not (v_item ? 'task_id') then
      raise exception 'each item of a bulk edit suggestion must name a task_id' using errcode = '42501';
    end if;

    for v_key in select jsonb_object_keys(v_item) loop
      if v_key not in ('task_id', 'title', 'description', 'task_type_id', 'owner_user_id', 'client_ref') then
        raise exception
          'a bulk edit suggestion may only propose title, description, task_type_id, owner_user_id or '
          'client_ref; item carried "%"', v_key
          using errcode = '42501';
      end if;
    end loop;

    if not (v_item ? 'title' or v_item ? 'description' or v_item ? 'task_type_id'
            or v_item ? 'owner_user_id' or v_item ? 'client_ref') then
      raise exception 'each item of a bulk edit suggestion must propose a change to at least one field'
        using errcode = '42501';
    end if;

    -- KEY PRESENCE, not value, decides `change_*` -- `v_item ? 'title'`
    -- rather than a null test on the value, exactly like the API's zod
    -- `.optional()` and the table's own `change_*` flags: sending
    -- `"description": null` is proposing to CLEAR the description, which
    -- is a real, intentional change and must not be read as "not
    -- proposing anything". `->>` on a JSON null yields SQL NULL, which
    -- is precisely the value we want stored.
    --
    -- The child carries the batch's ONE reason. Chan asked for a single
    -- note over the whole suggestion ("like an edit feature on google
    -- docs"), and ops.task_edit_requests.reason is NOT NULL with a
    -- >= 10-char floor -- so the batch's reason is what each item's
    -- reason is, and a child read on its own still explains itself.
    insert into ops.task_edit_requests (
      batch_id, task_id, requested_by, reason,
      change_title,         proposed_title,
      change_description,   proposed_description,
      change_task_type_id,  proposed_task_type_id,
      change_owner_user_id, proposed_owner_user_id,
      change_client_ref,    proposed_client_ref
    ) values (
      v_batch.id, (v_item ->> 'task_id')::uuid, v_batch.requested_by, p_reason,
      v_item ? 'title',          v_item ->> 'title',
      v_item ? 'description',    v_item ->> 'description',
      v_item ? 'task_type_id',  (v_item ->> 'task_type_id')::uuid,
      v_item ? 'owner_user_id', (v_item ->> 'owner_user_id')::uuid,
      v_item ? 'client_ref',     v_item ->> 'client_ref'
    );
  end loop;

  return v_batch;
end;
$$;

-- ---------------------------------------------------------------------
-- Part 6 -- ops.decide_edit_batch: all of it, or none of it.
--
-- Read the header's ATOMICITY section for why there is no exception
-- handler in this function and why it drives the existing per-row
-- trigger instead of applying anything itself.
-- ---------------------------------------------------------------------
create or replace function ops.decide_edit_batch(
  p_batch_id uuid,
  p_approve  boolean,
  p_reason   text default null
)
returns ops.task_edit_batches
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_batch          ops.task_edit_batches;
  v_status         ops.edit_request_status;
  v_child_count    int;
  v_decided_count  int;
  v_actor_email    text;
  v_actor_authority core.authority;
begin
  -- Read-only first, ahead of every other bypass (core.is_read_only()'s
  -- own comment: it must precede is_system_caller()/is_admin(), because
  -- a read-only founder's `founder` authority satisfies is_founder()).
  if core.is_read_only() then
    raise exception 'a read-only account may not decide a bulk edit suggestion' using errcode = '42501';
  end if;

  -- MEMBERSHIP, asked explicitly because SECURITY DEFINER does not ask it
  -- for us. Every policy on ops.task_edit_batches / ops.task_edit_requests
  -- carries `core.is_member('ops')`, but this function runs as the table
  -- owner, for whom RLS is not enforced -- so the policy clause does NOT
  -- apply to the writes below. `core.is_founder()` reads authority alone
  -- and would otherwise let a founder outside the ops module act on the
  -- ops week's committed record. The API's requireMembership('ops') hook
  -- says the same thing one layer up; this is the layer that counts.
  if not (core.is_system_caller() or core.is_member('ops')) then
    raise exception 'ops module membership is required to act on a bulk edit suggestion'
      using errcode = '42501';
  end if;

  -- `for update`: the authority and status checks below read this row and
  -- then act on it. Without the lock that is a read-committed TOCTOU
  -- window and two approvers could both pass the pending check
  -- (20260909190000 is the precedent this project already paid for).
  select * into v_batch from ops.task_edit_batches where id = p_batch_id for update;
  if v_batch.id is null then
    raise exception 'unknown bulk edit suggestion' using errcode = 'P0002';
  end if;

  if v_batch.status <> 'pending' then
    raise exception 'this bulk edit suggestion has already been decided (%)', v_batch.status
      using errcode = '42501';
  end if;

  -- Chan, 2026-09-10: "then approve by admin or founder". See this
  -- file's header: this SUPERSEDES the clearing-founder rule recorded in
  -- 20260910140000, and `and not core.is_read_only()` is written out
  -- because is_founder() -- unlike is_clearing_founder() -- does not
  -- exclude ERC/DCA structurally.
  if not (core.is_system_caller() or (core.is_founder() and not core.is_read_only())) then
    raise exception 'only a founder or admin may decide a bulk edit suggestion' using errcode = '42501';
  end if;

  -- The self-approval guard, preserved from the single-request path.
  if not core.is_system_caller() and v_batch.requested_by = core.auth_user_id() then
    raise exception 'the requester may not approve or reject their own bulk edit suggestion'
      using errcode = '42501';
  end if;

  v_status := case when p_approve then 'approved' else 'rejected' end;

  if not p_approve and (p_reason is null or length(trim(p_reason)) < 10) then
    raise exception 'rejecting a bulk edit suggestion requires a written reason of at least 10 characters'
      using errcode = '42501';
  end if;

  select count(*) into v_child_count from ops.task_edit_requests where batch_id = p_batch_id;
  if v_child_count = 0 then
    raise exception 'this bulk edit suggestion has no items, so there is nothing to decide'
      using errcode = '42501';
  end if;

  -- The gate that lets the two guards above (the child's and the
  -- batch's) tell "the batch function is deciding this" apart from "a
  -- caller is picking off one row". Transaction-scoped, and cleared
  -- again the moment the last write is done -- see the header.
  perform set_config('ops.deciding_edit_batch', p_batch_id::text, true);

  -- THE apply. One statement, N children, driving the ONE existing
  -- per-row trigger: it applies each change to ops.tasks, stamps each
  -- child's after_values, and audits each decision. No second apply
  -- path exists. Any child that refuses (its task cleared or cancelled
  -- since the suggestion was raised, its task deleted, a proposed
  -- task_type_id or owner that no longer exists) raises, and because
  -- nothing here catches it, the batch row above, every sibling's
  -- applied change and this statement all unwind together.
  update ops.task_edit_requests
     set status = v_status,
         decision_reason = p_reason
   where batch_id = p_batch_id;
  get diagnostics v_decided_count = row_count;

  -- Belt and braces on the count: the `for update` lock above is taken
  -- on the BATCH, not on its children, so a child inserted or removed
  -- between the count and the update would go unnoticed. Refusing is the
  -- only honest answer -- reporting success over a batch whose item set
  -- changed underneath the decision is exactly the lie this function
  -- exists to make impossible.
  if v_decided_count <> v_child_count then
    raise exception
      'this bulk edit suggestion changed while it was being decided (% items when read, % decided); nothing was applied',
      v_child_count, v_decided_count
      using errcode = '40001';
  end if;

  update ops.task_edit_batches
     set status = v_status,
         decided_by = core.auth_user_id(),
         decided_at = now(),
         decision_reason = p_reason
   where id = p_batch_id
  returning * into v_batch;

  perform set_config('ops.deciding_edit_batch', '', true);

  select u.email, u.authority into v_actor_email, v_actor_authority
  from core.users u where u.id = core.auth_user_id();

  -- One audit row for the decision as a whole, ON TOP OF the per-item
  -- rows the child trigger already wrote. Both matter: the item rows say
  -- what changed on each task, this row says a person approved N of them
  -- at once and why -- and the item count is in it, so an incomplete
  -- apply could not look complete in the trail either.
  insert into core.audit_logs
    (actor_id, actor_email, actor_authority, module, action, entity_type, entity_id, old_values, new_values)
  values
    (core.auth_user_id(), v_actor_email, v_actor_authority, 'ops',
     case v_status when 'approved' then 'ops.task_edit_batch.approved'
                   else 'ops.task_edit_batch.rejected' end,
     'ops.task_edit_batch', v_batch.id,
     jsonb_build_object('status', 'pending', 'requested_by', v_batch.requested_by,
                        'reason', v_batch.reason, 'item_count', v_child_count),
     jsonb_build_object('status', v_status, 'decision_reason', p_reason, 'item_count', v_decided_count));

  return v_batch;
end;
$$;

-- ---------------------------------------------------------------------
-- Part 7 -- ops.withdraw_edit_batch.
--
-- WHY IT EXISTS. Part 4 refuses an individual decision on a batch child,
-- withdrawal included -- so without this a requester who thought better
-- of a submitted suggestion would have no way out, and
-- `ops.task_edit_requests` gained `withdrawn` in the first place because
-- "a requester may legitimately think better of their own request before
-- anyone acts on it" (20260910140000's header). A batch keeps that.
-- Applies nothing to any task by construction: `withdrawn` is the one
-- status the child trigger has no apply branch for.
-- ---------------------------------------------------------------------
create or replace function ops.withdraw_edit_batch(p_batch_id uuid)
returns ops.task_edit_batches
language plpgsql
security definer
set search_path = ops, core, public
as $$
declare
  v_batch ops.task_edit_batches;
  v_child_count   int;
  v_decided_count int;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not act on a bulk edit suggestion' using errcode = '42501';
  end if;

  -- MEMBERSHIP, asked explicitly because SECURITY DEFINER does not ask it
  -- for us. Every policy on ops.task_edit_batches / ops.task_edit_requests
  -- carries `core.is_member('ops')`, but this function runs as the table
  -- owner, for whom RLS is not enforced -- so the policy clause does NOT
  -- apply to the writes below. `core.is_founder()` reads authority alone
  -- and would otherwise let a founder outside the ops module act on the
  -- ops week's committed record. The API's requireMembership('ops') hook
  -- says the same thing one layer up; this is the layer that counts.
  if not (core.is_system_caller() or core.is_member('ops')) then
    raise exception 'ops module membership is required to act on a bulk edit suggestion'
      using errcode = '42501';
  end if;

  select * into v_batch from ops.task_edit_batches where id = p_batch_id for update;
  if v_batch.id is null then
    raise exception 'unknown bulk edit suggestion' using errcode = 'P0002';
  end if;
  if v_batch.status <> 'pending' then
    raise exception 'this bulk edit suggestion has already been decided (%)', v_batch.status
      using errcode = '42501';
  end if;

  -- Same identity rule as a single request's withdrawal: the requester,
  -- or admin/system. An approver does not withdraw somebody's
  -- suggestion; they reject it, with a written reason.
  if not (core.is_system_caller() or core.is_admin() or v_batch.requested_by = core.auth_user_id()) then
    raise exception 'only the requester may withdraw their own bulk edit suggestion' using errcode = '42501';
  end if;

  select count(*) into v_child_count from ops.task_edit_requests where batch_id = p_batch_id;

  perform set_config('ops.deciding_edit_batch', p_batch_id::text, true);

  update ops.task_edit_requests set status = 'withdrawn' where batch_id = p_batch_id;
  get diagnostics v_decided_count = row_count;
  if v_decided_count <> v_child_count then
    raise exception 'this bulk edit suggestion changed while it was being withdrawn; nothing was changed'
      using errcode = '40001';
  end if;

  update ops.task_edit_batches
     set status = 'withdrawn', decided_by = core.auth_user_id(), decided_at = now()
   where id = p_batch_id
  returning * into v_batch;

  perform set_config('ops.deciding_edit_batch', '', true);

  return v_batch;
end;
$$;

-- ---------------------------------------------------------------------
-- Part 8 -- RLS and grants.
--
-- Reads: any ops member, the same "everyone is in the loop" rule
-- (PRD.md §6.1) that ops.tasks and ops.task_edit_requests already use --
-- a suggestion about the week's committed work is not private
-- correspondence between a GM and a founder.
--
-- Writes: the policy layer stays thin (`is_member('ops') and not
-- is_read_only()`) and the triggers above are the real gate, the same
-- division of labour as ops.tasks / ops.task_notes /
-- ops.task_edit_requests. Note that the three functions above are
-- SECURITY DEFINER and therefore run as the table owner, for whom RLS is
-- not enforced -- so these policies are what governs a DIRECT PostgREST
-- write, and every such write is refused by Part 3's GUC check anyway.
-- The policies are kept regardless: a table with RLS enabled and no
-- policy is a table nobody can read, and defence in depth here costs
-- nothing.
--
-- No DELETE policy, matching ops.task_edit_requests, ops.task_notes,
-- ops.point_ledger and core.audit_logs: a decided suggestion is part of
-- the record of what happened to the locked Monday commitment.
-- ---------------------------------------------------------------------
alter table ops.task_edit_batches enable row level security;

create policy task_edit_batches_select on ops.task_edit_batches for select to authenticated
using (core.is_member('ops'));

create policy task_edit_batches_insert on ops.task_edit_batches for insert to authenticated
with check (core.is_member('ops') and not core.is_read_only());

create policy task_edit_batches_update on ops.task_edit_batches for update to authenticated
using (core.is_member('ops') and not core.is_read_only())
with check (core.is_member('ops') and not core.is_read_only());

-- EXECUTE to `authenticated`, deliberately -- and NOT via the service
-- role. 20260909130000 is the precedent and its reasoning applies
-- verbatim: these functions are called from `apps/api` through
-- `userClient` ON PURPOSE, so each one's own
-- `core.is_founder() / core.is_oversight() / core.is_read_only()` guard
-- is evaluated against the real signed-in caller instead of being
-- bypassed by the service role. Routing them through the service client
-- would move the authorization decision out of the database and into
-- application code -- the exact mistake this schema exists to avoid, and
-- the one RLS cannot cover on a service-role connection
-- (`core.auth_user_id()` is null there, so `core.is_read_only()` returns
-- false for everyone).
revoke all on function ops.create_edit_batch(text, jsonb)          from public;
revoke all on function ops.decide_edit_batch(uuid, boolean, text)  from public;
revoke all on function ops.withdraw_edit_batch(uuid)               from public;

grant execute on function ops.create_edit_batch(text, jsonb)         to authenticated, service_role;
grant execute on function ops.decide_edit_batch(uuid, boolean, text) to authenticated, service_role;
grant execute on function ops.withdraw_edit_batch(uuid)              to authenticated, service_role;

comment on function ops.decide_edit_batch(uuid, boolean, text) is
  'Approve or reject a bulk edit suggestion, all-or-nothing. Sets every '
  'child ops.task_edit_requests row''s status and lets the existing '
  'per-row trigger apply each change, so there is exactly one apply path '
  'and it is the proven one. Contains no exception handler: any child''s '
  'refusal unwinds the entire decision. Founder or admin only (Chan, '
  '2026-09-10: "approve by admin or founder"), never a read-only '
  'account, never the requester.';
