import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildFieldDiffs, type DiffResolvers, type TaskEditRequest } from './task-edit-requests';

const RESOLVE: DiffResolvers = {
  taskTypeName: (id) => (id === 'type-1' ? 'BOC filing' : id === 'type-2' ? 'Client call' : 'Unknown type'),
  memberName: (id) => (id === 'u-sales' ? 'Sales Person' : id === 'u-broker' ? 'Broker Person' : 'Unknown'),
};

function baseRequest(over: Partial<TaskEditRequest> = {}): TaskEditRequest {
  return {
    id: 'req-1',
    task_id: 'task-1',
    requested_by: 'u-gm',
    requested_at: '2026-09-10T09:00:00Z',
    reason: 'Client renamed the shipment reference.',
    change_title: false,
    proposed_title: null,
    change_description: false,
    proposed_description: null,
    change_task_type_id: false,
    proposed_task_type_id: null,
    change_owner_user_id: false,
    proposed_owner_user_id: null,
    change_client_ref: false,
    proposed_client_ref: null,
    status: 'pending',
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    before_values: null,
    after_values: null,
    created_at: '2026-09-10T09:00:00Z',
    updated_at: '2026-09-10T09:00:00Z',
    ...over,
  };
}

test('only fields with their change_* flag set produce a diff row — never a bare proposed_* null check', () => {
  const req = baseRequest({
    change_title: true,
    proposed_title: 'New title',
    before_values: { title: 'Old title' },
    // description is untouched: change_description is false even though
    // proposed_description could theoretically carry a stray value.
    proposed_description: 'should never appear',
  });
  const diffs = buildFieldDiffs(req, RESOLVE);
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0], { key: 'title', label: 'Title', before: 'Old title', after: 'New title' });
});

test('a proposed null (clearing a field) renders as the empty dash, not as a dropped row', () => {
  const req = baseRequest({
    change_description: true,
    proposed_description: null,
    before_values: { description: 'Had a description' },
  });
  const diffs = buildFieldDiffs(req, RESOLVE);
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0], { key: 'description', label: 'Description', before: 'Had a description', after: '—' });
});

test('task_type_id and owner_user_id resolve through the id lookups, not raw uuids', () => {
  const req = baseRequest({
    change_task_type_id: true,
    proposed_task_type_id: 'type-2',
    before_values: { task_type_id: 'type-1' },
    change_owner_user_id: true,
    proposed_owner_user_id: 'u-broker',
    before_values: { task_type_id: 'type-1', owner_user_id: 'u-sales' },
  });
  const diffs = buildFieldDiffs(req, RESOLVE);
  const type = diffs.find((d) => d.key === 'task_type_id');
  const owner = diffs.find((d) => d.key === 'owner_user_id');
  assert.deepEqual(type, { key: 'task_type_id', label: 'Catalog type', before: 'BOC filing', after: 'Client call' });
  assert.deepEqual(owner, { key: 'owner_user_id', label: 'Owner', before: 'Sales Person', after: 'Broker Person' });
});

test('once approved, `after` reads from after_values (what was actually applied), not proposed_* again', () => {
  const req = baseRequest({
    status: 'approved',
    change_title: true,
    proposed_title: 'Whatever was proposed',
    before_values: { title: 'Old title' },
    after_values: { title: 'What was actually applied' },
  });
  const diffs = buildFieldDiffs(req, RESOLVE);
  assert.equal(diffs[0].after, 'What was actually applied');
});

test('a pending request with no after_values yet falls back to proposed_*', () => {
  const req = baseRequest({
    status: 'pending',
    change_client_ref: true,
    proposed_client_ref: 'BOC-2026-001',
    before_values: { client_ref: null },
  });
  const diffs = buildFieldDiffs(req, RESOLVE);
  assert.equal(diffs[0].before, '—');
  assert.equal(diffs[0].after, 'BOC-2026-001');
});

test('a request proposing every field produces five ordered rows', () => {
  const req = baseRequest({
    change_title: true,
    proposed_title: 't',
    change_description: true,
    proposed_description: 'd',
    change_task_type_id: true,
    proposed_task_type_id: 'type-1',
    change_owner_user_id: true,
    proposed_owner_user_id: 'u-sales',
    change_client_ref: true,
    proposed_client_ref: 'c',
    before_values: {},
  });
  const diffs = buildFieldDiffs(req, RESOLVE);
  assert.deepEqual(
    diffs.map((d) => d.key),
    ['title', 'description', 'task_type_id', 'owner_user_id', 'client_ref']
  );
});
