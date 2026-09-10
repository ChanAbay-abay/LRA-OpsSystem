/**
 * LRA Global Ops :: bulk edit suggestions — payload shaping and refusals
 *
 * Chan, 2026-09-10: "GM can send a request to edit (should be done by
 * bulk like an edit feature on google docs), then approve by admin or
 * founder showing what changed like before and after".
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT IS NOT. PLAN.md §12.7 is blunt
 * about this project's failure mode: "this project's tests verify what a
 * handler returns; its bugs live in what the handler does on the way."
 * So the things asserted here are the pure decisions that CANNOT be
 * checked any other way — presence vs null on a proposed field, and what
 * the approval screen is told about a batch — and nothing here is
 * evidence about the database's behaviour. Atomicity, authority and the
 * read-only wrapper live in `ops.decide_edit_batch` and are asserted in
 * `supabase/tests/rls_test.sql`, against a real Postgres, because a
 * mocked transaction cannot roll back and would only ever prove the mock
 * works.
 *
 * The single most dangerous function here is `toRpcItems`, because
 * `{ description: null }` (clear the description) and `{}` (say nothing
 * about the description) are one keystroke apart and produce completely
 * different proposals against a locked, committed task.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleBatches,
  createBatchSchema,
  findEmptyItemIndex,
  rejectBatchSchema,
  toRpcItems,
  type BatchRow,
  type ItemRow,
} from '../src/routes/task-edit-batches.js';

const GM = 'user-gm';
const FOUNDER = 'user-founder';

function batch(over: Partial<BatchRow> & { id: string }): BatchRow {
  return {
    requested_by: GM,
    requested_at: '2026-09-10T01:00:00Z',
    reason: 'the client renamed two shipments this morning',
    status: 'pending',
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    created_at: '2026-09-10T01:00:00Z',
    updated_at: '2026-09-10T01:00:00Z',
    ...over,
  };
}

function item(over: Partial<ItemRow> & { id: string; batch_id: string; task_id: string }): ItemRow {
  return {
    requested_by: GM,
    requested_at: '2026-09-10T01:00:00Z',
    reason: 'the client renamed two shipments this morning',
    status: 'pending',
    change_title: true,
    proposed_title: 'renamed',
    change_description: false,
    proposed_description: null,
    change_task_type_id: false,
    proposed_task_type_id: null,
    change_owner_user_id: false,
    proposed_owner_user_id: null,
    change_client_ref: false,
    proposed_client_ref: null,
    before_values: { title: 'original' },
    after_values: null,
    ...over,
  };
}

describe('toRpcItems — presence, never truthiness', () => {
  test('an omitted field produces no key at all', () => {
    const out = toRpcItems([{ taskId: 't1', changes: { title: 'renamed' } }]);
    assert.deepEqual(out, [{ task_id: 't1', title: 'renamed' }]);
    assert.ok(!('description' in out[0]), 'an unmentioned field must not appear in the proposal');
  });

  test('an explicit null is preserved as a null-valued key — clearing a field is a real change', () => {
    const out = toRpcItems([{ taskId: 't1', changes: { description: null } }]);
    assert.ok('description' in out[0], 'the key must survive so change_description becomes true');
    assert.equal(out[0].description, null);
  });

  /**
   * The regression this pair exists for: `{ description: null }` and `{}`
   * must NOT produce the same proposal. A `?? null` fallback over all five
   * fields — the obvious-looking shortening — collapses them, and the
   * result is a batch that silently clears the description of every task
   * it touches. On a locked, committed task that is the "no trace" failure
   * `ops.task_edit_requests` was built to prevent, arriving through the
   * front door.
   */
  test('null and omitted are NOT the same proposal', () => {
    const withNull = toRpcItems([{ taskId: 't1', changes: { description: null } }]);
    const without = toRpcItems([{ taskId: 't1', changes: { title: 'x' } }]);
    assert.notDeepEqual(withNull[0], without[0]);
    assert.deepEqual(Object.keys(withNull[0]).sort(), ['description', 'task_id']);
    assert.deepEqual(Object.keys(without[0]).sort(), ['task_id', 'title']);
  });

  test('camelCase becomes the column name the database proposes against', () => {
    const out = toRpcItems([
      { taskId: 't1', changes: { taskTypeId: 'type-1', ownerUserId: 'user-1', clientRef: null } },
    ]);
    assert.deepEqual(out, [
      { task_id: 't1', task_type_id: 'type-1', owner_user_id: 'user-1', client_ref: null },
    ]);
  });

  test('several items keep their own proposals, in order', () => {
    const out = toRpcItems([
      { taskId: 't1', changes: { title: 'a' } },
      { taskId: 't2', changes: { clientRef: 'BL-2' } },
      { taskId: 't1', changes: { description: 'a second change to the same task' } },
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(out[1], { task_id: 't2', client_ref: 'BL-2' });
    // Two items may target the same task: on a Google-Docs-style pass a
    // person edits a field, moves on, and comes back. Nothing collapses
    // them here — the database applies both, in order, inside one
    // transaction.
    assert.equal(out[2].task_id, 't1');
  });
});

