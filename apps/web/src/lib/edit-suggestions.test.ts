import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  EMPTY_SUGGESTIONS,
  batchDecisionRefusal,
  buildSuggestionDiffs,
  discardAll,
  discardField,
  discardTask,
  hasSuggestions,
  normalizeBatch,
  proposeChange,
  staleFields,
  statusUnavailableReason,
  suggestedTaskCount,
  suggestionCount,
  suggestionProblems,
  suggestionRefusal,
  toBatchItems,
  unavailableReason,
  type SuggestibleTask,
  type SuggestionResolvers,
  type SuggestionState,
} from './edit-suggestions';
import type { Actor } from './task-permissions';

const RESOLVE: SuggestionResolvers = {
  taskTypeName: (id) => (id === 'type-1' ? 'BOC filing' : id === 'type-2' ? 'Client call' : 'Unknown type'),
  memberName: (id) => (id === 'u-sales' ? 'Sales Person' : id === 'u-broker' ? 'Broker Person' : 'Unknown'),
};

function task(over: Partial<SuggestibleTask> = {}): SuggestibleTask {
  return {
    id: 'task-1',
    title: 'Clear BOC entry for Cebu shipment',
    description: 'Wait on the airway bill.',
    task_type_id: 'type-1',
    owner_user_id: 'u-broker',
    client_ref: 'HIST-302',
    status: 'todo',
    ...over,
  };
}

function actor(over: Partial<Actor> = {}): Actor {
  return { id: 'u-gm', authority: 'gm', isClearingFounder: false, readOnly: false, ...over };
}

// ---------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------

test('a suggestion records what it would replace, so before/after never has to be inferred', () => {
  const t = task();
  const state = proposeChange(EMPTY_SUGGESTIONS, t, 'title', 'Clear BOC entry for Cebu shipment (RENAMED)');
  assert.deepEqual(state[t.id].title, {
    value: 'Clear BOC entry for Cebu shipment (RENAMED)',
    original: 'Clear BOC entry for Cebu shipment',
  });
  assert.equal(suggestionCount(state), 1);
  assert.equal(suggestedTaskCount(state), 1);
});

test('many tasks are held at once — the whole point of "bulk"', () => {
  const a = task({ id: 'task-a' });
  const b = task({ id: 'task-b', title: 'Second task' });
  let state = proposeChange(EMPTY_SUGGESTIONS, a, 'title', 'A renamed');
  state = proposeChange(state, a, 'client_ref', 'HIST-999');
  state = proposeChange(state, b, 'owner_user_id', 'u-sales');
  assert.equal(suggestionCount(state), 3);
  assert.equal(suggestedTaskCount(state), 2);
});

test('typing the original value back removes the suggestion instead of proposing a no-op', () => {
  const t = task();
  let state = proposeChange(EMPTY_SUGGESTIONS, t, 'title', 'Something else');
  state = proposeChange(state, t, 'title', 'Clear BOC entry for Cebu shipment');
  assert.equal(hasSuggestions(state), false);
});

test('empty string and null are the same intent, so clearing an already-empty field is not a suggestion', () => {
  const t = task({ description: null });
  const state = proposeChange(EMPTY_SUGGESTIONS, t, 'description', '');
  assert.equal(hasSuggestions(state), false);
});

test('a deliberate clear of a field that HAS a value is a real suggestion, sent as null', () => {
  const t = task();
  const state = proposeChange(EMPTY_SUGGESTIONS, t, 'description', '');
  assert.equal(suggestionCount(state), 1);
  assert.deepEqual(toBatchItems(state), [{ taskId: 'task-1', changes: { description: null } }]);
});

test('discarding one field leaves the rest; discarding the last field drops the task', () => {
  const t = task();
  let state = proposeChange(EMPTY_SUGGESTIONS, t, 'title', 'New');
  state = proposeChange(state, t, 'client_ref', 'HIST-1');
  state = discardField(state, t.id, 'title');
  assert.equal(suggestionCount(state), 1);
  state = discardField(state, t.id, 'client_ref');
  assert.equal(hasSuggestions(state), false);
});

test('discard-one-task and discard-all are both available and neither mutates the input', () => {
  const a = task({ id: 'task-a' });
  const b = task({ id: 'task-b' });
  let state = proposeChange(EMPTY_SUGGESTIONS, a, 'title', 'A2');
  state = proposeChange(state, b, 'title', 'B2');
  const afterTask = discardTask(state, 'task-a');
  assert.equal(suggestedTaskCount(state), 2, 'the input state is untouched');
  assert.equal(suggestedTaskCount(afterTask), 1);
  assert.equal(hasSuggestions(discardAll()), false);
});

