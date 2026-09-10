/**
 * Regression tests for the defect described in `request-headers.ts` and
 * PLAN.md §11.1 — the one that made every bodyless POST in the web app
 * fail with a 400 before it reached the API's route handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeaders, isNoContent } from './request-headers';

test('a bodyless request does NOT declare a JSON content type', () => {
  // This is the whole bug. Fastify answers a declared-JSON request with
  // no body `400 FST_ERR_CTP_EMPTY_JSON_BODY`, before the handler runs.
  const h = buildHeaders(undefined, 'tok');
  assert.equal(h['Content-Type'], undefined);
  assert.equal(h.Authorization, 'Bearer tok');
});

test('an explicitly null body is treated the same as no body', () => {
  assert.equal(buildHeaders(null, 'tok')['Content-Type'], undefined);
});

test('a request WITH a body still declares application/json', () => {
  const h = buildHeaders(JSON.stringify({ reason: 'because' }), 'tok');
  assert.equal(h['Content-Type'], 'application/json');
});

test('an empty JSON object is a real body and still declares the type', () => {
  // `'{}'` is a non-empty body Fastify parses happily — it must keep the
  // header, or the server would then reject it for the opposite reason.
  assert.equal(buildHeaders('{}', 'tok')['Content-Type'], 'application/json');
});

test('an empty string body is not a body', () => {
  // `body: ''` is what a caller would produce by accident, and it is
  // exactly the case Fastify refuses. `== null` alone would let it
  // through, so this asserts the guard covers it.
  assert.equal(buildHeaders('', 'tok')['Content-Type'], undefined);
});

test('the token is always attached', () => {
  for (const body of [undefined, null, '{}', 'x'] as const) {
    assert.equal(buildHeaders(body, 'abc').Authorization, 'Bearer abc');
  }
});

test('a per-call header wins over the defaults', () => {
  const h = buildHeaders('{}', 'tok', { 'Content-Type': 'text/plain' });
  assert.equal(h['Content-Type'], 'text/plain');
});

test('204, 205 and 304 are no-content statuses', () => {
  for (const s of [204, 205, 304]) assert.equal(isNoContent(s), true, `${s} should be no-content`);
});

test('200 and 201 are NOT no-content — they must still be required to carry { data }', () => {
  // If 200 were ever treated as no-content, every screen in the app would
  // render an empty state instead of its data, and nothing would throw.
  for (const s of [200, 201, 202]) assert.equal(isNoContent(s), false, `${s} must not be treated as no-content`);
});

test('error statuses are not no-content — they must reach the error branches', () => {
  for (const s of [400, 403, 404, 409, 422, 500, 503]) assert.equal(isNoContent(s), false);
});
