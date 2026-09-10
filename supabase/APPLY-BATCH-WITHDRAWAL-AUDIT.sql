-- =====================================================================
-- LRA Global Ops :: a withdrawn batch leaves a batch-level audit row
--
-- WHAT WAS WRONG. 20260910200000 gave `ops.decide_edit_batch` an audit
-- row for the decision as a whole -- "a person approved N of these at
-- once, and why" -- on top of the per-item rows the child trigger
-- writes. `ops.withdraw_edit_batch` got the per-item rows and no
-- batch-level row at all.
--
-- HOW IT WAS FOUND. Driving the full round trip in a browser on
-- 2026-09-10 and then reading /admin/audit as an admin: filtering the
-- timeline to entity type `ops.task_edit_batch` returned the two
-- approvals and the rejection, and NOTHING for the batch that had been
-- withdrawn a minute earlier. The withdrawal existed in the trail only
-- as `ops.task_edit_request.withdrawn` rows, scattered among every other
-- item-level row, none of which says a batch was pulled, by whom, or how
-- many items it held.
--
-- WHY IT MATTERS HERE SPECIFICALLY. This system exists so that the
-- record of what people committed to cannot be quietly rewritten
-- afterwards. "Raised a batch of edits to the locked Monday record and
-- then quietly pulled it" is precisely the shape that must not be the
-- one action with no batch-level row -- and it was.
--
-- WHAT THIS CHANGES. `create or replace` on ops.withdraw_edit_batch,
-- byte-identical to 20260910200000's except for the two new declarations
-- and the audit insert at the end. No table, policy, trigger or other
-- function is touched.
--
-- FORWARD-ONLY, DELIBERATELY. Batches withdrawn before this migration
-- stay without a batch-level row. Writing one now would put a timestamp
-- and an actor on the record that this database did not observe at the
-- time -- a fabricated audit entry, in the audit log, in the one system
-- built to make the record unforgeable. The gap is the honest answer.
-- =====================================================================

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
  v_actor_email     text;
  v_actor_authority core.authority;
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

  select u.email, u.authority into v_actor_email, v_actor_authority
  from core.users u where u.id = core.auth_user_id();

  -- One audit row for the withdrawal as a whole, matching the one
  -- ops.decide_edit_batch writes for an approval or a rejection.
  --
  -- It was missing, and the asymmetry was visible on /admin/audit:
  -- filtering the timeline to `ops.task_edit_batch` showed the approvals
  -- and the rejection and NOTHING for a batch that had been withdrawn.
  -- The per-item `ops.task_edit_request.withdrawn` rows were there, but
  -- scattered among every other item-level row and carrying no statement
  -- that a batch of N was pulled, by whom, or how big it was. In a system
  -- whose whole point is that the record of what happened cannot be
  -- quietly rewritten, "raised a batch and quietly pulled it" is exactly
  -- the shape that must not be the one action with no batch-level row.
  --
  -- No `decision_reason`: a withdrawal is the requester changing their
  -- own mind, not a decision made about them, and ops.task_edit_batches
  -- does not ask for one. `item_count` is carried for the same reason
  -- the decision row carries it -- so a partial withdrawal could not look
  -- complete in the trail either.
  insert into core.audit_logs
    (actor_id, actor_email, actor_authority, module, action, entity_type, entity_id, old_values, new_values)
  values
    (core.auth_user_id(), v_actor_email, v_actor_authority, 'ops',
     'ops.task_edit_batch.withdrawn',
     'ops.task_edit_batch', v_batch.id,
     jsonb_build_object('status', 'pending', 'requested_by', v_batch.requested_by,
                        'reason', v_batch.reason, 'item_count', v_child_count),
     jsonb_build_object('status', 'withdrawn', 'item_count', v_decided_count));

  return v_batch;
end;
$$;