test('the batch body carries one item per task and the API field names, camelCase', () => {
  const a = task({ id: 'task-a' });
  const b = task({ id: 'task-b' });
  let state = proposeChange(EMPTY_SUGGESTIONS, a, 'task_type_id', 'type-2');
  state = proposeChange(state, a, 'owner_user_id', 'u-sales');
  state = proposeChange(state, b, 'client_ref', 'HIST-777');
  assert.deepEqual(toBatchItems(state), [
    { taskId: 'task-a', changes: { taskTypeId: 'type-2', ownerUserId: 'u-sales' } },
    { taskId: 'task-b', changes: { clientRef: 'HIST-777' } },
  ]);
});

test('a draft renders through the same FieldDiff shape a real request does', () => {
  const t = task();
  let state: SuggestionState = proposeChange(EMPTY_SUGGESTIONS, t, 'task_type_id', 'type-2');
  state = proposeChange(state, t, 'owner_user_id', 'u-sales');
  state = proposeChange(state, t, 'description', '');
  assert.deepEqual(buildSuggestionDiffs(state[t.id], RESOLVE), [
    { key: 'description', label: 'Description', before: 'Wait on the airway bill.', after: '—' },
    { key: 'task_type_id', label: 'Catalog type', before: 'BOC filing', after: 'Client call' },
    { key: 'owner_user_id', label: 'Owner', before: 'Broker Person', after: 'Sales Person' },
  ]);
});

test('a title or owner suggested empty is a problem named before submit, not a 400 after it', () => {
  const t = task();
  let state = proposeChange(EMPTY_SUGGESTIONS, t, 'title', '');
  assert.deepEqual(
    suggestionProblems(state).map((p) => p.field),
    ['title']
  );
  // description / catalog type / client ref may all be cleared —
  // changesSchema makes exactly those three nullable.
  state = proposeChange(EMPTY_SUGGESTIONS, t, 'description', '');
  state = proposeChange(state, t, 'client_ref', '');
  assert.deepEqual(suggestionProblems(state), []);
});

// ---------------------------------------------------------------------
// The awkward states
// ---------------------------------------------------------------------

test('a field that moved under the draft is reported stale, and only that field', () => {
  const t = task();
  let state = proposeChange(EMPTY_SUGGESTIONS, t, 'title', 'My proposed title');
  state = proposeChange(state, t, 'client_ref', 'HIST-1');
  const moved = task({ title: 'Somebody else renamed this' });
  assert.deepEqual(staleFields(state[t.id], moved), ['title']);
  assert.deepEqual(staleFields(state[t.id], t), []);
});

test('a task cleared or cancelled under the draft, or gone entirely, says so', () => {
  assert.equal(unavailableReason(task()), null);
  assert.match(String(unavailableReason(task({ status: 'cleared' }))), /cleared/);
  assert.match(String(unavailableReason(task({ status: 'cancelled' }))), /cancelled/);
  assert.match(String(unavailableReason(undefined)), /no longer in this week/);
});

// ---------------------------------------------------------------------
// Permissions — diffed against the policies, not invented
// ---------------------------------------------------------------------

test('raising a suggestion mirrors is_oversight() wrapped in not is_read_only()', () => {
  assert.equal(suggestionRefusal(actor({ authority: 'gm' })), null);
  assert.equal(suggestionRefusal(actor({ authority: 'founder' })), null);
  assert.equal(suggestionRefusal(actor({ authority: 'admin' })), null);
  assert.match(String(suggestionRefusal(actor({ authority: 'staff' }))), /GM, founder or admin/);
  assert.equal(suggestionRefusal(null), 'You are not signed in.');
  // A read-only founder holds `founder` authority and may change nothing.
  assert.equal(
    suggestionRefusal(actor({ authority: 'founder', readOnly: true })),
    'Your account is read-only.'
  );
});

