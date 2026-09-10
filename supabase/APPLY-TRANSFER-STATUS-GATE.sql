-- =====================================================================
-- LRA Global Ops :: you cannot hand off work after you have claimed it done
--
-- THE HOLE. `ops.enforce_task_transfer_invite()` and
-- `ops.accept_task_transfer()` (20260911120000) check WHO may transfer a
-- task -- read-only, ops membership, current ownership, that the invitee
-- is active -- and never once check WHAT STATE THE TASK IS IN.
--
-- So the owner of a task the GM has already VERIFIED can hand it, through
-- the ordinary invite/accept flow, to a colleague who did none of the
-- work, moments before the founder clears it. `points_awarded` is stamped
-- at clearing and `ops.v_point_balances` groups by `owner_user_id` (it
-- never reads the ledger), so the points land on the person who received
-- the task, not the person who did the job.
--
-- That is the single attack this product most exists to prevent: awarding
-- yourself points you did not earn. It needs no API call -- the invite is
-- an ordinary RLS-checked INSERT, and both `apps/api` routes forward
-- verbatim with no status gate of their own -- and it walks straight
-- around the self-verification and self-clearance guards, because those
-- ask who is acting, not who benefits.
--
-- REPRODUCED on the local stack, rolled back, with the personas the
-- product actually has: broker does the work, the task reaches `verified`,
-- broker invites sales, sales accepts.
--     status_before      = verified
--     owner_is_now_sales = TRUE      <- the hole
--     promise_stayed     = TRUE      (committed_by_user_id is untouched,
--                                     which is correct and is not enough)
--
-- THE FIX. A transfer is only legitimate while the work is still being
-- WORKED. Allowed: `todo`, `in_progress`, `rejected` (rejected means it
-- has come back for rework, and handing that over is exactly the case
-- Chan described). Refused: `submitted` and `verified`, because at
-- `submitted` the owner has already CLAIMED the work is done and the
-- credit is in flight; and `pending_cancellation`, because a decision is
-- being made about the task and moving its subject mid-decision is its
-- own kind of rewrite. `cleared` and `cancelled` need no clause here --
-- `ops.freeze_cleared_task` already refuses every update to them, which
-- is the one boundary the hole never crossed.
--
-- GATED IN BOTH PLACES, DELIBERATELY. Checking only at invite time leaves
-- a race: invite while `in_progress`, submit, get verified, then accept.
-- `accept_task_transfer` re-reads the task `for update` and checks again,
-- so the state that matters is the state at the moment ownership actually
-- moves.
-- =====================================================================

create or replace function ops.enforce_task_transfer_invite()
returns trigger
language plpgsql
security definer
set search_path to 'ops', 'core', 'public'
as $fn$
declare
  v_owner uuid;
  v_status ops.task_status;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not invite a task transfer' using errcode = '42501';
  end if;

  if new.from_user_id is distinct from core.auth_user_id() then
    raise exception 'from_user_id must be the inviting user' using errcode = '42501';
  end if;

  if not core.is_member('ops') then
    raise exception 'ops module membership is required to transfer a task' using errcode = '42501';
  end if;

  select owner_user_id, status into v_owner, v_status from ops.tasks where id = new.task_id for share;
  if v_owner is null then
    raise exception 'an unassigned task has nothing to transfer -- claim it, or ask oversight to assign it'
      using errcode = '42501';
  end if;
  if v_owner is distinct from core.auth_user_id() then
    raise exception 'only the task''s current owner may invite someone else to take it over'
      using errcode = '42501';
  end if;

  -- THE STATUS GATE. See this migration's header for the exploit it closes.
  if v_status not in ('todo', 'in_progress', 'rejected') then
    raise exception
      'a task can only be handed over while it is still being worked (it is %). '
      'Once it has been submitted, the credit for it is already in flight.', v_status
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from core.memberships m
    join core.users u on u.id = m.user_id
    where m.user_id = new.to_user_id and m.module = 'ops' and m.is_active
      and u.is_active and u.deleted_at is null
  ) then
    raise exception 'the invited person must be an active ops member' using errcode = '42501';
  end if;

  if exists (
    select 1 from ops.task_assignment_invites
    where task_id = new.task_id and status = 'pending'
  ) then
    raise exception 'this task already has a pending transfer invite' using errcode = '42501';
  end if;

  new.status := 'pending';
  new.decided_at := null;

  insert into core.notification_outbox
    (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
  select new.to_user_id, 'ops', 'ops.task.transfer_invited', 'ops.task', new.task_id,
         'Someone wants to hand you a task', t.title, '/board'
  from ops.tasks t where t.id = new.task_id;

  return new;
end;
$fn$;

revoke execute on function ops.enforce_task_transfer_invite() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION ops.accept_task_transfer(p_invite_id uuid)
 RETURNS ops.tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'ops', 'core', 'public'
AS $function$
declare
  v_invite ops.task_assignment_invites%rowtype;
  v_task   ops.tasks%rowtype;
begin
  if core.is_read_only() then
    raise exception 'a read-only account may not accept a task transfer' using errcode = '42501';
  end if;

  if core.auth_user_id() is null then
    raise exception 'ops.accept_task_transfer must be called by a signed-in user' using errcode = '42501';
  end if;

  if not core.is_member('ops') then
    raise exception 'ops module membership is required to accept a task transfer' using errcode = '42501';
  end if;

  select * into v_invite from ops.task_assignment_invites where id = p_invite_id for update;
  if v_invite.id is null then
    raise exception 'unknown transfer invite %', p_invite_id using errcode = 'P0002';
  end if;

  if v_invite.to_user_id is distinct from core.auth_user_id() then
    raise exception 'only the invited person may accept this transfer' using errcode = '42501';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'this invite is no longer pending (%)', v_invite.status using errcode = '42501';
  end if;

  select * into v_task from ops.tasks where id = v_invite.task_id for update;
  if v_task.id is null then
    raise exception 'the task behind this invite no longer exists' using errcode = 'P0002';
  end if;

  -- STATUS GATE, at ACCEPTANCE time and not only at invite time. A task
  -- can be invited while it is still being worked and then submitted and
  -- verified before the invite is accepted; without this re-check, that
  -- window is the whole exploit. See the migration header.
  if v_task.status not in ('todo', 'in_progress', 'rejected') then
    raise exception
      'a task can only be handed over while it is still being worked (it is %). '
      'Once it has been submitted, the credit for it is already in flight.', v_task.status
      using errcode = '42501';
  end if;

  if v_task.owner_user_id is distinct from v_invite.from_user_id then
    raise exception 'this task has moved on since the invite was sent, and the invite is stale'
      using errcode = '42501';
  end if;

  perform set_config('ops.transfer_accept_task', v_task.id::text, true);

  update ops.tasks set owner_user_id = core.auth_user_id() where id = v_task.id
  returning * into v_task;

  perform set_config('ops.transfer_accept_task', '', true);

  update ops.task_assignment_invites
  set status = 'accepted', decided_at = now()
  where id = p_invite_id;

  -- Any OTHER pending invite on the same task is stale the instant this
  -- one is accepted -- the task has moved. Cancel them rather than
  -- leaving a ghost invite someone could stumble into "accepting" later
  -- (which ops.accept_task_transfer's own staleness check above would
  -- then refuse anyway, but a pending invite that can never succeed is
  -- a worse UI state than an honestly cancelled one).
  update ops.task_assignment_invites
  set status = 'cancelled', decided_at = now()
  where task_id = v_task.id and status = 'pending' and id <> p_invite_id;

  return v_task;
end;
$function$

;
