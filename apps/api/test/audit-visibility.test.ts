/**
 * An audit write that fails must be DISCOVERABLE, not merely logged.
 *
 * On 2026-09-10 `PATCH /api/settings` passed the literal string
 * 'settings' as `entity_id`, a uuid column. Postgres refused it with
 * 22P02, `writeAudit` caught its own error into a `console.error`, and
 * the endpoint returned 200 with an entirely correct body. The audit
 * trail for the parameters that rescore every person in the company —
 * the recurring cap and the whole reliability formula, retroactively
 * across 13-week windows — silently recorded nothing. It was found by a
 * person counting rows in the table, which is not a control.
 *
 * The lesson generalises past the uuid. Three defects this project has
 * hit share one shape: the handler's RETURN VALUE was correct and the
 * bug lived in what the handler did on the way (seven endpoints green
 * while their buttons were dead behind a Content-Type; a permanent
 * delete answering 204 reported to the user as a failure; this). An
 * endpoint-level assertion on the response cannot see any of them.
 *
 * So this pins the side effect's own observability rather than the
 * response: a failed audit write is counted, and `GET /health` says so.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { auditFailures } from '../src/lib/supabase.js';

describe('audit failures are discoverable', () => {
  beforeEach(() => {
    auditFailures.count = 0;
    auditFailures.last = null;
  });

  test('a clean process reports ok and zero failures', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.audit.failures, 0);
    assert.equal(body.audit.last, null);
    await app.close();
  });

  test('health degrades once an audit write has failed, and names what failed', async () => {
    // Simulating the recorded failure rather than forcing a real insert
    // error: the point under test is that a failure becomes VISIBLE, not
    // how Postgres rejects a bad uuid — and this test must not need a
    // database to run, or it will be skipped in exactly the situations
    // where it matters.
    auditFailures.count = 1;
    auditFailures.last = {
      action: 'admin.settings.patch',
      entityType: 'ops.settings',
      message: 'invalid input syntax for type uuid: "settings"',
      at: new Date().toISOString(),
    };

    const app = buildServer();
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();

    // 'ok' would be a lie: the service is serving, but it has stopped
    // keeping the record it promises to keep.
    assert.equal(body.status, 'degraded');
    assert.equal(body.audit.failures, 1);
    assert.equal(body.audit.last.action, 'admin.settings.patch');
    assert.match(body.audit.last.message, /uuid/);
    await app.close();
  });

  test('the counter accumulates rather than only holding the latest', async () => {
    // One failure and forty are different situations, and a boolean
    // would report them identically.
    auditFailures.count = 40;
    const body = (await buildServer().inject({ method: 'GET', url: '/health' })).json();
    assert.equal(body.audit.failures, 40);
    assert.equal(body.status, 'degraded');
  });
});
