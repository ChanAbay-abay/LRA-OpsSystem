/**
 * LRA Global Ops :: activity heatmap model unit tests — DESIGN.md §19
 *
 * `heatLevelFor`'s five fixed buckets and `dayKind`'s absence-vs-zero
 * split are the two things on this grid that can quietly lie: a
 * relative scale would paint a quiet team's best day the same as its
 * worst, and treating "before this person's account existed" as a zero
 * would tell someone they did nothing on a day nobody was watching.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKind,
  heatLevelFor,
  monthLabelsForColumns,
  sumLastWeeks,
  toWeekColumns,
  weeksForWidth,
  type ActivityDay,
} from './activity-heatmap-model';

function day(date: string, count: number): ActivityDay {
  return { date, count, points: count * 5 };
}

describe('heatLevelFor — the five fixed buckets (§19.3)', () => {
  test('0 tasks -> L0', () => assert.equal(heatLevelFor(0), 0));
  test('1 task -> L1', () => assert.equal(heatLevelFor(1), 1));
  test('2 tasks -> L2', () => assert.equal(heatLevelFor(2), 2));
  test('3 and 4 tasks both -> L3', () => {
    assert.equal(heatLevelFor(3), 3);
    assert.equal(heatLevelFor(4), 3);
  });
  test('5 or more tasks -> L4, uncapped', () => {
    assert.equal(heatLevelFor(5), 4);
    assert.equal(heatLevelFor(50), 4);
  });
  test('a negative count (should never happen) never crashes and floors at L0', () => {
    assert.equal(heatLevelFor(-1), 0);
  });
});

describe('dayKind — absence vs. a real zero (§19.5)', () => {
  test('a day before the recorded join date is "before-account", never "zero"', () => {
    assert.equal(dayKind(day('2026-01-01', 0), '2026-06-01'), 'before-account');
  });
  test('a day on or after the join date with zero cleared is a real "zero"', () => {
    assert.equal(dayKind(day('2026-06-01', 0), '2026-06-01'), 'zero');
    assert.equal(dayKind(day('2026-06-02', 0), '2026-06-01'), 'zero');
  });
  test('a day with cleared work on or after the join date is "active"', () => {
    assert.equal(dayKind(day('2026-07-01', 3), '2026-06-01'), 'active');
  });
  test('"before-account" wins even if a stray count exists before the join date — a data anomaly, not something to paint as work', () => {
    assert.equal(dayKind(day('2026-01-01', 3), '2026-06-01'), 'before-account');
  });
  test('an unknown join date (null) never produces "before-account"', () => {
    assert.equal(dayKind(day('2020-01-01', 0), null), 'zero');
  });
});

describe('toWeekColumns — Monday-first columns, last N kept', () => {
  const days: ActivityDay[] = Array.from({ length: 21 }, (_, i) =>
    day(`2026-08-${String(3 + i).padStart(2, '0')}`, 0)
  );

  test('chunks a flat day list into 7-day columns', () => {
    const cols = toWeekColumns(days, 3);
    assert.equal(cols.length, 3);
    assert.ok(cols.every((c) => c.length === 7));
  });

  test('keeps only the last N columns, oldest dropped first', () => {
    const cols = toWeekColumns(days, 1);
    assert.equal(cols.length, 1);
    assert.equal(cols[0][0].date, days[14].date);
  });

  test('asking for more weeks than exist returns everything, no padding', () => {
    const cols = toWeekColumns(days, 10);
    assert.equal(cols.length, 3);
  });
});

describe('sumLastWeeks — the Velocity line never disagrees with the mini grid beside it (§23.1)', () => {
  const days: ActivityDay[] = Array.from({ length: 26 * 7 }, (_, i) => day(`d${i}`, i % 7 === 0 ? 2 : 0));

  test('sums only the trailing N weeks, not the whole window', () => {
    // 13 weeks * 1 count-of-2 per week (one day in 7 has count 2) = 26.
    assert.equal(sumLastWeeks(days, 13), 26);
  });

  test('the full window sums to the same total as every day added up', () => {
    const fullTotal = days.reduce((sum, d) => sum + d.count, 0);
    assert.equal(sumLastWeeks(days, 26), fullTotal);
  });

  test('asking for more weeks than exist is clamped by the array itself, not an error', () => {
    assert.equal(sumLastWeeks(days, 100), days.reduce((sum, d) => sum + d.count, 0));
  });
});

describe('weeksForWidth — measured, clamped, never overflows', () => {
  const opts = { labelCol: 24, cell: 12, gap: 3, min: 8, max: 26 };

  test('a wide container clamps at the max', () => {
    assert.equal(weeksForWidth(3000, opts), 26);
  });
  test('a narrow container clamps at the min', () => {
    assert.equal(weeksForWidth(50, opts), 8);
  });
  test('a mid-width container fits exactly what the arithmetic says', () => {
    // (700 - 24 - 8) / 15 = 44.5 -> floor 44, clamped to 26 (max).
    assert.equal(weeksForWidth(700, opts), 26);
    // (300 - 24 - 8) / 15 = 17.86 -> floor 17.
    assert.equal(weeksForWidth(300, opts), 17);
  });
});

describe('monthLabelsForColumns — only where the month changes, and not sooner than 3 columns later', () => {
  function columnsFrom(dates: string[]) {
    return dates.map((d) => [day(d, 0)]);
  }

  test('the first column always gets a label', () => {
    const labels = monthLabelsForColumns(columnsFrom(['2026-08-03']));
    assert.equal(labels[0], 'Aug');
  });

  test('a month change is labelled once 3+ columns have passed since the last label', () => {
    const labels = monthLabelsForColumns(
      columnsFrom(['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'])
    );
    // Aug labelled at column 0. Sep starts at column 5 -- 5 columns since
    // the last label, well past the 3-column minimum -- so it IS labelled.
    assert.equal(labels[0], 'Aug');
    assert.equal(labels[5], 'Sep');
  });

  test('a month change too soon after the last label is suppressed to avoid a collision', () => {
    const labels = monthLabelsForColumns(columnsFrom(['2026-08-31', '2026-09-07', '2026-09-14']));
    // Aug at column 0, Sep starts at column 1 -- only 1 column later, under the 3-column minimum.
    assert.equal(labels[0], 'Aug');
    assert.equal(labels[1], null);
  });
});
