/**
 * LRA Global Ops :: the scoreboard's activity heatmap (DESIGN.md §19)
 *
 * `buildActivityByUser` is the pure grouping behind "like git commits,
 * the greens on how many tasks they complete on those days — but blue"
 * (Chan, 2026-09-10). It is tested directly, the same level
 * `buildPeriodsByUser` is tested at in `scoreboard-periods.test.ts`,
 * with the two things most likely to be wrong:
 *
 *   1. THE MANILA DAY BOUNDARY. `manilaDayStart` itself is unit-tested
 *      in `packages/ops-scoring/test/weeks.test.ts`; what's tested HERE
 *      is that a ledger row bearing a UTC timestamp that straddles
 *      midnight Manila lands in the correct day's CELL once it has gone
 *      through this function's grouping — the same distinction
 *      `scoreboard-periods.test.ts` draws between testing a formula and
 *      testing what turns real rows into that formula's inputs.
 *   2. EVERY USER GETS EVERY DAY, even a person with zero cleared rows
 *      at all — DESIGN.md §19.5's "render the full empty grid anyway"
 *      needs a real day list, not a missing key.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildActivityByUser, ACTIVITY_WINDOW_WEEKS, type ActivityLedgerRow } from '../src/routes/scoreboard.js';

// Tue 15 Sep 2026 is inside the reference week (Mon 2026-09-14 .. Sun
// 2026-09-20).
const REF_WEEK_START = '2026-09-14';

function row(over: Partial<ActivityLedgerRow> & { user_id: string; created_at: string }): ActivityLedgerRow {
  return { points: 5, ...over };
}

describe('buildActivityByUser — the Manila day grouping', () => {
  test('a clear at 23:59 Manila and one two minutes later at 00:01 Manila land in different cells', () => {
    const rows: ActivityLedgerRow[] = [
      // Tue 15 Sep 2026 23:59 Manila == 2026-09-15T15:59:00Z.
      row({ user_id: 'u1', created_at: '2026-09-15T15:59:00Z' }),
      // Wed 16 Sep 2026 00:01 Manila == 2026-09-15T16:01:00Z.
      row({ user_id: 'u1', created_at: '2026-09-15T16:01:00Z' }),
    ];
    const out = buildActivityByUser(rows, ['u1'], REF_WEEK_START, new Map());
    const byDate = new Map(out.get('u1')!.days.map((d) => [d.date, d]));
    assert.equal(byDate.get('2026-09-15')!.count, 1);
    assert.equal(byDate.get('2026-09-16')!.count, 1);
  });

  test('a UTC-vs-Manila straddle lands in the Manila day, not the UTC one', () => {
    // 2026-09-15T20:00:00Z is 04:00 Manila on the 16th — still the 15th
    // in raw UTC. A UTC-naive grouping would put this in 15 Sep's cell.
    const rows: ActivityLedgerRow[] = [row({ user_id: 'u1', created_at: '2026-09-15T20:00:00Z' })];
    const out = buildActivityByUser(rows, ['u1'], REF_WEEK_START, new Map());
    const byDate = new Map(out.get('u1')!.days.map((d) => [d.date, d]));
    assert.equal(byDate.get('2026-09-15')?.count ?? 0, 0);
    assert.equal(byDate.get('2026-09-16')!.count, 1);
  });

  test('two tasks cleared by the same person on the same Manila day sum into one cell', () => {
    const rows: ActivityLedgerRow[] = [
      row({ user_id: 'u1', created_at: '2026-09-15T02:00:00Z', points: 5 }),
      row({ user_id: 'u1', created_at: '2026-09-15T10:00:00Z', points: 3 }),
    ];
    const out = buildActivityByUser(rows, ['u1'], REF_WEEK_START, new Map());
    const cell = out.get('u1')!.days.find((d) => d.date === '2026-09-15')!;
    assert.equal(cell.count, 2);
    assert.equal(cell.points, 8);
  });

  test('rows never mix between users', () => {
    const rows: ActivityLedgerRow[] = [
      row({ user_id: 'u1', created_at: '2026-09-15T02:00:00Z' }),
      row({ user_id: 'u2', created_at: '2026-09-15T02:00:00Z' }),
    ];
    const out = buildActivityByUser(rows, ['u1', 'u2'], REF_WEEK_START, new Map());
    assert.equal(out.get('u1')!.days.find((d) => d.date === '2026-09-15')!.count, 1);
    assert.equal(out.get('u2')!.days.find((d) => d.date === '2026-09-15')!.count, 1);
  });
});

describe('buildActivityByUser — every user gets every day', () => {
  test('a person with zero cleared rows still gets the full window of real zeros, not a missing key', () => {
    const out = buildActivityByUser([], ['u1'], REF_WEEK_START, new Map());
    const window = out.get('u1');
    assert.ok(window);
    assert.equal(window.days.length, ACTIVITY_WINDOW_WEEKS * 7);
    assert.ok(window.days.every((d) => d.count === 0 && d.points === 0));
    assert.equal(window.totalCleared, 0);
  });

  test('the window always spans whole Manila weeks — starts on a Monday, ends on the reference week\'s Sunday', () => {
    const out = buildActivityByUser([], ['u1'], REF_WEEK_START, new Map());
    const days = out.get('u1')!.days;
    assert.equal(days[0].date, '2026-03-23'); // Monday, 25 weeks before REF_WEEK_START
    assert.equal(days[days.length - 1].date, '2026-09-20'); // Sunday of the reference week
  });

  test('a smaller window (mini variant callers) is respected exactly', () => {
    const out = buildActivityByUser([], ['u1'], REF_WEEK_START, new Map(), 13);
    const days = out.get('u1')!.days;
    assert.equal(days.length, 13 * 7);
    assert.equal(out.get('u1')!.windowWeeks, 13);
  });

  test('totalCleared sums every day in the window, not just the visible ones', () => {
    const rows: ActivityLedgerRow[] = [
      row({ user_id: 'u1', created_at: '2026-09-01T02:00:00Z' }),
      row({ user_id: 'u1', created_at: '2026-09-15T02:00:00Z' }),
    ];
    const out = buildActivityByUser(rows, ['u1'], REF_WEEK_START, new Map());
    assert.equal(out.get('u1')!.totalCleared, 2);
  });

  test('a row outside the window is excluded from both the day list and the total', () => {
    // Two years before the window — must not silently leak in or inflate totalCleared.
    const rows: ActivityLedgerRow[] = [row({ user_id: 'u1', created_at: '2024-01-01T02:00:00Z' })];
    const out = buildActivityByUser(rows, ['u1'], REF_WEEK_START, new Map());
    assert.equal(out.get('u1')!.totalCleared, 0);
    assert.ok(!out.get('u1')!.days.some((d) => d.date === '2024-01-01'));
  });
});

describe('buildActivityByUser — sinceDate carries through untouched', () => {
  test('a user with a known join date gets it back verbatim; an unknown one gets null', () => {
    const sinceDateByUser = new Map([['u1', '2026-08-01']]);
    const out = buildActivityByUser([], ['u1', 'u2'], REF_WEEK_START, sinceDateByUser);
    assert.equal(out.get('u1')!.sinceDate, '2026-08-01');
    assert.equal(out.get('u2')!.sinceDate, null);
  });
});
