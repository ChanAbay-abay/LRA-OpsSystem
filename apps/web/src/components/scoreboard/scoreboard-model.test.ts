/**
 * LRA Global Ops :: scoreboard model unit tests
 *
 * The three things on `/scoreboard` that can lie quietly, tested
 * directly — no DOM, no React, the same level `task-permissions.test.ts`
 * tests `moveRefusal` at:
 *
 *   1. a person with `possible === 0` must not render as 100% complete;
 *   2. the four buckets must always add up to `possible`, and no bucket
 *      may be silently dropped (`atRisk` in particular — it is small,
 *      undecided, and the easiest one to lose);
 *   3. the recurring cap must still be disclosed when it bites, now that
 *      the permanent raw-points readout is gone (PLAN.md §2.6 / §11.3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketSegments,
  capDisclosure,
  capSentence,
  periodCaption,
  periodShortfall,
  readStoredPeriod,
  sharePercent,
  type CurrentWeekPoints,
  type PointBuckets,
} from './scoreboard-model';

function buckets(overrides: Partial<PointBuckets> = {}): PointBuckets {
  const base = {
    label: 'This week',
    weekCount: 1,
    toDo: 12,
    pending: 13,
    completed: 21,
    atRisk: 2,
    taskCounts: { toDo: 5, pending: 3, completed: 7, atRisk: 1 },
    ...overrides,
  };
  return {
    ...base,
    possible: overrides.possible ?? base.toDo + base.pending + base.completed + base.atRisk,
  };
}

function currentWeek(overrides: Partial<CurrentWeekPoints> = {}): CurrentWeekPoints {
  return {
    rawClearedPoints: 21,
    cappedScore: 21,
    rawRecurringPoints: 6,
    cappedRecurringPoints: 6,
    ...overrides,
  };
}

test('sharePercent is null when nothing was on the plate — 0/0 is not 100%', () => {
  const empty = buckets({ toDo: 0, pending: 0, completed: 0, atRisk: 0 });
  assert.equal(empty.possible, 0);
  assert.equal(sharePercent(empty), null);
});

test('sharePercent is 0, not null, for a real zero against real possible points', () => {
  // "we don't know yet" and "you cleared nothing" are different facts
  // (DESIGN.md §8) and this is the boundary between them.
  assert.equal(sharePercent(buckets({ completed: 0 })), 0);
});

test('sharePercent rounds to a whole percent', () => {
  assert.equal(sharePercent(buckets({ toDo: 0, pending: 0, completed: 1, atRisk: 0, possible: 3 })), 33);
  assert.equal(sharePercent(buckets({ toDo: 0, pending: 0, completed: 48, atRisk: 0 })), 100);
});

test('bucketSegments returns all four buckets in custody order and sums to 100%', () => {
  const segments = bucketSegments(buckets());
  assert.deepEqual(
    segments.map((s) => s.key),
    ['completed', 'pending', 'atRisk', 'toDo']
  );
  assert.deepEqual(
    segments.map((s) => s.points),
    [21, 13, 2, 12]
  );
  const total = segments.reduce((sum, s) => sum + s.percent, 0);
  assert.ok(Math.abs(total - 100) < 1e-9, `segments summed to ${total}`);
});

test('bucketSegments keeps atRisk as its own segment rather than folding it in', () => {
  const segments = bucketSegments(buckets({ atRisk: 8 }));
  const atRisk = segments.find((s) => s.key === 'atRisk');
  assert.equal(atRisk?.points, 8);
  // atRisk is inside `possible`, so it must not inflate the other three.
  assert.equal(segments.find((s) => s.key === 'completed')?.points, 21);
});

test('bucketSegments never divides by zero', () => {
  const segments = bucketSegments(buckets({ toDo: 0, pending: 0, completed: 0, atRisk: 0 }));
  assert.deepEqual(
    segments.map((s) => s.percent),
    [0, 0, 0, 0]
  );
  assert.ok(segments.every((s) => Number.isFinite(s.percent)));
});

test('periodShortfall reports a young dataset honestly, and nothing for all-time', () => {
  assert.equal(periodShortfall('quarter', buckets({ weekCount: 13 })), 0);
  assert.equal(periodShortfall('quarter', buckets({ weekCount: 3 })), 10);
  assert.equal(periodShortfall('month', buckets({ weekCount: 4 })), 0);
  assert.equal(periodShortfall('all', buckets({ weekCount: 3 })), null);
});

test('periodCaption uses the API label verbatim and says when history is short', () => {
  assert.equal(periodCaption('quarter', buckets({ label: 'Last 13 weeks', weekCount: 13 })), 'Last 13 weeks');
  assert.equal(
    periodCaption('quarter', buckets({ label: 'Last 13 weeks', weekCount: 3 })),
    'Last 13 weeks · only 3 weeks of history so far'
  );
  assert.equal(
    periodCaption('all', buckets({ label: 'All time', weekCount: 1 })),
    'All time · 1 week of history'
  );
});

test('capDisclosure is silent when the recurring cap did not bite', () => {
  assert.equal(capDisclosure(currentWeek()), null);
  // Equal is not a haircut, and must not produce a chip.
  assert.equal(capDisclosure(currentWeek({ rawClearedPoints: 21, cappedScore: 21 })), null);
});

test('capDisclosure reports the haircut when the cap did bite', () => {
  const d = capDisclosure(
    currentWeek({ rawClearedPoints: 21, cappedScore: 18, rawRecurringPoints: 9, cappedRecurringPoints: 6 })
  );
  assert.ok(d, 'expected a disclosure');
  assert.equal(d.raw, 21);
  assert.equal(d.capped, 18);
  assert.equal(d.haircut, 3);
  assert.equal(
    capSentence(d),
    'Recurring cap: 9 recurring points cleared, 6 of them count. 21 cleared points score as 18 this week (−3).'
  );
});

test('readStoredPeriod validates whatever localStorage happens to hold', () => {
  assert.equal(readStoredPeriod('quarter'), 'quarter');
  assert.equal(readStoredPeriod('all'), 'all');
  assert.equal(readStoredPeriod(null), 'week');
  assert.equal(readStoredPeriod(''), 'week');
  assert.equal(readStoredPeriod('year'), 'week');
  assert.equal(readStoredPeriod('__proto__'), 'week');
});
