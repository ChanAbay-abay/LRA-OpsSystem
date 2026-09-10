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

/** One cleared (or still-open) task's raw inputs for a person's median cycle time. */
export interface CycleTimeTaskInput {
  /** `ops.tasks.first_in_progress_at` — null for a task with no recorded start
   *  (pre-dates the column, or never entered `in_progress`). Excluded, never
   *  treated as zero: a fabricated start would understate the true duration. */
  firstInProgressAt: Date | null;
  /** `ops.tasks.cleared_at` — null for a task still open. Excluded: an open
   *  task has no cycle time yet, not a cycle time of zero. */
  clearedAt: Date | null;
  /** Total hours the task spent blocked, already summed across its blocks. */
  blockedHours?: number;
}

export interface MedianCycleTimeResult {
  /** null when there is nothing to compute a median over. */
  medianHours: number | null;
  /** How many tasks the median was computed from — always shown next to the
   *  figure (PRD.md §4/§6.5): a median of 2 and a median of 40 are different
   *  claims. */
  sampleSize: number;
}

/**
 * A person's median cycle time (PRD.md §4: `cleared_at - first_in_progress_at`,
 * minus blocked time, reported as a median so one three-week task cannot
 * swamp the number). Only tasks with BOTH a recorded start and a clear time
 * enter the sample; everything else is excluded, not zeroed.
 */
export function medianCycleTimeHours(tasks: CycleTimeTaskInput[]): MedianCycleTimeResult {
  const hours = tasks
    .filter((t) => t.firstInProgressAt != null && t.clearedAt != null)
    .map((t) => cycleTimeHours(t.firstInProgressAt as Date, t.clearedAt as Date, t.blockedHours ?? 0));

  return {
    medianHours: hours.length > 0 ? median(hours) : null,
    sampleSize: hours.length,
  };
}
