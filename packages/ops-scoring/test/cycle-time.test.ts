import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleTimeHours, isStale, median, medianCycleTimeHours } from '../src/cycle-time.js';

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

// --- medianCycleTimeHours ---------------------------------------------
//
// PLAN.md Phase 8 / PRD.md §4: a per-person MEDIAN, not a mean, of
// `cleared_at - first_in_progress_at` minus blocked hours. Every edge
// case below is named explicitly in the agent brief because a wrong
// answer here reads as a fact about a person's speed.

test('medianCycleTimeHours: no completed tasks -> null median, zero sample size', () => {
  const result = medianCycleTimeHours([]);
  assert.equal(result.medianHours, null);
  assert.equal(result.sampleSize, 0);
});

test('medianCycleTimeHours: a single task -> median is that task\'s own cycle time', () => {
  const result = medianCycleTimeHours([
    { firstInProgressAt: new Date('2026-09-01T00:00:00Z'), clearedAt: new Date('2026-09-02T00:00:00Z') }, // 24h
  ]);
  assert.equal(result.medianHours, 24);
  assert.equal(result.sampleSize, 1);
});

test('medianCycleTimeHours: an even-numbered set averages the two middle values', () => {
  const result = medianCycleTimeHours([
    { firstInProgressAt: new Date('2026-09-01T00:00:00Z'), clearedAt: new Date('2026-09-02T00:00:00Z') }, // 24h
    { firstInProgressAt: new Date('2026-09-01T00:00:00Z'), clearedAt: new Date('2026-09-04T00:00:00Z') }, // 72h
  ]);
  assert.equal(result.medianHours, 48);
  assert.equal(result.sampleSize, 2);
});

test('medianCycleTimeHours: tasks still open (no clearedAt) are excluded, not treated as zero', () => {
  const result = medianCycleTimeHours([
    { firstInProgressAt: new Date('2026-09-01T00:00:00Z'), clearedAt: new Date('2026-09-02T00:00:00Z') }, // 24h
    { firstInProgressAt: new Date('2026-09-05T00:00:00Z'), clearedAt: null }, // still open
  ]);
  assert.equal(result.medianHours, 24);
  assert.equal(result.sampleSize, 1);
});

test('medianCycleTimeHours: tasks with a null first_in_progress_at are excluded, not treated as zero', () => {
  const result = medianCycleTimeHours([
    { firstInProgressAt: new Date('2026-09-01T00:00:00Z'), clearedAt: new Date('2026-09-02T00:00:00Z') }, // 24h
    { firstInProgressAt: null, clearedAt: new Date('2026-09-03T00:00:00Z') }, // no recorded start
  ]);
  assert.equal(result.medianHours, 24);
  assert.equal(result.sampleSize, 1);
});

test('medianCycleTimeHours: blocked hours are subtracted per task before the median is taken', () => {
  const result = medianCycleTimeHours([
    { firstInProgressAt: new Date('2026-09-01T00:00:00Z'), clearedAt: new Date('2026-09-02T00:00:00Z'), blockedHours: 10 }, // 24h - 10h = 14h
  ]);
  assert.equal(result.medianHours, 14);
  assert.equal(result.sampleSize, 1);
});
