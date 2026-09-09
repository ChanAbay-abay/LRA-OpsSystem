/**
 * LRA Global Ops :: PostgREST/Postgres error mapping tests
 *
 * Unit-level coverage of `mapPostgrestError` — no Supabase connection
 * involved, just the SQLSTATE/PostgREST-code -> HTTP mapping table
 * itself. The end-to-end path (a real `if (error) throw error;` route
 * hitting the live database and landing here) is exercised by the
 * server-level tests in `server.test.ts`, which simulate the shape of
 * error the routes actually throw without needing a live DB.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mapPostgrestError } from '../src/lib/pg-errors.js';

describe('mapPostgrestError', () => {
  test('23505 unique_violation maps to 409', () => {
    const mapped = mapPostgrestError({ code: '23505', message: 'duplicate key value violates unique constraint "uq_ops_task_types_name"' });
    assert.ok(mapped);
    assert.equal(mapped.statusCode, 409);
    // The generic message must not repeat the raw constraint name back.
    assert.doesNotMatch(mapped.message, /uq_ops_task_types_name/);
  });

  test('23503 foreign_key_violation maps to 409', () => {
    const mapped = mapPostgrestError({ code: '23503', message: 'update or delete on table violates foreign key constraint' });
    assert.ok(mapped);
    assert.equal(mapped.statusCode, 409);
  });

  test('23514 check_violation maps to 422', () => {
    const mapped = mapPostgrestError({ code: '23514', message: 'new row violates check constraint' });
    assert.ok(mapped);
    assert.equal(mapped.statusCode, 422);
    assert.equal(mapped.code, 'VALIDATION_ERROR');
  });

  test('42501 insufficient_privilege maps to 403 and keeps the DB message', () => {
    const mapped = mapPostgrestError({
      code: '42501',
      message: 'only GM or founder may flag a task for cancellation',
    });
    assert.ok(mapped);
    assert.equal(mapped.statusCode, 403);
    assert.equal(mapped.message, 'only GM or founder may flag a task for cancellation');
  });

  test('PGRST116 (row hidden by RLS or missing) maps to 404 with a human message', () => {
    const mapped = mapPostgrestError({
      code: 'PGRST116',
      message: 'Cannot coerce the result to a single JSON object',
    });
    assert.ok(mapped);
    assert.equal(mapped.statusCode, 404);
    assert.doesNotMatch(mapped.message, /coerce/i);
  });

  test('contention codes map to a retryable 503, not an opaque 500', () => {
    // 20260909190000 made the commitment guard take a `for share` lock, so a
    // commit can now legitimately block; a block outliving the statement
    // timeout is cancelled as 57014. Nothing is wrong with the request, so it
    // must not read as a server fault.
    for (const code of ['55P03', '57014', '40001', '40P01']) {
      const mapped = mapPostgrestError({ code, message: 'canceling statement due to statement timeout' });
      assert.ok(mapped, `${code} should be mapped`);
      assert.equal(mapped.statusCode, 503, `${code} should be 503`);
      assert.equal(mapped.code, 'BUSY');
    }
  });

  test('an unmapped code stays unmapped (caller keeps its generic 500)', () => {
    // 22P02 (invalid_text_representation) is a genuine "should never happen"
    // -- it means we sent Postgres something malformed, which is our bug.
    assert.equal(mapPostgrestError({ code: '22P02', message: 'invalid input syntax for type uuid' }), null);
  });

  test('a plain Error with no code is not mistaken for a PostgREST error', () => {
    assert.equal(mapPostgrestError(new Error('boom')), null);
  });

  test('non-object input is handled without throwing', () => {
    assert.equal(mapPostgrestError('boom'), null);
    assert.equal(mapPostgrestError(null), null);
    assert.equal(mapPostgrestError(undefined), null);
  });
});
