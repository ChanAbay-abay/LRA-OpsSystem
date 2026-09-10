/**
 * LRA Global Ops :: /api/now payload shaping
 *
 * `assembleNowPayload` is the whole of what the Now screen says, and the
 * two things it decides are easy to get backwards:
 *
 *   - a block on MY task belongs in `blocked` ("I am waiting");
 *   - the same row seen from the other side belongs in `blockingOthers`
 *     ("someone is waiting on me") — Chan, 2026-09-10: "i want it to be
 *     more clear which tasks you're blocking and which tasks you're not."
 *
 * Getting that pair the wrong way round produces a screen that looks
 * plausible and blames the wrong person, so it is asserted from both
 * sides here. The rest of the suite pins the ADDITIVE contract: the four
 * original keys must keep their exact shape, because the web client was
 * already reading them before this session.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assembleNowPayload, type BlockRow, type TaskRow, type NowPayloadInput } from '../src/routes/now.js';

const ME = 'user-me';
const OTHER = 'user-other';
const DECLARER = 'user-declarer';

function task(over: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    title: `task ${over.id}`,
    status: 'in_progress',
    owner_user_id: ME,
    created_by: ME,
    catalog_points: 8,
    points_override: null,
    rejected_reason: null,
    last_activity_at: '2026-09-09T02:00:00Z',
    created_at: '2026-09-08T02:00:00Z',
    ...over,
  };
}

function block(over: Partial<BlockRow> & { id: string; task_id: string }): BlockRow {
  return {
    target: 'person',
    reason: 'waiting on the signed copy',
    created_by: DECLARER,
    created_at: '2026-09-09T01:00:00Z',
    blocking_user_id: null,
    blocking_task_id: null,
    blocking_external: null,
    ...over,
  };
}

function input(over: Partial<NowPayloadInput> = {}): NowPayloadInput {
  return {
    myTasks: [],
    openBlocks: [],
    blocksIAmHolding: [],
    heldTasks: [],
    awaitingMyApproval: [],
    ownersByUserId: new Map(),
    namesByUserId: new Map(),
    titlesByTaskId: new Map(),
    ...over,
  };
}

describe('the four original keys keep their shape', () => {
  test('myOpenTasks carries the slim card, and excludes anything blocked', () => {
    const t1 = task({ id: 't1' });
    const t2 = task({ id: 't2' });
    const out = assembleNowPayload(
      input({
        myTasks: [t1, t2],
        openBlocks: [block({ id: 'b1', task_id: 't2' })],
        ownersByUserId: new Map([[ME, { ownerName: 'Me Myself', ownerPosition: 'sales' }]]),
      })
    );
    assert.deepEqual(
      out.myOpenTasks.map((t) => t.id),
      ['t1']
    );
    assert.deepEqual(out.myOpenTasks[0], {
      id: 't1',
      title: 'task t1',
      status: 'in_progress',
      ownerUserId: ME,
      ownerName: 'Me Myself',
      ownerPosition: 'sales',
      points: 8,
      rejectedReason: null,
      lastActivityAt: '2026-09-09T02:00:00Z',
      createdAt: '2026-09-08T02:00:00Z',
    });
  });

  test('points prefer an override over the catalog snapshot, and fall back to zero', () => {
    const out = assembleNowPayload(
      input({
        myTasks: [
          task({ id: 'a', points_override: 13 }),
          task({ id: 'b', catalog_points: null }),
        ],
      })
    );
    assert.equal(out.myOpenTasks.find((t) => t.id === 'a')!.points, 13);
    assert.equal(out.myOpenTasks.find((t) => t.id === 'b')!.points, 0);
  });

  test('newlyAssigned is only todo tasks somebody ELSE created in my name', () => {
    const out = assembleNowPayload(
      input({
        myTasks: [
          task({ id: 'mine', status: 'todo', created_by: ME }),
          task({ id: 'handed', status: 'todo', created_by: OTHER }),
          task({ id: 'started', status: 'in_progress', created_by: OTHER }),
        ],
      })
    );
    assert.deepEqual(
      out.newlyAssigned.map((t) => t.id),
      ['handed']
    );
  });

  test('awaitingMyApproval is passed through as slim cards', () => {
    const out = assembleNowPayload(
      input({
        awaitingMyApproval: [task({ id: 'q1', owner_user_id: OTHER, status: 'submitted' })],
        ownersByUserId: new Map([[OTHER, { ownerName: 'Other Person', ownerPosition: 'broker' }]]),
      })
    );
    assert.equal(out.awaitingMyApproval[0].ownerName, 'Other Person');
    assert.equal(out.awaitingMyApproval[0].status, 'submitted');
  });
});

describe('blocked[] — the resolution identities', () => {
  test('a block on my task carries who declared it and who is being waited on', () => {
    const out = assembleNowPayload(
      input({
        myTasks: [task({ id: 't1' })],
        openBlocks: [block({ id: 'b1', task_id: 't1', blocking_user_id: OTHER, created_by: DECLARER })],
        ownersByUserId: new Map([[ME, { ownerName: 'Me Myself', ownerPosition: 'sales' }]]),
        namesByUserId: new Map([
          [OTHER, 'Other Person'],
          [DECLARER, 'The Declarer'],
        ]),
      })
    );
    const b = out.blocked[0];
    assert.equal(b.blockId, 'b1');
    assert.equal(b.blockingUserId, OTHER);
    assert.equal(b.blockingName, 'Other Person');
    assert.equal(b.blockCreatedBy, DECLARER);
    assert.equal(b.blockCreatedByName, 'The Declarer');
    // The task's own owner is the fourth allowed resolver and is already
    // on the card, so the client needs nothing more to mirror the policy.
    assert.equal(b.ownerUserId, ME);
  });

  test('an external block has a null blockingUserId and keeps blockingName as the free text', () => {
    const out = assembleNowPayload(
      input({
        myTasks: [task({ id: 't1' })],
        openBlocks: [
          block({ id: 'b1', task_id: 't1', target: 'external', blocking_external: 'BIR office closed' }),
        ],
      })
    );
    assert.equal(out.blocked[0].blockingUserId, null);
    assert.equal(out.blocked[0].blockingName, 'BIR office closed');
  });

  // Added 2026-09-10 with the block dialog's target picker: `task` was
  // the one target of the three whose `blockingName` was never resolved,
  // so a block on another task rendered as "Waiting on someone else"
  // with the title nowhere on screen. Unreachable from the UI until the
  // picker landed, which is why it went unnoticed.
  test('a task-target block reads as the blocking task’s title', () => {
    const out = assembleNowPayload(
      input({
        myTasks: [task({ id: 't1' })],
        openBlocks: [block({ id: 'b1', task_id: 't1', target: 'task', blocking_task_id: 'other-task' })],
        titlesByTaskId: new Map([['other-task', 'Lodge the SAD for ACME']]),
      })
    );
    assert.equal(out.blocked[0].blockingName, 'Lodge the SAD for ACME');
    assert.equal(out.blocked[0].blockingUserId, null, 'a task target names no person');
  });

  test('a task-target block whose title could not be read is null, not a wrong name', () => {
    const out = assembleNowPayload(
      input({
        myTasks: [task({ id: 't1' })],
        openBlocks: [block({ id: 'b1', task_id: 't1', target: 'task', blocking_task_id: 'gone' })],
      })
    );
    // DESIGN.md §8: an absence renders as an absence. The client prints
    // "another task" rather than a name it does not have; it must not be
    // handed a guess.
    assert.equal(out.blocked[0].blockingName, null);
  });

  test('an unknown declarer name is null, never a fabricated placeholder', () => {
    const out = assembleNowPayload(
      input({ myTasks: [task({ id: 't1' })], openBlocks: [block({ id: 'b1', task_id: 't1' })] })
    );
    assert.equal(out.blocked[0].blockCreatedByName, null);
    assert.equal(out.blocked[0].blockCreatedBy, DECLARER, 'the id is still reported even with no name');
  });
});

describe('blockingOthers[] — work I am holding up', () => {
  const held = task({
    id: 'theirs',
    owner_user_id: OTHER,
    created_by: OTHER,
    status: 'todo',
    points_override: 21,
  });

  test("names the waiting owner and the task, valued like every other card", () => {
    const out = assembleNowPayload(
      input({
        blocksIAmHolding: [
          block({ id: 'b9', task_id: 'theirs', blocking_user_id: ME, created_by: OTHER, reason: 'waiting on my numbers' }),
        ],
        heldTasks: [held],
        ownersByUserId: new Map([[OTHER, { ownerName: 'Other Person', ownerPosition: 'broker' }]]),
      })
    );
    assert.deepEqual(out.blockingOthers, [
      {
        blockId: 'b9',
        reason: 'waiting on my numbers',
        target: 'person',
        blockedSince: '2026-09-09T01:00:00Z',
        taskId: 'theirs',
        taskTitle: 'task theirs',
        taskStatus: 'todo',
        points: 21,
        ownerUserId: OTHER,
        ownerName: 'Other Person',
        ownerPosition: 'broker',
      },
    ]);
  });

  test('oldest block leads — the longest thing I am holding up is the first thing I see', () => {
    const out = assembleNowPayload(
      input({
        blocksIAmHolding: [
          block({ id: 'newest', task_id: 'theirs', blocking_user_id: ME, created_at: '2026-09-09T09:00:00Z' }),
          block({ id: 'oldest', task_id: 'theirs', blocking_user_id: ME, created_at: '2026-09-01T09:00:00Z' }),
          block({ id: 'middle', task_id: 'theirs', blocking_user_id: ME, created_at: '2026-09-05T09:00:00Z' }),
        ],
        heldTasks: [held],
      })
    );
    assert.deepEqual(
      out.blockingOthers.map((b) => b.blockId),
      ['oldest', 'middle', 'newest']
    );
  });

  test('a block naming me on MY OWN task is not something I am holding up', () => {
    // The route filters this out in SQL (`.neq('owner_user_id', me)`),
    // so `heldTasks` never contains it -- the block must then vanish from
    // this list rather than appearing as a debt I owe myself. It is
    // already reported in `blocked`, from the correct side.
    const mine = task({ id: 'mine', owner_user_id: ME });
    const b = block({ id: 'b1', task_id: 'mine', blocking_user_id: ME, created_by: DECLARER });
    const out = assembleNowPayload(
      input({ myTasks: [mine], openBlocks: [b], blocksIAmHolding: [b], heldTasks: [] })
    );
    assert.deepEqual(out.blockingOthers, []);
    assert.equal(out.blocked.length, 1);
    assert.equal(out.blocked[0].blockId, 'b1');
  });

  test('holding nothing up is an empty array, not a missing key', () => {
    const out = assembleNowPayload(input({ myTasks: [task({ id: 't1' })] }));
    assert.ok(Array.isArray(out.blockingOthers));
    assert.equal(out.blockingOthers.length, 0);
  });

  test('several people waiting on me are all listed, each with their own owner', () => {
    const theirs2 = task({ id: 'theirs2', owner_user_id: DECLARER, points_override: 3 });
    const out = assembleNowPayload(
      input({
        blocksIAmHolding: [
          block({ id: 'b1', task_id: 'theirs', blocking_user_id: ME, created_at: '2026-09-02T00:00:00Z' }),
          block({ id: 'b2', task_id: 'theirs2', blocking_user_id: ME, created_at: '2026-09-03T00:00:00Z' }),
        ],
        heldTasks: [held, theirs2],
        ownersByUserId: new Map([
          [OTHER, { ownerName: 'Other Person', ownerPosition: 'broker' }],
          [DECLARER, { ownerName: 'The Declarer', ownerPosition: 'sales' }],
        ]),
      })
    );
    assert.deepEqual(
      out.blockingOthers.map((b) => [b.blockId, b.ownerName]),
      [
        ['b1', 'Other Person'],
        ['b2', 'The Declarer'],
      ]
    );
  });
});
