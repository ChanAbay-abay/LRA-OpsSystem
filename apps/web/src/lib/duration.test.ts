/**
 * LRA Global Ops :: duration formatting unit tests — DESIGN.md §18
 *
 * Boundary cases matter more than the middle of a range here: every
 * threshold in `formatDuration` is a place the display word for a task's
 * age jumps to a different unit, and getting one off-by-one wrong is
 * exactly how `founder-digest.tsx` grew an uncapped `{n}h` in the first
 * place.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ageTone, formatDuration, formatDurationLong } from './duration';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe('formatDuration — at most two units, larger first, zero remainder dropped', () => {
  test('zero, negative and future ages all read as "now"', () => {
    assert.equal(formatDuration(0), 'now');
    assert.equal(formatDuration(-1), 'now');
    assert.equal(formatDuration(-HOUR), 'now');
  });

  test('under an hour is "<1h", never "0h"', () => {
    assert.equal(formatDuration(1), '<1h');
    assert.equal(formatDuration(HOUR - 1), '<1h');
  });

  test('under a day floors to whole hours', () => {
    assert.equal(formatDuration(HOUR), '1h');
    assert.equal(formatDuration(7 * HOUR), '7h');
    assert.equal(formatDuration(DAY - 1), '23h');
  });

  test('exactly 24 hours is 1 day, not "24h"', () => {
    assert.equal(formatDuration(DAY), '1d');
  });

  test('under a week is days plus a nonzero hour remainder, dropped when zero', () => {
    assert.equal(formatDuration(2 * DAY + 4 * HOUR), '2d 4h');
    assert.equal(formatDuration(2 * DAY), '2d');
    assert.equal(formatDuration(WEEK - 1), '6d 23h');
  });

  test('exactly 7 days is 1 week, not "7d"', () => {
    assert.equal(formatDuration(WEEK), '1w');
  });

  test('under 8 weeks is weeks plus a nonzero day remainder, dropped when zero', () => {
    assert.equal(formatDuration(3 * WEEK), '3w');
    assert.equal(formatDuration(3 * WEEK + 2 * DAY), '3w 2d');
  });

  test('the worked example: 371h is 2w 1d, the third unit (11h) dropped', () => {
    assert.equal(formatDuration(371 * HOUR), '2w 1d');
  });

  test('8 weeks and beyond is weeks only — no months, however large', () => {
    assert.equal(formatDuration(8 * WEEK), '8w');
    assert.equal(formatDuration(12 * WEEK + 3 * DAY), '12w');
    assert.equal(formatDuration(52 * WEEK), '52w');
  });
});

describe('formatDurationLong — the aria/tooltip spelling', () => {
  test('pluralises correctly at the singular boundary', () => {
    assert.equal(formatDurationLong(HOUR), '1 hour');
    assert.equal(formatDurationLong(2 * HOUR), '2 hours');
    assert.equal(formatDurationLong(DAY), '1 day');
    assert.equal(formatDurationLong(WEEK), '1 week');
  });

  test('the worked example reads "2 weeks, 1 day"', () => {
    assert.equal(formatDurationLong(371 * HOUR), '2 weeks, 1 day');
  });

  test('zero and under-an-hour ages', () => {
    assert.equal(formatDurationLong(0), 'now');
    assert.equal(formatDurationLong(HOUR - 1), 'less than 1 hour');
  });
});

describe('ageTone — the existing staleness thresholds, in ms', () => {
  test('under 8 hours is neutral', () => {
    assert.equal(ageTone(0), 'text-ink-3');
    assert.equal(ageTone(8 * HOUR - 1), 'text-ink-3');
  });

  test('8h up to 24h is pending', () => {
    assert.equal(ageTone(8 * HOUR), 'text-pending');
    assert.equal(ageTone(24 * HOUR - 1), 'text-pending');
  });

  test('24h and over is danger', () => {
    assert.equal(ageTone(24 * HOUR), 'text-danger');
    assert.equal(ageTone(371 * HOUR), 'text-danger');
  });
});
