/**
 * LRA Ops :: week math tests
 *
 * Every case here exists because a UTC-naive implementation gets it
 * wrong silently — scores landing in the wrong week is the failure
 * mode PLAN.md §8 names as the standing risk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manilaWeekStart, manilaWeekBounds, manilaDayStart, manilaDayBounds, weeksBetween } from '../src/weeks.js';

test('Manila Monday 00:15 and Manila Sunday 23:45 of the same week map to the same week_start', () => {
  // 2026-09-07 is a Monday. 00:15 Manila == 2026-09-06T16:15:00Z.
  const mondayMorning = new Date('2026-09-06T16:15:00Z');
  // 2026-09-13 23:45 Manila == 2026-09-13T15:45:00Z, the Sunday closing that week.
  const sundayNight = new Date('2026-09-13T15:45:00Z');

  assert.equal(manilaWeekStart(mondayMorning), '2026-09-07');
  assert.equal(manilaWeekStart(sundayNight), '2026-09-07');
});

test('a UTC-naive truncation would get Monday 00:15 Manila wrong', () => {
  const mondayMorning = new Date('2026-09-06T16:15:00Z');
  // What date_trunc('week', ts) WITHOUT the Manila conversion would see:
  // the instant's own UTC calendar date is Sunday 2026-09-06, so a
  // naive implementation reports the previous week (Monday 2026-08-31).
  const naiveUtcDow = mondayMorning.getUTCDay(); // 0 = Sunday
  assert.equal(naiveUtcDow, 0, 'sanity: the instant is Sunday in raw UTC');
  assert.notEqual(manilaWeekStart(mondayMorning), '2026-08-31');
  assert.equal(manilaWeekStart(mondayMorning), '2026-09-07');
});

test('the 31 December / 1 January boundary', () => {
  // 1 Jan 2026 00:30 Manila == 2025-12-31T16:30:00Z. 1 Jan 2026 is a
  // Thursday, so the correct Manila week_start is Monday 2025-12-29 —
  // in the OLD year, even though the instant itself is already in the
  // new UTC year.
  const newYearManila = new Date('2025-12-31T16:30:00Z');
  assert.equal(manilaWeekStart(newYearManila), '2025-12-29');

  // 31 Dec 2025 23:59 Manila == 2025-12-31T15:59:00Z, still the same week.
  const lastMomentOfYear = new Date('2025-12-31T15:59:00Z');
  assert.equal(manilaWeekStart(lastMomentOfYear), '2025-12-29');
});

test('manilaWeekBounds spans exactly Monday 00:00:00.000 to Sunday 23:59:59.999 Manila', () => {
  const { start, end } = manilaWeekBounds('2026-09-07');

  assert.equal(start.toISOString(), '2026-09-06T16:00:00.000Z'); // Mon 00:00 Manila
  assert.equal(end.toISOString(), '2026-09-13T15:59:59.999Z'); // Sun 23:59:59.999 Manila
  assert.equal(end.getTime() - start.getTime(), 7 * 24 * 60 * 60 * 1000 - 1);

  // Every instant asserted to be "in" the week by manilaWeekStart must
  // fall inside these bounds, and vice versa.
  assert.ok(new Date('2026-09-06T16:15:00Z').getTime() >= start.getTime());
  assert.ok(new Date('2026-09-13T15:45:00Z').getTime() <= end.getTime());
});

test('weeksBetween counts whole ISO weeks between two week_start values', () => {
  assert.equal(weeksBetween('2026-09-07', '2026-09-07'), 0);
  assert.equal(weeksBetween('2026-09-07', '2026-09-14'), 1);
  assert.equal(weeksBetween('2026-09-07', '2026-08-31'), -1);
  assert.equal(weeksBetween('2025-12-29', '2026-01-05'), 1);
});

test('manilaWeekStart defaults to "now" without throwing', () => {
  const result = manilaWeekStart();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('manilaWeekBounds rejects a non-date string', () => {
  assert.throws(() => manilaWeekBounds('not-a-date'));
});

test('weeksBetween rejects non-date input', () => {
  assert.throws(() => weeksBetween('nope', '2026-09-07'));
});

// ---------------------------------------------------------------------
// manilaDayStart / manilaDayBounds — the activity heatmap's day
// grouping (DESIGN.md §19.1). Same failure mode as manilaWeekStart
// above, one day's width instead of seven: a UTC-naive grouping puts a
// clear made near midnight Manila into the wrong square.
// ---------------------------------------------------------------------

test('a clear at 23:59 Manila and one at 00:01 Manila (two minutes apart) land in different days', () => {
  // Tue 15 Sep 2026 23:59 Manila == 2026-09-15T15:59:00Z.
  const lateTuesday = new Date('2026-09-15T15:59:00Z');
  // Wed 16 Sep 2026 00:01 Manila == 2026-09-15T16:01:00Z — two minutes
  // later in real time, but the Manila calendar has already turned over.
  const earlyWednesday = new Date('2026-09-15T16:01:00Z');

  assert.equal(manilaDayStart(lateTuesday), '2026-09-15');
  assert.equal(manilaDayStart(earlyWednesday), '2026-09-16');
  assert.notEqual(manilaDayStart(lateTuesday), manilaDayStart(earlyWednesday));
});

test('a UTC-vs-Manila straddle lands in the Manila day, not the UTC one', () => {
  // 2026-09-15T20:00:00Z is 04:00 Manila on 16 Sep — still Tue in UTC,
  // already Wed in Manila. A UTC-naive grouping would say 15 Sep.
  const straddle = new Date('2026-09-15T20:00:00Z');
  assert.equal(straddle.getUTCDate(), 15, 'sanity: the instant is still the 15th in raw UTC');
  assert.equal(manilaDayStart(straddle), '2026-09-16');
});

test('manilaDayBounds spans exactly 00:00:00.000 to 23:59:59.999 Manila', () => {
  const { start, end } = manilaDayBounds('2026-09-16');
  assert.equal(start.toISOString(), '2026-09-15T16:00:00.000Z');
  assert.equal(end.toISOString(), '2026-09-16T15:59:59.999Z');
  assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000 - 1);

  // Both boundary instants above fall inside the day their manilaDayStart names.
  assert.ok(new Date('2026-09-15T16:01:00Z').getTime() >= start.getTime());
});

test('manilaDayBounds rejects a non-date string', () => {
  assert.throws(() => manilaDayBounds('not-a-date'));
});

test('manilaDayStart defaults to "now" without throwing', () => {
  const result = manilaDayStart();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});
