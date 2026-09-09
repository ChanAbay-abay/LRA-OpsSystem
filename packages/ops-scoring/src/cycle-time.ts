/**
 * LRA Ops :: cycle time, median, staleness — pure, no I/O
 *
 * PRD.md §4's table: cycle time is `cleared_at - first_in_progress_at`,
 * minus total blocked time, reported per person as a **median** (a
 * mean lets one three-week task swamp the number). Staleness is a
 * `todo`/`in_progress` task with no movement for `stale_after_days`,
 * mirroring `apps/api/src/services/stale.ts`'s own cutoff so the same
 * "3+ days" rule is testable without a database.
 */

/** Hours between two instants, with blocked hours subtracted and never negative. */
export function cycleTimeHours(startedAt: Date, clearedAt: Date, blockedHours = 0): number {
  const rawHours = (clearedAt.getTime() - startedAt.getTime()) / 3_600_000;
  return Math.max(0, rawHours - Math.max(0, blockedHours));
}

/** The median of a list of numbers. Averages the two middle values for an even-length list. */
export function median(xs: number[]): number {
  if (xs.length === 0) {
    throw new Error('median: cannot take the median of an empty list');
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** True once `lastActivityAt` is at least `staleAfterDays` old, relative to `now`. */
export function isStale(lastActivityAt: Date, now: Date, staleAfterDays = 3): boolean {
  const days = (now.getTime() - lastActivityAt.getTime()) / 86_400_000;
  return days >= staleAfterDays;
}
