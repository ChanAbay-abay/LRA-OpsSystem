import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRecurringCap } from '../src/recurring-cap.js';

test('all-recurring week (N=0) with a floor of 3 credits exactly the floor', () => {
  const r = applyRecurringCap({ newPoints: 0, recurringPoints: 10, capPct: 0.4, floorPoints: 3 });
  assert.equal(r.cappedRecurringPoints, 3);
  assert.equal(r.totalPoints, 3);
});

test('all-recurring week (N=0) with no floor credits nothing', () => {
  const r = applyRecurringCap({ newPoints: 0, recurringPoints: 10, capPct: 0.4, floorPoints: 0 });
  assert.equal(r.cappedRecurringPoints, 0);
  assert.equal(r.totalPoints, 0);
});

test('N=10, R=10 caps recurring to 6, keeping the ratio at or under 40%', () => {
  const r = applyRecurringCap({ newPoints: 10, recurringPoints: 10, capPct: 0.4, floorPoints: 3 });
  assert.equal(r.cappedRecurringPoints, 6);
  assert.equal(r.totalPoints, 16);
  assert.ok(r.recurringRatio <= 0.4, `ratio ${r.recurringRatio} should be <= 0.40`);
  assert.equal(Math.round(r.recurringRatio * 1000) / 1000, 0.375);
});

test('R=0 does not crash and credits nothing recurring', () => {
  assert.doesNotThrow(() => applyRecurringCap({ newPoints: 15, recurringPoints: 0, capPct: 0.4, floorPoints: 3 }));
  const r = applyRecurringCap({ newPoints: 15, recurringPoints: 0, capPct: 0.4, floorPoints: 3 });
  assert.equal(r.cappedRecurringPoints, 0);
  assert.equal(r.totalPoints, 15);
});

test('capPct=0 credits the floor only, regardless of N or R', () => {
  const r = applyRecurringCap({ newPoints: 20, recurringPoints: 10, capPct: 0, floorPoints: 3 });
  assert.equal(r.cappedRecurringPoints, 3);
  assert.equal(r.totalPoints, 23);
});

test('the floor never exceeds the recurring points actually earned', () => {
  const r = applyRecurringCap({ newPoints: 0, recurringPoints: 2, capPct: 0.4, floorPoints: 3 });
  assert.equal(r.cappedRecurringPoints, 2, 'cannot credit more recurring points than were actually earned');
});
