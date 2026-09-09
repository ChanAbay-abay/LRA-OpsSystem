/**
 * LRA Global Ops :: /api/catalog duplicate-recurring-template message
 *
 * `duplicateTemplateMessage` (src/routes/catalog.ts) is the piece added
 * for the recurring-template equivalent of the task-type "a task type
 * named ... already exists" 409 -- it names the routine AND the
 * position, since `uq_ops_recurring_templates_title` (20260909210000)
 * is keyed on both. There is no live database in this suite (see
 * apps/api/test/server.test.ts's header for why), so this exercises the
 * exact string the route builds directly, plus the same
 * throw-the-real-error-shape-through-the-real-handler check
 * server.test.ts already does for the task-type constraint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { duplicateTemplateMessage } from '../src/routes/catalog.js';
import { ApiError } from '../src/lib/domain.js';

test('duplicateTemplateMessage names both the position and the routine', () => {
  const message = duplicateTemplateMessage('sales', 'Client follow-up round');
  assert.equal(message, 'the sales role already has a weekly routine called "Client follow-up round"');
});

// Mirrors server.test.ts's "raw 23505 ... maps to 409, not 500" test,
// but for the specific ApiError the recurring-template routes throw on
// a title clash -- confirms the friendly message and DUPLICATE_NAME
// code survive the real error handler unchanged, the way the generic
// central mapping already does for the raw PostgrestError case.
test('the recurring-template duplicate-title ApiError reaches the client as 409 DUPLICATE_NAME', async () => {
  const app = buildServer();
  app.get('/__test/duplicate-template', async () => {
    throw new ApiError(409, duplicateTemplateMessage('sales', 'Client follow-up round'), 'DUPLICATE_NAME');
  });
  const res = await app.inject({ method: 'GET', url: '/__test/duplicate-template' });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error.code, 'DUPLICATE_NAME');
  assert.equal(body.error.message, 'the sales role already has a weekly routine called "Client follow-up round"');
  await app.close();
});
