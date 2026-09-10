/**
 * The client-side permission mirror is access-control-shaped code, so it
 * gets tested like access-control code (CLAUDE.md). What these assert is
 * that the mirror agrees with `ops.enforce_task_transition` — the
 * database function in
 * supabase/migrations/20260909150300_ops_cancellation_approval.sql — for
 * every rung of the ladder the board can express.
 *
 * The mirror is allowed to be STRICTER than the trigger (it would only
 * hide a legal move, which is a UI bug, not a hole). It must never be
 * looser: a `null` here that the trigger would refuse is a card that
 * flies into a column and snaps back, which is the exact defect this
 * module exists to prevent.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  blockResolveRefusal,
  canDragTask,
  definitionLockRefusal,
  dragRefusal,
  moveRefusal,
  noteRefusal,
  type Actor,
  type MovableTask,
  type ResolvableBlock,
} from './task-permissions';

const ALL_COLUMNS = [
  'backlog',
  'this_week',
  'in_progress',
  'blocked',
  'submitted',
  'verified',
  'cleared',
] as const;

const SALES: Actor = { id: 'u-sales', authority: 'staff', isClearingFounder: false, readOnly: false };
const BROKER: Actor = { id: 'u-broker', authority: 'staff', isClearingFounder: false, readOnly: false };
const GM: Actor = { id: 'u-gm', authority: 'gm', isClearingFounder: false, readOnly: false };
const FOUNDER: Actor = { id: 'u-founder', authority: 'founder', isClearingFounder: true, readOnly: false };
const OTHER_FOUNDER: Actor = {
  id: 'u-founder-2',
  authority: 'founder',
  isClearingFounder: false,
  readOnly: false,
};
const ADMIN: Actor = { id: 'u-admin', authority: 'admin', isClearingFounder: false, readOnly: false };
// ERC / DCA: a strictly read-only founder — same authority as FOUNDER,
// same isClearingFounder shape as a non-seated founder, but must be
// refused everything a plain staff member would be allowed.
const READ_ONLY_FOUNDER: Actor = {
  id: 'u-erc',
  authority: 'founder',
  isClearingFounder: false,
  readOnly: true,
};

function task(over: Partial<MovableTask> = {}): MovableTask {
  return {
    status: 'todo',
    owner_user_id: 'u-sales',
    ownerPosition: 'sales',
    task_type_id: 'type-1',
    openBlockCount: 0,
    ...over,
  };
}

const allowed = (t: MovableTask, a: Actor) =>
  ALL_COLUMNS.filter((c) => moveRefusal(t, c, a) === null).sort();

test('an owner moves their own todo forward, but cannot verify or clear it', () => {
  assert.deepEqual(allowed(task(), SALES), ['backlog', 'blocked', 'in_progress', 'submitted']);
});

test('a peer cannot move someone else’s task, but can still flag it as blocked', () => {
  // `task_blocks_insert` grants any ops member; the ladder guards only
  // the status change, which the broker is refused here. `backlog` is
  // in the list only because it is where the card already sits — a drop
  // back into its own column is a no-op, not a move (see `dragRefusal`).
  assert.deepEqual(allowed(task(), BROKER), ['backlog', 'blocked']);
  assert.match(moveRefusal(task(), 'in_progress', BROKER) ?? '', /owner or a GM\/founder/);
});

test('an unpriced task cannot be submitted — the trigger requires a catalog type', () => {
  const t = task({ task_type_id: null });
  assert.match(moveRefusal(t, 'submitted', SALES) ?? '', /catalog type/);
  assert.equal(moveRefusal(t, 'in_progress', SALES), null);
});

test('a GM verifies a staff member’s submitted task; the owner never verifies their own', () => {
  const submitted = task({ status: 'submitted' });
  assert.equal(moveRefusal(submitted, 'verified', GM), null);
  assert.match(moveRefusal(submitted, 'verified', SALES) ?? '', /can’t verify your own/);
  assert.match(moveRefusal(submitted, 'verified', BROKER) ?? '', /Only a GM verifies/);
});

test('a GM’s OWN submitted task needs a founder, not a GM', () => {
  const gmTask = task({ status: 'submitted', owner_user_id: 'u-gm', ownerPosition: 'gm' });
  assert.match(moveRefusal(gmTask, 'verified', GM) ?? '', /can’t verify your own/);
  assert.equal(moveRefusal(gmTask, 'verified', FOUNDER), null);
});

test('only the CLEARING founder clears — a second founder is refused', () => {
  const verified = task({ status: 'verified' });
  assert.equal(moveRefusal(verified, 'cleared', FOUNDER), null);
  assert.match(moveRefusal(verified, 'cleared', OTHER_FOUNDER) ?? '', /clearing founder/);
  assert.match(moveRefusal(verified, 'cleared', GM) ?? '', /clearing founder/);
  assert.match(moveRefusal(verified, 'cleared', SALES) ?? '', /clearing founder/);
});

test('a verified task cannot be dragged backwards — sending it back needs a reason', () => {
  const verified = task({ status: 'verified' });
  assert.notEqual(moveRefusal(verified, 'submitted', FOUNDER), null);
  assert.notEqual(moveRefusal(verified, 'backlog', FOUNDER), null);
});

test('a submitted task is retracted by its owner or a GM, nobody else', () => {
  const submitted = task({ status: 'submitted' });
  assert.equal(moveRefusal(submitted, 'in_progress', SALES), null);
  assert.equal(moveRefusal(submitted, 'in_progress', GM), null);
  assert.notEqual(moveRefusal(submitted, 'in_progress', BROKER), null);
});

test('terminal tasks move nowhere, for anyone but admin', () => {
  for (const status of ['cleared', 'cancelled']) {
    const t = task({ status });
    assert.deepEqual(allowed(t, FOUNDER), []);
    assert.deepEqual(allowed(t, GM), []);
    assert.equal(canDragTask(t, [...ALL_COLUMNS], FOUNDER), false);
    assert.match(dragRefusal(t, [...ALL_COLUMNS], FOUNDER) ?? '', /closed/);
  }
});

test('a task awaiting a cancellation decision is pinned, even for the clearing founder', () => {
  // The decision itself is made in Approvals, where the reason can be
  // written; a bare drag could never satisfy the trigger's reason check.
  const t = task({ status: 'pending_cancellation' });
  assert.equal(canDragTask(t, [...ALL_COLUMNS], FOUNDER), false);
  assert.match(dragRefusal(t, [...ALL_COLUMNS], FOUNDER) ?? '', /cancellation decision/);
});

test('a blocked task is pinned until its block is resolved, and says so', () => {
  const t = task({ status: 'in_progress', openBlockCount: 1 });
  assert.equal(canDragTask(t, [...ALL_COLUMNS], SALES), false);
  assert.match(dragRefusal(t, [...ALL_COLUMNS], SALES) ?? '', /Resolve the block first/);
  // And it cannot be blocked twice.
  assert.match(moveRefusal(t, 'blocked', SALES) ?? '', /already blocked/);
});

test('This week is never a drop target — commitments are made in the briefing', () => {
  for (const a of [SALES, GM, FOUNDER]) {
    assert.match(moveRefusal(task(), 'this_week', a) ?? '', /Monday briefing/);
  }
});

test('admin bypasses the ladder, exactly as the trigger does', () => {
  assert.equal(moveRefusal(task({ status: 'verified' }), 'cleared', ADMIN), null);
  assert.equal(moveRefusal(task({ status: 'submitted', owner_user_id: 'u-admin' }), 'verified', ADMIN), null);
});

test('a signed-out caller is refused everything', () => {
  assert.equal(canDragTask(task(), [...ALL_COLUMNS], null), false);
});

test('a read-only founder is refused every move, even one an oversight actor would otherwise get', () => {
  assert.deepEqual(allowed(task(), READ_ONLY_FOUNDER), []);
  assert.equal(canDragTask(task(), [...ALL_COLUMNS], READ_ONLY_FOUNDER), false);
  assert.match(dragRefusal(task(), [...ALL_COLUMNS], READ_ONLY_FOUNDER) ?? '', /read-only/);
});

test('read-only refuses even a clearing-eligible verified task, and beats the admin bypass', () => {
  const verified = task({ status: 'verified' });
  assert.match(moveRefusal(verified, 'cleared', READ_ONLY_FOUNDER) ?? '', /read-only/);
  // Sanity: the same actor shape with readOnly false (a real founder)
  // would not be refused by this rule at all — proves the assertion
  // above is about read-only, not about founder-ness.
  assert.equal(moveRefusal(verified, 'cleared', OTHER_FOUNDER)?.includes('read-only'), false);
});

test('dragRefusal prefers a task-specific reason over the universal ones', () => {
  // Every column refuses a cleared task; the reason surfaced must be the
  // one about THIS task, not "This week is set in the briefing".
  const reason = dragRefusal(task({ status: 'cleared' }), [...ALL_COLUMNS], SALES);
  assert.ok(reason && !reason.includes('Monday briefing'));
});

// ---------------------------------------------------------------------
// definitionLockRefusal — mirrors `ops.enforce_task_transition`'s guard
// 2b (20260910140000_ops_task_edit_requests.sql). Asserted against the
// same actor fixtures the ladder above uses.
// ---------------------------------------------------------------------

test('an uncommitted task is never definition-locked, whatever the week state', () => {
  assert.equal(definitionLockRefusal({ is_committed: false }, 'open', SALES), null);
  assert.equal(definitionLockRefusal({ is_committed: false }, 'closed', GM), null);
});

test('a committed task in a still-planning week is not locked', () => {
  assert.equal(definitionLockRefusal({ is_committed: true }, 'planning', SALES), null);
  assert.equal(definitionLockRefusal({ is_committed: true }, null, SALES), null);
});

test('once committed and the week has left planning, staff and GM are refused — the exact trigger sentence', () => {
  const staffRefusal = definitionLockRefusal({ is_committed: true }, 'open', SALES);
  const gmRefusal = definitionLockRefusal({ is_committed: true }, 'open', GM);
  assert.match(staffRefusal ?? '', /locked once the week has left planning/);
  assert.match(staffRefusal ?? '', /ask the GM to raise a task edit request/);
  assert.equal(staffRefusal, gmRefusal);
});

test('founder and admin bypass the definition lock — is_founder(), not is_oversight()', () => {
  assert.equal(definitionLockRefusal({ is_committed: true }, 'open', FOUNDER), null);
  assert.equal(definitionLockRefusal({ is_committed: true }, 'closed', ADMIN), null);
  // A non-clearing founder still bypasses — the lock's exemption is
  // is_founder(), not is_clearing_founder().
  assert.equal(definitionLockRefusal({ is_committed: true }, 'open', OTHER_FOUNDER), null);
});

test('a read-only founder (ERC/DCA) is still locked out — founder authority alone is not the exemption', () => {
  assert.notEqual(definitionLockRefusal({ is_committed: true }, 'open', READ_ONLY_FOUNDER), null);
});

test('no signed-in actor: the lock still applies (a null actor never bypasses)', () => {
  assert.notEqual(definitionLockRefusal({ is_committed: true }, 'open', null), null);
});

// ---------------------------------------------------------------------
// blockResolveRefusal — the mirror of ops.task_blocks_update
// ---------------------------------------------------------------------
//
// Chan, 2026-09-10: "users cant unblock a task, fix it." The bug was a
// mirror that did not match the policy in EITHER direction, so these
// tests are written against the policy's four allowed identities
// (created_by, blocking_user_id, is_oversight, and the task owner the
// 20260910190000 migration adds), not against what the old UI did.

const RAISER: Actor = { id: 'u-raiser', authority: 'staff', isClearingFounder: false, readOnly: false };
const NAMED: Actor = { id: 'u-named', authority: 'staff', isClearingFounder: false, readOnly: false };
const OWNER: Actor = { id: 'u-owner', authority: 'staff', isClearingFounder: false, readOnly: false };
const BYSTANDER: Actor = { id: 'u-bystander', authority: 'staff', isClearingFounder: false, readOnly: false };

const blockOn = (over: Partial<ResolvableBlock> = {}): ResolvableBlock => ({
  created_by: RAISER.id,
  blocking_user_id: NAMED.id,
  ...over,
});
const ownedTask = { owner_user_id: OWNER.id };

test('the person who declared the block may resolve it — created_by = core.auth_user_id()', () => {
  assert.equal(blockResolveRefusal(blockOn(), ownedTask, RAISER), null);
});

test('the person the block names may resolve it — blocking_user_id = core.auth_user_id()', () => {
  assert.equal(blockResolveRefusal(blockOn(), ownedTask, NAMED), null);
});

test('the blocked task’s owner may resolve it — the migration’s fourth branch, and Chan’s actual report', () => {
  assert.equal(blockResolveRefusal(blockOn(), ownedTask, OWNER), null);
});

test('oversight may resolve any block — core.is_oversight() is gm, founder, admin', () => {
  assert.equal(blockResolveRefusal(blockOn(), ownedTask, GM), null);
  assert.equal(blockResolveRefusal(blockOn(), ownedTask, FOUNDER), null);
  assert.equal(blockResolveRefusal(blockOn(), ownedTask, OTHER_FOUNDER), null);
  assert.equal(blockResolveRefusal(blockOn(), ownedTask, ADMIN), null);
});

test('a staff bystander is refused, and told who can', () => {
  const refusal = blockResolveRefusal(blockOn(), ownedTask, BYSTANDER);
  assert.match(refusal ?? '', /raised this block/);
  assert.match(refusal ?? '', /owner/);
  assert.match(refusal ?? '', /GM\/founder/);
});

test('an external block (no blocking_user_id) is still resolvable by its raiser and the owner, not by a bystander', () => {
  const external = blockOn({ blocking_user_id: null });
  assert.equal(blockResolveRefusal(external, ownedTask, RAISER), null);
  assert.equal(blockResolveRefusal(external, ownedTask, OWNER), null);
  assert.notEqual(blockResolveRefusal(external, ownedTask, BYSTANDER), null);
});

test('a null blocking_user_id never matches a signed-in actor by accident', () => {
  // Guards the shape of the check itself: `null === actor.id` must not
  // be reachable through a stray falsy comparison.
  const external = blockOn({ created_by: RAISER.id, blocking_user_id: null });
  assert.notEqual(blockResolveRefusal(external, { owner_user_id: 'u-someone-else' }, BYSTANDER), null);
});

test('read-only is checked FIRST — a read-only founder resolves nothing, even a block they raised', () => {
  // `not core.is_read_only()` wraps the whole disjunction in the
  // policy, so it cannot be reached through any of the four branches.
  assert.match(blockResolveRefusal(blockOn(), ownedTask, READ_ONLY_FOUNDER) ?? '', /read-only/);
  assert.match(
    blockResolveRefusal(blockOn({ created_by: READ_ONLY_FOUNDER.id }), ownedTask, READ_ONLY_FOUNDER) ?? '',
    /read-only/
  );
  assert.match(
    blockResolveRefusal(blockOn({ blocking_user_id: READ_ONLY_FOUNDER.id }), ownedTask, READ_ONLY_FOUNDER) ?? '',
    /read-only/
  );
  assert.match(
    blockResolveRefusal(blockOn(), { owner_user_id: READ_ONLY_FOUNDER.id }, READ_ONLY_FOUNDER) ?? '',
    /read-only/
  );
});

test('nobody signed in resolves nothing', () => {
  assert.match(blockResolveRefusal(blockOn(), ownedTask, null) ?? '', /not signed in/);
});

// ---------------------------------------------------------------------
// noteRefusal — the mirror of ops.enforce_task_note_insert
// (20260910120100_core_read_only_accounts.sql:822). One assertion per
// branch of the trigger, in the trigger's own order, the same discipline
// moveRefusal is held to above.
// ---------------------------------------------------------------------

const notable = (over: Partial<{ owner_user_id: string; status: string }> = {}) => ({
  owner_user_id: OWNER.id,
  status: 'in_progress',
  ...over,
});

test('noteRefusal: nobody signed in writes nothing', () => {
  assert.notEqual(noteRefusal(notable(), null), null);
});

test('noteRefusal: read-only is refused FIRST, ahead of every other branch', () => {
  // Even on their own task, and even though a read-only account is a
  // founder and would otherwise pass the oversight branch below.
  assert.match(noteRefusal(notable(), READ_ONLY_FOUNDER) ?? '', /read-only/);
  assert.match(
    noteRefusal(notable({ owner_user_id: READ_ONLY_FOUNDER.id }), READ_ONLY_FOUNDER) ?? '',
    /read-only/
  );
});

test('noteRefusal: admin bypasses, including on a closed task', () => {
  assert.equal(noteRefusal(notable(), ADMIN), null);
  assert.equal(noteRefusal(notable({ status: 'cleared' }), ADMIN), null);
});

test('noteRefusal: a closed task takes no new notes, owner or not', () => {
  for (const status of ['cleared', 'cancelled']) {
    assert.match(noteRefusal(notable({ status }), OWNER) ?? '', /closed|cleared|cancelled/);
    assert.match(noteRefusal(notable({ status }), GM) ?? '', /closed|cleared|cancelled/);
  }
});

test('noteRefusal: the task owner may add a note', () => {
  assert.equal(noteRefusal(notable(), OWNER), null);
});

test('noteRefusal: oversight may add a note to anyone’s task', () => {
  assert.equal(noteRefusal(notable(), GM), null);
  assert.equal(noteRefusal(notable(), FOUNDER), null);
});

test('noteRefusal: a staff bystander is refused, and told who can', () => {
  const reason = noteRefusal(notable(), BYSTANDER) ?? '';
  assert.notEqual(reason, '');
  assert.match(reason, /owner|GM|founder/);
});
