import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleTimeHours, isStale, median } from '../src/cycle-time.js';

test('cycleTimeHours subtracts blocked hours', () => {
  const start = new Date('2026-09-07T00:00:00Z');
  const cleared = new Date('2026-09-08T00:00:00Z'); // 24h elapsed
  assert.equal(cycleTimeHours(start, cleared, 10), 14);
});

test('cycleTimeHours never goes negative even when blocked hours exceed elapsed time', () => {
  const start = new Date('2026-09-07T00:00:00Z');
  const cleared = new Date('2026-09-07T02:00:00Z'); // 2h elapsed
  assert.equal(cycleTimeHours(start, cleared, 50), 0);
});

test('median of an odd-length list is the middle value', () => {
  assert.equal(median([5, 1, 3]), 3);
});

test('median of an even-length list averages the two middle values', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([10, 20]), 15);
});

test('median throws on an empty list rather than silently returning 0', () => {
  assert.throws(() => median([]));
});

test('isStale flags a task at or past the threshold, not before it', () => {
  const now = new Date('2026-09-10T00:00:00Z');
  assert.equal(isStale(new Date('2026-09-07T00:00:00Z'), now, 3), true); // exactly 3d
  assert.equal(isStale(new Date('2026-09-08T00:00:00Z'), now, 3), false); // 2d
});