describe('createBatchSchema — the refusals that must not reach the database', () => {
  test('an empty items array is refused', () => {
    const r = createBatchSchema.safeParse({ reason: 'a perfectly good reason here', items: [] });
    assert.equal(r.success, false);
  });

  test('a reason under 10 characters is refused', () => {
    const r = createBatchSchema.safeParse({
      reason: 'too short',
      items: [{ taskId: '11111111-1111-4111-8111-111111111111', changes: { title: 'x' } }],
    });
    assert.equal(r.success, false);
  });

  /**
   * The guarantee this protects: a proposal can only ever express a change
   * to one of the five DEFINING fields. `points_override` is the specific
   * thing that must stay inexpressible — otherwise a suggestion becomes a
   * way to re-price somebody's committed week. `.strict()` REFUSES the key
   * rather than dropping it, because silently dropping it would let a
   * caller believe they had proposed something they had not.
   */
  test('a field outside the five defining ones is REFUSED, not silently dropped', () => {
    const r = createBatchSchema.safeParse({
      reason: 'trying to re-price a committed task',
      items: [
        {
          taskId: '11111111-1111-4111-8111-111111111111',
          changes: { title: 'x', pointsOverride: 99 },
        },
      ],
    });
    assert.equal(r.success, false);
    assert.ok(
      JSON.stringify(r.error?.issues).includes('pointsOverride'),
      'the refusal must name the offending key so the client can say which field was rejected'
    );
  });

  test('a valid batch parses, and an explicit null survives parsing', () => {
    const r = createBatchSchema.safeParse({
      reason: 'clearing two stale descriptions after the call',
      items: [{ taskId: '11111111-1111-4111-8111-111111111111', changes: { description: null } }],
    });
    assert.equal(r.success, true);
    assert.ok(r.success && 'description' in r.data.items[0].changes);
  });

  test('rejecting requires a written reason of at least 10 characters', () => {
    assert.equal(rejectBatchSchema.safeParse({ reason: 'no' }).success, false);
    assert.equal(rejectBatchSchema.safeParse({}).success, false);
    assert.equal(
      rejectBatchSchema.safeParse({ reason: 'the consignee spelling in the BL is the one we invoice against' })
        .success,
      true
    );
  });
});

describe('findEmptyItemIndex — an item that proposes nothing', () => {
  test('finds the first empty item, 0-based', () => {
    assert.equal(
      findEmptyItemIndex([
        { taskId: 't1', changes: { title: 'a' } },
        { taskId: 't2', changes: {} },
      ]),
      1
    );
  });

  test('an item whose only proposal is an explicit null is NOT empty', () => {
    assert.equal(findEmptyItemIndex([{ taskId: 't1', changes: { description: null } }]), -1);
  });

  test('returns -1 when every item proposes something', () => {
    assert.equal(
      findEmptyItemIndex([
        { taskId: 't1', changes: { title: 'a' } },
        { taskId: 't2', changes: { clientRef: null } },
      ]),
      -1
    );
  });
});