test('deciding a batch is founder OR admin, and read-only is refused before authority is consulted', () => {
  const batch = { requested_by: 'u-gm', status: 'pending' as const, itemCount: 2 };
  assert.equal(batchDecisionRefusal(batch, actor({ id: 'u-f', authority: 'founder' })), null);
  assert.equal(batchDecisionRefusal(batch, actor({ id: 'u-a', authority: 'admin' })), null);
  // A founder without the clearing seat still decides these — Chan's
  // words were "approve by admin or founder", i.e. core.is_founder().
  assert.equal(
    batchDecisionRefusal(batch, actor({ id: 'u-f2', authority: 'founder', isClearingFounder: false })),
    null
  );
  assert.match(String(batchDecisionRefusal(batch, actor({ authority: 'gm' }))), /founder or admin/);
  assert.match(String(batchDecisionRefusal(batch, actor({ authority: 'staff' }))), /founder or admin/);
  assert.equal(
    batchDecisionRefusal(batch, actor({ id: 'u-erc', authority: 'founder', readOnly: true })),
    'Your account is read-only.',
    'ERC/DCA hold founder authority — the read-only wrapper is the only thing keeping them out'
  );
});

test('nobody decides their own batch, a decided batch is not decided twice, and an empty batch is refused', () => {
  const mine = { requested_by: 'u-f', status: 'pending' as const, itemCount: 1 };
  assert.match(
    String(batchDecisionRefusal(mine, actor({ id: 'u-f', authority: 'founder' }))),
    /You raised this/
  );
  assert.match(
    String(
      batchDecisionRefusal(
        { requested_by: 'u-gm', status: 'approved', itemCount: 1 },
        actor({ id: 'u-f', authority: 'founder' })
      )
    ),
    /already been approved/
  );
  assert.match(
    String(
      batchDecisionRefusal(
        { requested_by: 'u-gm', status: 'pending', itemCount: 0 },
        actor({ id: 'u-f', authority: 'founder' })
      )
    ),
    /no changes in it/
  );
  assert.equal(batchDecisionRefusal(mine, null), 'You are not signed in.');
});

// ---------------------------------------------------------------------
// The one thing the web lane could not verify against Lane A's file
// ---------------------------------------------------------------------

test('a batch normalizes from the API shape, and a batch with no children is empty rather than invented', () => {
  const raw = {
    id: 'batch-1',
    requested_by: 'u-gm',
    requested_at: '2026-09-10T09:00:00Z',
    reason: 'Client renamed two shipments this morning.',
    status: 'pending',
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    requestedByName: 'GM (demo)',
    itemCount: 2,
    taskCount: 2,
    hasUnapplicableItem: false,
    items: [
      { id: 'req-1', task_id: 'task-a', taskTitle: 'A', taskStatus: 'todo' },
      { id: 'req-2', task_id: 'task-b', taskTitle: 'B', taskStatus: 'todo' },
    ],
  };
  const batch = normalizeBatch(raw);
  assert.equal(batch?.items.length, 2);
  assert.equal(batch?.itemCount, 2);
  assert.equal(batch?.hasUnapplicableItem, false);
  assert.equal(batch?.requestedByName, 'GM (demo)');

  // The one failure mode this guard exists for: children that did not
  // arrive must NOT render as an approvable empty card.
  const childless = normalizeBatch({ ...raw, items: undefined, itemCount: undefined, taskCount: undefined });
  assert.equal(childless?.items.length, 0);
  assert.equal(childless?.itemCount, 0);

  // Counts are computed from what arrived when the server did not send
  // them — never asserted from nothing.
  const uncounted = normalizeBatch({ ...raw, itemCount: undefined, taskCount: undefined, hasUnapplicableItem: undefined });
  assert.equal(uncounted?.itemCount, 2);
  assert.equal(uncounted?.taskCount, 2);
  assert.equal(uncounted?.hasUnapplicableItem, false);
  const withDead = normalizeBatch({
    ...raw,
    hasUnapplicableItem: undefined,
    items: [{ id: 'req-1', task_id: 'task-a', taskStatus: 'cancelled' }],
  });
  assert.equal(withDead?.hasUnapplicableItem, true);

  assert.equal(normalizeBatch(null), null);
  assert.equal(normalizeBatch({ reason: 'no id' }), null);
});

test('an item whose task closed or vanished says so, from the status the API reports', () => {
  assert.equal(statusUnavailableReason('todo'), null);
  assert.match(String(statusUnavailableReason('cleared')), /cleared/);
  assert.match(String(statusUnavailableReason('cancelled')), /cancelled/);
  assert.match(String(statusUnavailableReason(null)), /no longer visible/);
});
