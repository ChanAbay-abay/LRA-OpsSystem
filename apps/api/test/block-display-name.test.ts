/**
 * LRA Global Ops :: what a block NAMES
 *
 * `blockDisplayName` is the one rule behind `blockingName` in both
 * `GET /api/tasks/:id/blocks` and `GET /api/now`. It was extracted on
 * 2026-09-10 because those two routes each carried their own copy of
 * `blocking_user_id ? name : blocking_external` — which is correct for
 * two of the three targets `ops.task_blocks` accepts and silently
 * returns `null` for the third, so a block on another TASK rendered with
 * no title anywhere on screen.
 *
 * That went unnoticed because no UI path could create a task-target
 * block until `BlockDialog` got a real target picker (same date). The
 * columns and `chk_ops_task_blocks_one_target` have accepted all three
 * since Phase 3.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { blockDisplayName } from '../src/routes/tasks.js';

const NAMES = new Map<string, string | null>([
  ['user-1', 'Rico Santos'],
  ['user-nameless', null],
]);
const TITLES = new Map<string, string>([['task-1', 'Lodge the SAD for ACME']]);

describe('blockDisplayName', () => {
  test('a person target resolves to the roster display name', () => {
    const name = blockDisplayName(
      { target: 'person', blocking_user_id: 'user-1', blocking_task_id: null, blocking_external: null },
      NAMES,
      TITLES
    );
    assert.equal(name, 'Rico Santos');
  });

  test('a task target resolves to the blocking task’s title — the case that was returning null', () => {
    const name = blockDisplayName(
      { target: 'task', blocking_user_id: null, blocking_task_id: 'task-1', blocking_external: null },
      NAMES,
      TITLES
    );
    assert.equal(name, 'Lodge the SAD for ACME');
  });

  test('an external target passes the free text through unchanged', () => {
    const name = blockDisplayName(
      { target: 'external', blocking_user_id: null, blocking_task_id: null, blocking_external: 'BOC system down' },
      NAMES,
      TITLES
    );
    assert.equal(name, 'BOC system down');
  });

  test('an unresolvable name is null, never a placeholder or the wrong column', () => {
    // DESIGN.md §8: an absence renders as an absence. The client decides
    // what to say about a missing name ("another task" / "someone
    // else"); this function must not guess one.
    assert.equal(
      blockDisplayName(
        { target: 'task', blocking_user_id: null, blocking_task_id: 'task-gone', blocking_external: null },
        NAMES,
        TITLES
      ),
      null
    );
    assert.equal(
      blockDisplayName(
        { target: 'person', blocking_user_id: 'user-nameless', blocking_task_id: null, blocking_external: null },
        NAMES,
        TITLES
      ),
      null
    );
  });
});
