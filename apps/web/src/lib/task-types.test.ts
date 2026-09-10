/**
 * LRA Global Ops :: block vocabulary unit tests
 *
 * Two rules live in `task-types.ts` that the block dialog and every
 * block caption depend on, and both were written on 2026-09-10 when
 * `BlockDialog` gained a real target picker:
 *
 *   - `blockSubmitRefusal` — a mirror of `POST /api/tasks/:id/blocks`.
 *     Its whole job is that the dialog never fires a request the API
 *     will 400, which is exactly what the old dialog did the moment
 *     someone chose "someone on the team" (it could only ever send an
 *     `external` block, and the submit button did not know that).
 *   - `blockRelationLabel`'s fallback — a block whose name could not be
 *     resolved must still read as something TRUE, and "waiting on
 *     someone else" is false for a block that names no person.
 *
 * Exercised as pure functions, the same level `task-permissions.test.ts`
 * and `task-menu-items.test.ts` work at — no DOM, no Radix.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_REASON_MIN, blockRelationLabel, blockSubmitRefusal, type BlockDraft } from './task-types';

const GOOD_REASON = 'waiting on the signed release from the carrier';

function draft(overrides: Partial<BlockDraft> = {}): BlockDraft {
  return {
    target: 'external',
    blockingUserId: '',
    blockingTaskId: '',
    blockingExternal: '',
    reason: GOOD_REASON,
    ...overrides,
  };
}

describe('blockSubmitRefusal — the mirror of POST /api/tasks/:id/blocks', () => {
  test('the reason minimum is checked first, exactly as blockSchema parses it first', () => {
    // Nothing else is filled in either, so this also pins the ORDER: the
    // API's zod parse rejects a short reason before it ever looks at the
    // target, and the person should be told the same thing first.
    assert.match(blockSubmitRefusal(draft({ reason: 'too short' }))!, /at least 10 characters/);
    assert.equal(BLOCK_REASON_MIN, 10, 'DESIGN.md §5.2 and blockSchema both fix this at 10');
  });

  test('whitespace does not buy the reason minimum', () => {
    assert.notEqual(blockSubmitRefusal(draft({ reason: '          ' })), null);
  });

  test('a person target with nobody chosen is refused, and says which field is missing', () => {
    assert.match(blockSubmitRefusal(draft({ target: 'person' }))!, /person/i);
    assert.equal(blockSubmitRefusal(draft({ target: 'person', blockingUserId: 'user-9' })), null);
  });

  test('a task target with no task chosen is refused', () => {
    assert.match(blockSubmitRefusal(draft({ target: 'task' }))!, /task/i);
    assert.equal(blockSubmitRefusal(draft({ target: 'task', blockingTaskId: 'task-9' })), null);
  });

  test('an external target still needs its free text, trimmed', () => {
    assert.notEqual(blockSubmitRefusal(draft({ target: 'external' })), null);
    assert.notEqual(blockSubmitRefusal(draft({ target: 'external', blockingExternal: '   ' })), null);
    assert.equal(blockSubmitRefusal(draft({ target: 'external', blockingExternal: 'Bureau of Customs' })), null);
  });

  test('the wrong field filled in for the chosen target does not satisfy it', () => {
    // The old dialog's actual bug, in one assertion: a person target
    // carrying only the external free text is not sendable, because
    // `chk_ops_task_blocks_one_target` requires the column that matches
    // the declared target and nothing else.
    assert.notEqual(
      blockSubmitRefusal(draft({ target: 'person', blockingExternal: 'Bureau of Customs' })),
      null
    );
    assert.notEqual(blockSubmitRefusal(draft({ target: 'task', blockingUserId: 'user-9' })), null);
  });
});

describe('blockRelationLabel — the unresolved-name fallback', () => {
  test('a person or external block with no name reads as "someone else"', () => {
    assert.equal(blockRelationLabel('waiting-on-other', null, 'person'), 'Waiting on someone else');
    assert.equal(blockRelationLabel('waiting-on-other', null, 'external'), 'Waiting on someone else');
  });

  test('a task block with no title reads as "another task", never as a person', () => {
    assert.equal(blockRelationLabel('waiting-on-other', null, 'task'), 'Waiting on another task');
    assert.equal(
      blockRelationLabel('raised-by-you', null, 'task'),
      'You flagged this — waiting on another task'
    );
  });

  test('a resolved name always wins over the fallback', () => {
    assert.equal(blockRelationLabel('waiting-on-other', 'Lodge the SAD for ACME', 'task'), 'Waiting on Lodge the SAD for ACME');
  });

  test('waiting-on-you never names anybody — the reader is the answer', () => {
    assert.equal(blockRelationLabel('waiting-on-you', null, 'task'), 'Waiting on you');
  });
});
