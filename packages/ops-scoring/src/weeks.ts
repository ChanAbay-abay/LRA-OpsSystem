/**
 * LRA Ops :: week math — pure, no I/O
 *
 * Every week boundary in this system is computed from Manila local time,
 * never from UTC and never from the browser's clock. PRD.md §3.1 and
 * PLAN.md §8 name this as a standing risk: a UTC-naive implementation is
 * wrong for 8 hours in every 24, and the failure mode is silent — a task
 * cleared at 11pm Manila on a Sunday lands in the wrong week's score.
 *
 * The Philippines does not observe daylight saving time, so "Manila
 * time" is always exactly UTC+8. That lets this module stay a plain
 * offset calculation with no timezone database dependency — the same
 * guarantee `ops.week_start_for()` makes in SQL via
 * `at time zone 'Asia/Manila'`, and this file is the JS mirror of it so
 * the same rule is testable without a database.
 */

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function toManilaWallClock(d: Date): Date {
  // Shifting the instant by +8h and then reading it with UTC getters
  // yields Manila's wall-clock date/time components.
  return new Date(d.getTime() + MANILA_OFFSET_MS);
}

function formatIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The Manila-local ISO week (Monday) that `ts` falls in, as `YYYY-MM-DD`.
 * Mirrors `ops.week_start_for()` exactly: `date_trunc('week', ts at time
 * zone 'Asia/Manila')` — ISO weeks start Monday.
 */
export function manilaWeekStart(ts: Date = new Date()): string {
  const wall = toManilaWallClock(ts);
  const jsDow = wall.getUTCDay(); // 0=Sun .. 6=Sat
  const isoDow = jsDow === 0 ? 7 : jsDow; // 1=Mon .. 7=Sun
  const daysSinceMonday = isoDow - 1;
  const monday = new Date(wall.getTime() - daysSinceMonday * DAY_MS);
  return formatIsoDate(monday);
}

/**
 * The real-world UTC instants a Manila week (`YYYY-MM-DD` Monday)
 * spans: Monday 00:00:00.000 Manila through Sunday 23:59:59.999 Manila.
 */
export function manilaWeekBounds(weekStart: string): { start: Date; end: Date } {
  const [y, m, d] = weekStart.split('-').map(Number);
  if (!y || !m || !d) {
    throw new Error(`manilaWeekBounds: "${weekStart}" is not a YYYY-MM-DD date`);
  }
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - MANILA_OFFSET_MS;
  const endMs = startMs + 7 * DAY_MS - 1;
  return { start: new Date(startMs), end: new Date(endMs) };
}

/** Whole ISO weeks between two `YYYY-MM-DD` Monday week_start values. */
export function weeksBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) {
    throw new Error(`weeksBetween: expected two YYYY-MM-DD dates, got "${a}", "${b}"`);
  }
  return Math.round((db - da) / (7 * DAY_MS));
}
