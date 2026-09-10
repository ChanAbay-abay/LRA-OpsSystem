/**
 * LRA Global Ops :: the scoreboard's four point windows
 *
 * `buildPeriodsByUser` / `taskWorth` are the whole of Chan's 2026-09-10
 * ask ("points that are yet to be done, points pending and waiting
 * approval, and completed ... this week, month, 3 month, and overall")
 * and they are pure by design, so this suite exercises them directly
 * with hand-built rows rather than through a live database.
 *
 * The two things most likely to be wrong, and therefore what most of
 * these assertions are about:
 *
 *   1. THE VALUATION FALLBACKS. A task's worth lives in three different
 *      columns depending on how far it got — `points_awarded` once
 *      cleared, else `points_override`, else the `catalog_points`
 *      snapshot. Getting the order wrong shows a cleared task at its
 *      pre-override price, which disagrees with the ledger.
 *   2. `cancelled`. It must be absent from every bucket AND from
 *      `possible`, because a cancelled task is not a point someone
 *      failed to earn.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPeriodsByUser, taskWorth, type PeriodTaskRow } from '../src/routes/scoreboard.js';

// Five consecutive Manila weeks, newest last. w4 is the reference week.
const WEEKS = [
  { id: 'w0', week_start: '2026-08-10' },
  { id: 'w1', week_start: '2026-08-17' },
  { id: 'w2', week_start: '2026-08-24' },
  { id: 'w3', week_start: '2026-08-31' },
  { id: 'w4', week_start: '2026-09-07' },
];
const REF = '2026-09-07';

function task(over: Partial<PeriodTaskRow> & { status: string; week_id: string }): PeriodTaskRow {
  return {
    owner_user_id: 'u1',
    points_awarded: null,
    points_override: null,
    catalog_points: null,
    ...over,
  };
}

describe('taskWorth — the valuation fallbacks', () => {
  test('a cleared task is worth what the trigger actually awarded, not its catalog price', () => {
    const t = task({ status: 'cleared', week_id: 'w4', points_awarded: 3, points_override: 13, catalog_points: 8 });
    assert.equal(taskWorth(t), 3);
  });

  test('a cleared task with no awarded figure falls back to the override, then the catalog', () => {
    assert.equal(taskWorth(task({ status: 'cleared', week_id: 'w4', points_override: 13, catalog_points: 8 })), 13);
    assert.equal(taskWorth(task({ status: 'cleared', week_id: 'w4', catalog_points: 8 })), 8);
  });

  test('an unfinished task NEVER reads points_awarded, even if a row somehow carries one', () => {
    // points_awarded is written only at `cleared`. If it is populated on
    // anything else that is a data anomaly, and honouring it would show
    // an in-progress task as already banked.
    const t = task({ status: 'in_progress', week_id: 'w4', points_awarded: 21, catalog_points: 8 });
    assert.equal(taskWorth(t), 8);
  });

  test('an unfinished task prefers the override over the catalog snapshot', () => {
    assert.equal(taskWorth(task({ status: 'submitted', week_id: 'w4', points_override: 2, catalog_points: 8 })), 2);
  });

  test('a task with no price at all is worth an honest zero, not a guess', () => {
    assert.equal(taskWorth(task({ status: 'todo', week_id: 'w4' })), 0);
    assert.equal(taskWorth(task({ status: 'cleared', week_id: 'w4' })), 0);
  });
});

describe('buildPeriodsByUser — bucketing', () => {
  const rows: PeriodTaskRow[] = [
    task({ status: 'todo', week_id: 'w4', catalog_points: 8 }),
    task({ status: 'in_progress', week_id: 'w4', catalog_points: 5 }),
    task({ status: 'rejected', week_id: 'w4', catalog_points: 2 }),
    task({ status: 'submitted', week_id: 'w4', catalog_points: 3 }),
    task({ status: 'verified', week_id: 'w4', catalog_points: 1 }),
    task({ status: 'cleared', week_id: 'w4', points_awarded: 13 }),
    task({ status: 'pending_cancellation', week_id: 'w4', catalog_points: 21 }),
    task({ status: 'cancelled', week_id: 'w4', catalog_points: 21 }),
  ];

  const periods = buildPeriodsByUser(rows, WEEKS, REF, ['u1']).get('u1')!;

  test('todo + in_progress + rejected are all "yet to be done"', () => {
    assert.equal(periods.week.toDo, 8 + 5 + 2);
    assert.equal(periods.week.taskCounts.toDo, 3);
  });

  test('submitted + verified are "pending, waiting approval"', () => {
    assert.equal(periods.week.pending, 3 + 1);
    assert.equal(periods.week.taskCounts.pending, 2);
  });

  test('only cleared counts as completed', () => {
    assert.equal(periods.week.completed, 13);
    assert.equal(periods.week.taskCounts.completed, 1);
  });

  test('pending_cancellation is at risk — still on the plate, not yet off it', () => {
    assert.equal(periods.week.atRisk, 21);
    assert.equal(periods.week.taskCounts.atRisk, 1);
  });

  test('cancelled is excluded from every bucket and from possible', () => {
    const totalCounts =
      periods.week.taskCounts.toDo +
      periods.week.taskCounts.pending +
      periods.week.taskCounts.completed +
      periods.week.taskCounts.atRisk;
    assert.equal(totalCounts, 7, 'the 8th row (cancelled) must not be counted anywhere');
    // 21 of the 8 rows is the cancelled one; possible must not include it.
    assert.equal(periods.week.possible, 8 + 5 + 2 + 3 + 1 + 13 + 21);
  });

  test('possible is exactly the sum of the four buckets, so it can never disagree with them', () => {
    const p = periods.week;
    assert.equal(p.possible, p.toDo + p.pending + p.completed + p.atRisk);
  });

  test('an unknown status is ignored rather than silently bucketed as work owed', () => {
    const odd = buildPeriodsByUser([task({ status: 'not_a_status', week_id: 'w4', catalog_points: 8 })], WEEKS, REF, [
      'u1',
    ]).get('u1')!;
    assert.equal(odd.week.possible, 0);
  });
});

describe('buildPeriodsByUser — the four windows', () => {
  const rows: PeriodTaskRow[] = [
    task({ status: 'cleared', week_id: 'w4', points_awarded: 1 }),
    task({ status: 'cleared', week_id: 'w3', points_awarded: 2 }),
    task({ status: 'cleared', week_id: 'w2', points_awarded: 4 }),
    task({ status: 'cleared', week_id: 'w1', points_awarded: 8 }),
    task({ status: 'cleared', week_id: 'w0', points_awarded: 16 }),
  ];
  const periods = buildPeriodsByUser(rows, WEEKS, REF, ['u1']).get('u1')!;

  test('week is the reference week alone', () => {
    assert.equal(periods.week.completed, 1);
    assert.equal(periods.week.weekCount, 1);
    assert.equal(periods.week.label, 'This week');
  });

  test('month is the 4 most recent weeks up to and including the reference week', () => {
    assert.equal(periods.month.completed, 1 + 2 + 4 + 8);
    assert.equal(periods.month.weekCount, 4);
    assert.equal(periods.month.label, 'Last 4 weeks');
  });

  test('quarter covers 13 weeks nominally but reports only the weeks that exist', () => {
    assert.equal(periods.quarter.completed, 1 + 2 + 4 + 8 + 16);
    assert.equal(periods.quarter.weekCount, 5, 'only five weeks exist, so the window is five weeks deep');
    assert.equal(periods.quarter.label, 'Last 13 weeks');
  });

  test('all is every week that exists', () => {
    assert.equal(periods.all.completed, 31);
    assert.equal(periods.all.weekCount, 5);
    assert.equal(periods.all.label, 'All time');
  });

  test('a past reference week narrows week/month/quarter but NOT all-time', () => {
    // Chan browsing back to an earlier week must not see someone's
    // all-time record shrink -- "overall" is the whole record.
    const past = buildPeriodsByUser(rows, WEEKS, '2026-08-24', ['u1']).get('u1')!;
    assert.equal(past.week.completed, 4, 'the reference week itself');
    assert.equal(past.month.completed, 4 + 8 + 16, 'w2, w1, w0 -- only three weeks exist at or before w2');
    assert.equal(past.month.weekCount, 3);
    assert.equal(past.all.completed, 31, 'all-time is not re-anchored');
    assert.equal(past.all.weekCount, 5);
  });

  test('a task in a week with no row in ops.weeks lands in no window', () => {
    const orphan = buildPeriodsByUser(
      [task({ status: 'cleared', week_id: 'w-deleted', points_awarded: 99 })],
      WEEKS,
      REF,
      ['u1']
    ).get('u1')!;
    assert.equal(orphan.all.completed, 0);
  });
});

describe('buildPeriodsByUser — people and zeros', () => {
  test("one person's tasks never leak into another's windows", () => {
    const byUser = buildPeriodsByUser(
      [
        task({ owner_user_id: 'u1', status: 'cleared', week_id: 'w4', points_awarded: 5 }),
        task({ owner_user_id: 'u2', status: 'cleared', week_id: 'w4', points_awarded: 8 }),
      ],
      WEEKS,
      REF,
      ['u1', 'u2']
    );
    assert.equal(byUser.get('u1')!.week.completed, 5);
    assert.equal(byUser.get('u2')!.week.completed, 8);
  });

  test('a person with no tasks gets four real zeros with the real week counts, not a missing key', () => {
    const p = buildPeriodsByUser([], WEEKS, REF, ['u3']).get('u3');
    assert.ok(p, 'every roster member must be present');
    assert.equal(p!.all.possible, 0);
    assert.equal(p!.all.weekCount, 5, 'the window is still five weeks deep even with nothing in it');
    assert.equal(p!.week.taskCounts.toDo, 0);
  });

  test('a task owned by someone outside the requested list is simply not reported', () => {
    const byUser = buildPeriodsByUser(
      [task({ owner_user_id: 'stranger', status: 'cleared', week_id: 'w4', points_awarded: 5 })],
      WEEKS,
      REF,
      ['u1']
    );
    assert.equal(byUser.size, 1);
    assert.equal(byUser.get('u1')!.all.completed, 0);
  });

  test('no weeks at all yields zeros rather than throwing', () => {
    const p = buildPeriodsByUser([], [], REF, ['u1']).get('u1')!;
    assert.equal(p.week.weekCount, 0);
    assert.equal(p.all.possible, 0);
  });
});
