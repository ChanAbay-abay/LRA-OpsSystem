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