describe('assembleBatches — what the approval screen is told', () => {
  const input = {
    batches: [batch({ id: 'b1' })],
    items: [
      item({ id: 'i1', batch_id: 'b1', task_id: 't1' }),
      item({ id: 'i2', batch_id: 'b1', task_id: 't2', change_title: false, change_client_ref: true, proposed_client_ref: 'BL-2' }),
    ],
    tasks: [
      { id: 't1', title: 'Clear the Sunfeather shipment', status: 'todo' },
      { id: 't2', title: 'File the Aurora entry', status: 'in_progress' },
    ],
    namesByUser: { [GM]: 'Gina Manager', [FOUNDER]: 'Founder Persona' },
  };

  test('each item carries its task title and status, so the queue needs no per-item fetch', () => {
    const [b] = assembleBatches(input);
    assert.equal(b.items[0].taskTitle, 'Clear the Sunfeather shipment');
    assert.equal(b.items[1].taskStatus, 'in_progress');
  });

  test('the raw request columns are passed through untouched, so the web app reuses one diff renderer', () => {
    const [b] = assembleBatches(input);
    // buildFieldDiffs() in apps/web reads exactly these.
    assert.equal(b.items[0].change_title, true);
    assert.equal(b.items[0].proposed_title, 'renamed');
    assert.deepEqual(b.items[0].before_values, { title: 'original' });
  });

  test('names are resolved for the requester and the decider', () => {
    const [b] = assembleBatches({
      ...input,
      batches: [batch({ id: 'b1', status: 'approved', decided_by: FOUNDER })],
    });
    assert.equal(b.requestedByName, 'Gina Manager');
    assert.equal(b.decidedByName, 'Founder Persona');
  });

  test('an undecided batch has no decider name rather than a wrong one', () => {
    const [b] = assembleBatches(input);
    assert.equal(b.decidedByName, null);
  });

  test('itemCount and taskCount are different numbers, and both matter', () => {
    const [b] = assembleBatches({
      ...input,
      items: [...input.items, item({ id: 'i3', batch_id: 'b1', task_id: 't1', proposed_title: 'renamed again' })],
    });
    assert.equal(b.itemCount, 3);
    assert.equal(b.taskCount, 2, 'three edits over two tasks reads differently from three over three');
  });

  /**
   * The state the build contract calls out explicitly: "a batch whose task
   * was cleared or cancelled underneath it". `ops.decide_edit_batch`
   * refuses such a batch WHOLESALE, so the UI has to be able to say so
   * before the approver clicks — otherwise the only way to discover it is
   * a 422 on a button that looked fine.
   */
  test('a batch whose task was cancelled underneath it is flagged, not silently approvable', () => {
    const [b] = assembleBatches({
      ...input,
      tasks: [
        { id: 't1', title: 'Clear the Sunfeather shipment', status: 'cancelled' },
        { id: 't2', title: 'File the Aurora entry', status: 'in_progress' },
      ],
    });
    assert.equal(b.hasUnapplicableItem, true);
  });

  test('a cleared task counts as unapplicable too — both terminal statuses, not just cancelled', () => {
    const [b] = assembleBatches({
      ...input,
      tasks: [
        { id: 't1', title: 'Clear the Sunfeather shipment', status: 'cleared' },
        { id: 't2', title: 'File the Aurora entry', status: 'in_progress' },
      ],
    });
    assert.equal(b.hasUnapplicableItem, true);
  });

  test('a task that is missing entirely is unapplicable, and its title is null rather than invented', () => {
    const [b] = assembleBatches({ ...input, tasks: [input.tasks[0]] });
    assert.equal(b.items[1].taskTitle, null);
    assert.equal(b.items[1].taskStatus, null);
    assert.equal(b.hasUnapplicableItem, true);
  });

  test('an ordinary pending batch is NOT flagged — the negative control', () => {
    const [b] = assembleBatches(input);
    assert.equal(b.hasUnapplicableItem, false);
  });

  test('items are grouped to their own batch and never leak across batches', () => {
    const result = assembleBatches({
      ...input,
      batches: [batch({ id: 'b1' }), batch({ id: 'b2', reason: 'a second, unrelated suggestion' })],
      items: [
        item({ id: 'i1', batch_id: 'b1', task_id: 't1' }),
        item({ id: 'i2', batch_id: 'b2', task_id: 't2' }),
      ],
    });
    assert.equal(result[0].itemCount, 1);
    assert.equal(result[1].itemCount, 1);
    assert.equal(result[0].items[0].id, 'i1');
    assert.equal(result[1].items[0].id, 'i2');
  });

  /**
   * A batch with no items cannot be created (`ops.create_edit_batch`
   * refuses it) and cannot be decided (`ops.decide_edit_batch` refuses
   * it) — but if one ever existed, the list endpoint must render it as
   * empty rather than throw and take the whole approval screen down with
   * it.
   */
  test('a childless batch assembles to an empty, non-approvable card instead of throwing', () => {
    const [b] = assembleBatches({ ...input, items: [] });
    assert.equal(b.itemCount, 0);
    assert.equal(b.taskCount, 0);
    assert.deepEqual(b.items, []);
    assert.equal(b.hasUnapplicableItem, false);
  });

  test('no batches in, no batches out', () => {
    assert.deepEqual(assembleBatches({ ...input, batches: [], items: [] }), []);
  });
});
