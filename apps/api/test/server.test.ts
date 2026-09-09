/**
 * LRA Global Ops :: server boot smoke test
 *
 * Boots the real server via `buildServer()` and hits it in-process with
 * Fastify's `inject` — no network, no listening socket, but a genuine
 * request/response cycle through the router and error handler. This is
 * the check that catches "the compiler is happy but every route is
 * unreachable", which a pure unit suite cannot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';

test('GET /health responds ok without touching Supabase', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'lra-ops-api');
  await app.close();
});

test('GET /api/me without a bearer token is refused, not 500', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(res.statusCode, 401);
  const body = res.json();
  assert.equal(body.error.code, 'NO_TOKEN');
  await app.close();
});

test('GET /api/admin/users without a bearer token is refused, not 500', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/api/admin/users' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

// Tester defect #2/#4: a raw PostgREST error thrown from a route (the
// `if (error) throw error;` pattern used at 28 sites) used to fall
// through to a generic 500 no matter what SQLSTATE it carried. This
// exercises the real, shared `setErrorHandler` from server.ts against a
// throwaway route that throws the exact error shape a route gets back
// from supabase-js on a duplicate-name insert -- no live database
// needed, since the bug is in how the *response* to that error is
// built, not in Postgres itself.
test('a raw 23505 unique-violation from a route maps to 409, not 500', async () => {
  const app = buildServer();
  app.get('/__test/duplicate', async () => {
    throw {
      name: 'PostgrestError',
      message: 'duplicate key value violates unique constraint "uq_ops_task_types_name"',
      details: 'Key (name)=(Existing Type) already exists.',
      hint: '',
      code: '23505',
    };
  });
  const res = await app.inject({ method: 'GET', url: '/__test/duplicate' });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error.code, 'DUPLICATE');
  assert.doesNotMatch(body.error.message, /uq_ops_task_types_name/);
  await app.close();
});

// Tester defect #3: Fastify's own body-parser error (malformed JSON)
// used to fall through the same generic-500 branch, because the error
// handler never looked at the FastifyError's own `statusCode`/`code`.
// This sends genuinely truncated JSON through the real body parser
// against an unauthenticated throwaway route -- every real POST route
// sits behind the `authenticate` onRequest hook, which runs (and would
// short-circuit with 401) *before* Fastify ever parses the body, so a
// route without that hook is the only way to exercise the parser
// failure itself in isolation.
test('a malformed JSON body is refused as 400, not 500', async () => {
  const app = buildServer();
  app.post('/__test/echo', async (req) => ({ data: req.body }));
  const res = await app.inject({
    method: 'POST',
    url: '/__test/echo',
    headers: { 'content-type': 'application/json' },
    payload: '{"body": "truncated',
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.match(body.error.code, /^FST_ERR_/);
  await app.close();
});
