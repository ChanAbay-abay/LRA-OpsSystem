/**
 * LRA Global Ops :: task-card-menu unit tests
 *
 * `buildTaskMenuItems` is the one place the card's right-click menu and
 * its 3-dot dropdown both get their content from (PLAN.md §10 #2). These
 * tests exercise that function directly — no DOM, no Radix — the same
 * level `task-permissions.test.ts` already tests `moveRefusal` at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskMenuItems } from './task-menu-items';
import type { Actor, MovableTask } from './task-permissions';

interface T extends MovableTask {
  id: string;
}

const OWNER: Actor = { id: 'owner-1', authority: 'staff', isClearingFounder: false, readOnly: false };
const OTHER_STAFF: Actor = { id: 'staff-2', authority: 'staff', isClearingFounder: false, readOnly: false };
const GM: Actor = { id: 'gm-1', authority: 'gm', isClearingFounder: false, readOnly: false };
const READ_ONLY_FOUNDER: Actor = { id: 'ro-1', authority: 'founder', isClearingFounder: false, readOnly: true };

function task(overrides: Partial<T> = {}): T {
  return {
    id: 't1',
    status: 'todo',
    owner_user_id: OWNER.id,
    ownerPosition: 'sales',
    task_type_id: 'catalog-1',
    openBlockCount: 0,
    ...overrides,
  };
}

function allHandlers(calls: string[]) {
  return {
    onSubmit: () => calls.push('submit'),
    onTakeBack: () => calls.push('take-back'),
    onRework: () => calls.push('rework'),
    onDeclareBlock: () => calls.push('block'),
    onResolveBlock: () => calls.push('resolve-block'),
    onOpen: () => calls.push('open'),
  };
}

test('a read-only actor gets no write items at all, only Open task', () => {
  const items = buildTaskMenuItems(task(), READ_ONLY_FOUNDER, allHandlers([]));
  assert.deepEqual(
    items.map((i) => i.key),
    ['open']
  );
  assert.equal(items[0].disabled, false);
});

test('todo, owned by the caller: Submit and Declare a block are enabled, Take it back/Rework are absent', () => {
  const items = buildTaskMenuItems(task(), OWNER, allHandlers([]));
  const keys = items.map((i) => i.key);
  assert.ok(keys.includes('submit'));
  assert.ok(keys.includes('block'));
  assert.ok(!keys.includes('take-back'));
  assert.ok(!keys.includes('rework'));
  const submit = items.find((i) => i.key === 'submit')!;
  assert.equal(submit.disabled, false);
});

test('todo, unpriced (no catalog type): Submit is present but disabled with the trigger’s own reason', () => {
  const items = buildTaskMenuItems(task({ task_type_id: null }), OWNER, allHandlers([]));
  const submit = items.find((i) => i.key === 'submit')!;
  assert.equal(submit.disabled, true);
  assert.match(submit.reason ?? '', /catalog type/);
});

test('submitted, viewed by someone who is neither the owner nor a GM: Take it back is present but disabled', () => {
  const items = buildTaskMenuItems(task({ status: 'submitted' }), OTHER_STAFF, allHandlers([]));
  const takeBack = items.find((i) => i.key === 'take-back')!;
  assert.ok(takeBack);
  assert.equal(takeBack.disabled, true);
});

test('submitted, viewed by a GM: Take it back is enabled', () => {
  const items = buildTaskMenuItems(task({ status: 'submitted', owner_user_id: OTHER_STAFF.id }), GM, allHandlers([]));
  const takeBack = items.find((i) => i.key === 'take-back')!;
  assert.equal(takeBack.disabled, false);
});

test('rejected: Rework it replaces Submit/Take it back', () => {
  const items = buildTaskMenuItems(task({ status: 'rejected' }), OWNER, allHandlers([]));
  const keys = items.map((i) => i.key);
  assert.ok(keys.includes('rework'));
  assert.ok(!keys.includes('submit'));
  assert.ok(!keys.includes('take-back'));
});

test('a task with an open block offers Resolve a block instead of Declare a block, gated to owner/oversight', () => {
  const blocked = task({ openBlockCount: 1 });
  const ownerItems = buildTaskMenuItems(blocked, OWNER, allHandlers([]));
  assert.ok(ownerItems.some((i) => i.key === 'resolve-block' && i.disabled === false));
  assert.ok(!ownerItems.some((i) => i.key === 'block'));

  const otherItems = buildTaskMenuItems(blocked, OTHER_STAFF, allHandlers([]));
  const resolve = otherItems.find((i) => i.key === 'resolve-block')!;
  assert.equal(resolve.disabled, true);
});

test('cleared: no write items, only Open task', () => {
  const items = buildTaskMenuItems(task({ status: 'cleared' }), OWNER, allHandlers([]));
  assert.deepEqual(
    items.map((i) => i.key),
    ['open']
  );
});

test('pending_cancellation: no write items, only Open task', () => {
  const items = buildTaskMenuItems(task({ status: 'pending_cancellation' }), OWNER, allHandlers([]));
  assert.deepEqual(
    items.map((i) => i.key),
    ['open']
  );
});

test('every enabled item actually calls its handler with the task, and disabled items are inert', () => {
  const calls: string[] = [];
  const items = buildTaskMenuItems(task(), OWNER, allHandlers(calls));
  for (const item of items) item.onSelect();
  assert.deepEqual(calls.sort(), ['block', 'open', 'submit'].sort());
});
