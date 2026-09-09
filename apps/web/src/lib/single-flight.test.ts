/**
 * LRA Global Ops :: single-flight guard test
 *
 * Reproduces the shape of the sign-in bug directly: two callers invoking
 * the guarded function "at the same time" must result in exactly one
 * underlying call, and a caller after the first call settles must get a
 * fresh call rather than a stale cached result.
 *
 * Run with: node --import tsx --test src/lib/single-flight.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { singleFlight } from './single-flight.js';

test('concurrent callers share exactly one underlying call', async () => {
  let calls = 0;
  const guarded = singleFlight(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return calls;
  });

  const [a, b, c] = await Promise.all([guarded(), guarded(), guarded()]);

  assert.equal(calls, 1, 'the wrapped function should run exactly once for overlapping callers');
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(c, 1);
});

test('a later call after the first settles triggers a fresh underlying call', async () => {
  let calls = 0;
  const guarded = singleFlight(async () => {
    calls += 1;
    return calls;
  });

  const first = await guarded();
  const second = await guarded();

  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(calls, 2);
});

test('a rejection is shared by concurrent callers and does not wedge future calls', async () => {
  let attempt = 0;
  const guarded = singleFlight(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('boom');
    return 'ok';
  });

  await assert.rejects(() => Promise.all([guarded(), guarded()]));
  const result = await guarded();
  assert.equal(result, 'ok');
});
