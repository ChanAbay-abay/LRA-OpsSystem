/**
 * LRA Ops :: reliability formula tests
 *
 * PLAN.md §5/§8: "Reliability is a management instrument with no
 * visible failure mode." Every case here exists because a formula bug
 * would misrepresent a real person's work without ever throwing an
 * error — tests-first per PLAN.md Phase 8, before `scoreboard.ts` ever
 * calls this function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reliability, type ReliabilityWeek } from '../src/reliability.js';

function week(i: number, committed: number, cleared: number, exonerated = 0): ReliabilityWeek {
  return {
    weekId: `w${i}`,
    weekStart: `2026-0${9 - i}-01`,
    committedPoints: committed,
    clearedCommittedPoints: cleared,
    exoneratedPoints: exonerated,
  };
}

test('all-perfect history scores 100, band excellent', () => {
  const weeks = [week(0, 10, 10), week(1, 10, 10), week(2, 10, 10)];
  const r = reliability(weeks);
  assert.equal(r.score, 100);
  assert.equal(r.band, 'excellent');
  assert.equal(r.base, 1);
});

test('all-missed history scores 0, band at_risk', () => {
  const weeks = [week(0, 10, 0), week(1, 10, 0), week(2, 10, 0)];
  const r = reliability(weeks);
  assert.equal(r.score, 0);
  assert.equal(r.band, 'at_risk');
  assert.equal(r.base, 0);
});

test('a zero-commitment week contributes to neither sum, and does not count toward ratedWeeks', () => {
  const withZeroWeek = [week(0, 0, 0), week(1, 10, 10), week(2, 10, 10), week(3, 10, 10)];
  const withoutZeroWeek = [week(0, 10, 10), week(1, 10, 10), week(2, 10, 10)];

  const a = reliability(withZeroWeek);
  const b = reliability(withoutZeroWeek);

  // The zero week sits at i=0 (weight 1) but committed nothing, so it
  // must not appear in `weightedCommitted`/`weightedCleared` at all --
  // and it must not count as a "rated" week either, since committing
  // to nothing is not evidence of reliability either way.
  assert.equal(a.weeklyBreakdown[0].includedInRating, false);
  assert.equal(a.ratedWeeks, 3);
  assert.equal(a.score, b.score);
});

test('fewer than min_weeks_for_rating committed weeks renders UNRATED, never a numeric default', () => {
  const weeks = [week(0, 10, 10), week(1, 10, 10)]; // only 2 committed weeks, default minimum is 3
  const r = reliability(weeks);
  assert.equal(r.score, null);
  assert.equal(r.band, 'unrated');
});

test('a thin file with a custom minWeeksForRating of 1 is rated as soon as it has one committed week', () => {
  const weeks = [week(0, 10, 10)];
  const r = reliability(weeks, {}, { minWeeksForRating: 1 });
  assert.equal(r.score, 100);
});

test('a recent bad week outweighs an old one — strict inequality on two mirrored histories', () => {
  // History A: bad most recent week, good week before it.
  const historyA = [week(0, 10, 0), week(1, 10, 10), week(2, 10, 10)];
  // History B: same two outcomes, mirrored — the bad week is older.
  const historyB = [week(0, 10, 10), week(1, 10, 0), week(2, 10, 10)];

  const a = reliability(historyA);
  const b = reliability(historyB);

  assert.ok(a.score! < b.score!, `recent-bad (${a.score}) should score strictly lower than old-bad (${b.score})`);
});

test('modifiers respect their caps', () => {
  const weeks = [week(0, 10, 10), week(1, 10, 10), week(2, 10, 10)];
  const r = reliability(
    weeks,
    {
      chronicCarryOverTasks: 50, // would be -100 uncapped
      staleTaskCount: 50, // would be -50 uncapped
      blockedHoursCausedToOthers: 1000, // would be -125 uncapped
      cleanSweepThisWeek: true,
    },
    {}
  );
  assert.equal(r.modifiers.chronicCarryOver, -10);
  assert.equal(r.modifiers.staleness, -5);
  assert.equal(r.modifiers.blockingOthers, -10);
  assert.equal(r.modifiers.cleanSweep, 3);
  // Base is 100; every modifier is capped as above, net -22, so the
  // score is 78 -- not the uncapped -100-50-125+3 that would clamp to 0.
  assert.equal(r.score, 78);
});

test('clamps to [0, 100] on both ends', () => {
  const perfect = [week(0, 10, 10), week(1, 10, 10), week(2, 10, 10)];
  const high = reliability(perfect, { cleanSweepThisWeek: true });
  assert.equal(high.score, 100);

  const terrible = [week(0, 10, 0), week(1, 10, 0), week(2, 10, 0)];
  const low = reliability(terrible, { chronicCarryOverTasks: 10, staleTaskCount: 10, blockedHoursCausedToOthers: 200 });
  assert.equal(low.score, 0);
});

test('blocked-time exoneration removes a failed, blocked commitment from the denominator', () => {
  // 10 committed, 0 cleared, all 10 points were on a task blocked before
  // the week ended -- the whole week is excluded from the ratio, not
  // counted as a miss.
  const weeks = [week(0, 10, 0, 10), week(1, 10, 10), week(2, 10, 10)];
  const r = reliability(weeks);
  assert.equal(r.weeklyBreakdown[0].includedInRating, false);
  assert.equal(r.score, 100, 'the exonerated week must not drag the score down');
});

test('partial exoneration only strips the blocked portion of the denominator', () => {
  // 10 committed, 4 cleared, 6 points were on a blocked task that failed.
  // Effective denominator is 10-6=4, all of which cleared -> 100% for that week.
  const weeks = [week(0, 10, 4, 6)];
  const r = reliability(weeks, {}, { minWeeksForRating: 1 });
  assert.equal(r.weeklyBreakdown[0].effectiveDenominator, 4);
  assert.equal(r.score, 100);
});

test('the returned weeklyBreakdown lets a reader hand-recompute base exactly', () => {
  const weeks = [week(0, 8, 4), week(1, 6, 6), week(2, 10, 0)];
  const r = reliability(weeks, {}, { halfLifeWeeks: 3 });

  const lambda = Math.pow(0.5, 1 / 3);
  let num = 0;
  let den = 0;
  weeks.forEach((w, i) => {
    num += Math.pow(lambda, i) * w.clearedCommittedPoints;
    den += Math.pow(lambda, i) * w.committedPoints;
  });
  const expectedBase = num / den;

  assert.ok(Math.abs(r.base - expectedBase) < 1e-9);
  assert.equal(r.weeklyBreakdown.length, 3);
  assert.equal(r.weeklyBreakdown[1].weight, lambda);
});
