/**
 * LRA Global Ops :: date formatting unit tests — DESIGN.md §22.2
 *
 * The whole point of `manilaDayKey` is that a UTC-day grouping and a
 * Manila-day grouping disagree right around midnight Manila (UTC+8,
 * no DST) — that disagreement is the bug this module exists to fix, so
 * it is the thing these tests aim straight at.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtCalendarDate,
  fmtCalendarDateLong,
  fmtDate,
  fmtDateTime,
  fmtDayHeading,
  fmtTime,
  fmtWeekRange,
  manilaDayKey,
  weekLabel,
} from './dates';

describe('manilaDayKey — groups by the Manila calendar day, not UTC', () => {
  test('23:59 and 00:01 Manila, two minutes apart in real time, group under different days', () => {
    // 2026-09-15 23:59 Manila (UTC+8) = 2026-09-15 15:59 UTC.
    const lateInDay = '2026-09-15T15:59:00Z';
    // 2026-09-16 00:01 Manila = 2026-09-15 16:01 UTC — same UTC calendar
    // day as the row above, different Manila one.
    const earlyNextDay = '2026-09-15T16:01:00Z';
    assert.equal(manilaDayKey(lateInDay), '2026-09-15');
    assert.equal(manilaDayKey(earlyNextDay), '2026-09-16');
    assert.notEqual(manilaDayKey(lateInDay), manilaDayKey(earlyNextDay));
  });

  test('a UTC-midnight instant is already well into the next Manila day', () => {
    // 2026-09-15T00:00:00Z is 08:00 Manila on the SAME UTC date, not a
    // boundary case by itself, but it is the case a naive `new
    // Date(iso).getDate()` (reading the browser's own zone rather than
    // Manila) would get right by accident and hide the real bug.
    assert.equal(manilaDayKey('2026-09-15T00:00:00Z'), '2026-09-15');
  });

  test('a UTC afternoon instant has already rolled into the next Manila day', () => {
    // 2026-09-15T20:00:00Z = 2026-09-16 04:00 Manila.
    assert.equal(manilaDayKey('2026-09-15T20:00:00Z'), '2026-09-16');
  });
});

describe('fmtTime — 24-hour, no seconds, Manila', () => {
  test('formats HH:MM zero-padded', () => {
    assert.equal(fmtTime('2026-09-15T06:05:00Z'), '14:05');
  });

  test('never renders midnight as 24:00', () => {
    // 2026-09-15T16:00:00Z = 2026-09-16 00:00 Manila.
    assert.equal(fmtTime('2026-09-15T16:00:00Z'), '00:00');
  });
});

describe('fmtDate / fmtDateTime', () => {
  test('fmtDate reads `D Mon YYYY`', () => {
    assert.equal(fmtDate('2026-09-15T06:05:00Z'), '15 Sep 2026');
  });

  test('fmtDateTime carries the weekday, the time, and the zone label', () => {
    assert.equal(fmtDateTime('2026-09-15T06:05:00Z'), 'Tue 15 Sep 2026, 14:05 (Asia/Manila)');
  });
});

describe('fmtDayHeading — today / yesterday / this year / other year', () => {
  // A fixed "now": 2026-09-15 14:00 Manila.
  const now = new Date('2026-09-15T06:00:00Z');

  test('today', () => {
    assert.equal(fmtDayHeading('2026-09-15T07:00:00Z', now), 'TODAY · TUE 15 SEP');
  });

  test('yesterday', () => {
    assert.equal(fmtDayHeading('2026-09-14T07:00:00Z', now), 'YESTERDAY · MON 14 SEP');
  });

  test('earlier this year drops the year', () => {
    assert.equal(fmtDayHeading('2026-01-05T07:00:00Z', now), 'MON 5 JAN');
  });

  test('a prior year carries the year', () => {
    // 2025-09-15 is a Monday, unlike the "now" reference year's Tuesday.
    assert.equal(fmtDayHeading('2025-09-15T07:00:00Z', now), 'MON 15 SEP 2025');
  });

  test('the 23:59/00:01 boundary lands on the correct heading', () => {
    // 2026-09-14 23:59 Manila -> still "yesterday" relative to `now`.
    assert.equal(fmtDayHeading('2026-09-14T15:59:00Z', now), 'YESTERDAY · MON 14 SEP');
    // 2026-09-15 00:01 Manila -> already "today".
    assert.equal(fmtDayHeading('2026-09-14T16:01:00Z', now), 'TODAY · TUE 15 SEP');
  });
});

describe('fmtWeekRange', () => {
  test('same month — one month name, en dash', () => {
    assert.equal(fmtWeekRange('2026-09-15', '2026-09-21'), '15–21 Sep 2026');
  });

  test('crossing a month boundary names both', () => {
    assert.equal(fmtWeekRange('2026-09-29', '2026-10-05'), '29 Sep–5 Oct 2026');
  });

  test('crossing a year boundary names both years', () => {
    assert.equal(fmtWeekRange('2025-12-29', '2026-01-04'), '29 Dec 2025–4 Jan 2026');
  });
});

describe('weekLabel', () => {
  test('formats as `W<n> · <year>`', () => {
    assert.equal(weekLabel('2026-09-15'), 'W38 · 2026');
  });
});

describe('fmtCalendarDate / fmtCalendarDateLong — the activity heatmap (§19.6)', () => {
  test('a bare YYYY-MM-DD (already the Manila day) formats short and long', () => {
    // 2026-09-15 is a Tuesday.
    assert.equal(fmtCalendarDate('2026-09-15'), 'Tue 15 Sep 2026');
    assert.equal(fmtCalendarDateLong('2026-09-15'), 'Tuesday 15 September 2026');
  });

  test('a Monday parses as Monday, not shifted by a timezone re-derivation', () => {
    assert.equal(fmtCalendarDate('2026-09-14'), 'Mon 14 Sep 2026');
  });

  test('a year boundary carries the correct year on both sides', () => {
    assert.equal(fmtCalendarDate('2025-12-31'), 'Wed 31 Dec 2025');
    assert.equal(fmtCalendarDate('2026-01-01'), 'Thu 1 Jan 2026');
  });
});
