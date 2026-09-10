/**
 * LRA Global Ops :: label layer unit tests — DESIGN.md §17
 *
 * The load-bearing behaviour isn't the individual strings (those are
 * copy, and Chan can and will change them) — it is that every accessor
 * (a) never throws, (b) never blanks, and (c) falls back to the raw key
 * for anything it doesn't recognise, per §17.2's "unknown key" rule.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorityLabel,
  blockRelation,
  blockRelationLabel,
  boardColumnLabel,
  editRequestStatusLabel,
  leaderboardVisibilityLabel,
  positionLabel,
  reliabilityBandLabel,
  taskStatusHint,
  taskStatusIsKnown,
  taskStatusLabel,
  taskStatusTransition,
  weekStateLabel,
} from './labels';

describe('taskStatusLabel — the exact strings from §17.3', () => {
  test('every task status renders Title Case, ≤ 2 words', () => {
    assert.equal(taskStatusLabel('todo'), 'Backlog');
    assert.equal(taskStatusLabel('in_progress'), 'In Progress');
    assert.equal(taskStatusLabel('submitted'), 'Submitted');
    assert.equal(taskStatusLabel('verified'), 'Verified');
    assert.equal(taskStatusLabel('cleared'), 'Cleared');
    assert.equal(taskStatusLabel('rejected'), 'Returned');
    assert.equal(taskStatusLabel('cancelled'), 'Cancelled');
  });

  test('pending_cancellation is the short chip label, not the old sentence', () => {
    assert.equal(taskStatusLabel('pending_cancellation'), 'Cancellation Requested');
    assert.equal(taskStatusHint('pending_cancellation'), 'Someone asked to call this off. Waiting on a decision.');
  });

  test('an unknown key renders as itself, never blank, never a crash', () => {
    assert.equal(taskStatusLabel('some_future_status'), 'some_future_status');
    assert.equal(taskStatusIsKnown('some_future_status'), false);
    assert.equal(taskStatusIsKnown('todo'), true);
  });

  test('a hint always exists for a known status and is never the label itself', () => {
    for (const status of ['todo', 'in_progress', 'submitted', 'verified', 'cleared', 'rejected', 'cancelled']) {
      const hint = taskStatusHint(status);
      assert.ok(hint.length > 0, `${status} should have a hint`);
      assert.notEqual(hint, taskStatusLabel(status));
    }
  });
});

describe('taskStatusTransition — the ledger line, never the raw enum keys', () => {
  test('renders labels either side of the arrow', () => {
    assert.equal(taskStatusTransition('todo', 'in_progress'), 'Backlog → In Progress');
  });

  test('never contains a raw snake_case key', () => {
    const line = taskStatusTransition('submitted', 'pending_cancellation');
    assert.ok(!line.includes('_'), `expected no raw enum key in "${line}"`);
  });
});

describe('boardColumnLabel', () => {
  test('this_week and in_progress read as their own two words', () => {
    assert.equal(boardColumnLabel('this_week'), 'This Week');
    assert.equal(boardColumnLabel('in_progress'), 'In Progress');
  });
});

describe('authorityLabel — readOnly outranks the base word', () => {
  test('the four authorities', () => {
    assert.equal(authorityLabel('staff'), 'Staff');
    assert.equal(authorityLabel('gm'), 'GM');
    assert.equal(authorityLabel('founder'), 'Founder');
    assert.equal(authorityLabel('admin'), 'Admin');
  });

  test('a read-only founder reads "Read-only", never "Founder"', () => {
    assert.equal(authorityLabel('founder', true), 'Read-only');
    assert.equal(authorityLabel('founder', false), 'Founder');
  });
});

describe('positionLabel — never `capitalize` on the raw column', () => {
  test('oversight_only-style snake_case never survives to the label', () => {
    // The actual defect this guards: `person-card.tsx` used to do
    // `className="capitalize"` on the raw `row.position`, which turned
    // `hr_officer` into "Hr_officer" rather than "HR Officer".
    assert.equal(positionLabel('hr_officer'), 'HR Officer');
    assert.equal(positionLabel('broker'), 'Broker');
    assert.equal(positionLabel('sales'), 'Sales');
    assert.equal(positionLabel('other'), 'Other');
  });
});

describe('reliabilityBandLabel', () => {
  test('unrated is a real word, not a blank', () => {
    assert.equal(reliabilityBandLabel('unrated'), 'Unrated');
  });
  test('at_risk keeps its space, not its underscore', () => {
    assert.equal(reliabilityBandLabel('at_risk'), 'At risk');
  });
});

describe('editRequestStatusLabel', () => {
  test('the four suggestion states', () => {
    assert.equal(editRequestStatusLabel('pending'), 'Pending');
    assert.equal(editRequestStatusLabel('approved'), 'Approved');
    assert.equal(editRequestStatusLabel('rejected'), 'Rejected');
    assert.equal(editRequestStatusLabel('withdrawn'), 'Withdrawn');
  });
});

describe('weekStateLabel', () => {
  test('planning / open / closed', () => {
    assert.equal(weekStateLabel('planning'), 'Planning');
    assert.equal(weekStateLabel('open'), 'Open');
    assert.equal(weekStateLabel('closed'), 'Closed');
  });
});

describe('leaderboardVisibilityLabel', () => {
  test('never renders the raw oversight_only key', () => {
    assert.equal(leaderboardVisibilityLabel('all'), 'Everyone');
    assert.equal(leaderboardVisibilityLabel('oversight_only'), 'Oversight only');
  });
});

describe('blockRelation / blockRelationLabel — moved from task-types.ts, wording unchanged', () => {
  test('waiting-on-you outranks raised-by-you when both are true', () => {
    const relation = blockRelation({ created_by: 'me', blocking_user_id: 'me' }, 'me');
    assert.equal(relation, 'waiting-on-you');
  });

  test('a task-target block with no resolved name falls back to "another task", not "someone else"', () => {
    assert.equal(blockRelationLabel('waiting-on-other', null, 'task'), 'Waiting on another task');
  });

  test('a person/external-target block with no resolved name falls back to "someone else"', () => {
    assert.equal(blockRelationLabel('waiting-on-other', null, 'external'), 'Waiting on someone else');
  });
});
