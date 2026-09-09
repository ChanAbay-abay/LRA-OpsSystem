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
import { canDragTask, dragRefusal, moveRefusal, type Actor, type MovableTask } from './task-permissions';

const ALL_COLUMNS = [
  'backlog',
  'this_week',
  'in_progress',
  'blocked',
  'submitted',
  'verified',
  'cleared',
] as const;

const SALES: Actor = { id: 'u-sales', authority: 'staff', isClearingFounder: false };
const BROKER: Actor = { id: 'u-broker', authority: 'staff', isClearingFounder: false };
const GM: Actor = { id: 'u-gm', authority: 'gm', isClearingFounder: false };
const FOUNDER: Actor = { id: 'u-founder', authority: 'founder', isClearingFounder: true };
const OTHER_FOUNDER: Actor = { id: 'u-founder-2', authority: 'founder', isClearingFounder: false };
const ADMIN: Actor = { id: 'u-admin', authority: 'admin', isClearingFounder: false };

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

test('dragRefusal prefers a task-specific reason over the universal ones', () => {
  // Every column refuses a cleared task; the reason surfaced must be the
  // one about THIS task, not "This week is set in the briefing".
  const reason = dragRefusal(task({ status: 'cleared' }), [...ALL_COLUMNS], SALES);
  assert.ok(reason && !reason.includes('Monday briefing'));
});
