/**
 * LRA Global Ops :: duration formatting — DESIGN.md §18
 *
 * Chan: "371 hours old… which is annoying." He was right, and it was
 * real: `routes/queue.tsx`, `routes/founder-digest.tsx` and
 * `routes/points.tsx` all rendered `{n}h` with no ceiling, so a task
 * blocked for over two weeks read as a three-digit hour count nobody
 * could act on.
 *
 * One rule, and it is the whole spec: **at most two units, the larger
 * unit first, the smaller unit dropped when it is zero.** No months —
 * the unit of this product is the week, and `1mo 2w` is ambiguous in a
 * way nobody here can act on.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const EIGHT_WEEKS = 8 * WEEK;

/**
 * `371h` → `2w 1d` (371h = 15d 11h = 2w 1d 11h; the third unit, the
 * remaining 11h, is dropped).
 *
 * Never returns an empty string, so a duration slot never collapses —
 * if the source timestamp is absent, the caller renders `—` (DESIGN.md
 * §8), never `formatDuration(0)`.
 */
export function formatDuration(ms: number): string {
  // Never a negative age, and never "in the future" read as a duration.
  if (ms <= 0) return 'now';
  // A zero-hour age is not zero — it is young. Never `0h`.
  if (ms < HOUR) return '<1h';
  if (ms < DAY) {
    return `${Math.floor(ms / HOUR)}h`;
  }
  if (ms < WEEK) {
    const days = Math.floor(ms / DAY);
    const hours = Math.floor((ms - days * DAY) / HOUR);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (ms < EIGHT_WEEKS) {
    const weeks = Math.floor(ms / WEEK);
    const days = Math.floor((ms - weeks * WEEK) / DAY);
    return days > 0 ? `${weeks}w ${days}d` : `${weeks}w`;
  }
  // ≥ 8 weeks: weeks only, however large. No months.
  return `${Math.floor(ms / WEEK)}w`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * `2 weeks, 1 day` — for `aria-label`s and tooltip bodies. A screen
 * reader saying "two double-u one dee" is not an age.
 */
export function formatDurationLong(ms: number): string {
  if (ms <= 0) return 'now';
  if (ms < HOUR) return 'less than 1 hour';
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour');
  if (ms < WEEK) {
    const days = Math.floor(ms / DAY);
    const hours = Math.floor((ms - days * DAY) / HOUR);
    return hours > 0 ? `${plural(days, 'day')}, ${plural(hours, 'hour')}` : plural(days, 'day');
  }
  if (ms < EIGHT_WEEKS) {
    const weeks = Math.floor(ms / WEEK);
    const days = Math.floor((ms - weeks * WEEK) / DAY);
    return days > 0 ? `${plural(weeks, 'week')}, ${plural(days, 'day')}` : plural(weeks, 'week');
  }
  return plural(Math.floor(ms / WEEK), 'week');
}

/**
 * The existing staleness thresholds, moved here and now measured in ms
 * rather than hours (`founder-digest.tsx`'s local `ageTone(hours)` is
 * deleted, not duplicated): `--ink-3` under 8h, `--pending` 8h–24h,
 * `--danger` over 24h.
 */
export function ageTone(ms: number): 'text-ink-3' | 'text-pending' | 'text-danger' {
  if (ms >= 24 * HOUR) return 'text-danger';
  if (ms >= 8 * HOUR) return 'text-pending';
  return 'text-ink-3';
}
