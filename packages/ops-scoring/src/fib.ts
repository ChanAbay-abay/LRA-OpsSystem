/**
 * LRA Ops :: Fibonacci point values — pure, no I/O
 *
 * `ops.task_types.default_points` and `ops.tasks.points_override` are
 * both constrained by a Postgres CHECK to this exact set (migration
 * `20260909090100_ops_catalog_tasks.sql`). This module is the JS mirror
 * of that constraint, the same relationship `weeks.ts` has to
 * `ops.week_start_for()` — so a form can validate a value before it
 * ever reaches the database, and the two can never quietly diverge on
 * what counts as a legal point value.
 */

export const FIB_POINTS = [1, 2, 3, 5, 8, 13, 21] as const;

export type FibPoints = (typeof FIB_POINTS)[number];

/** True only for the exact seven values the catalog's CHECK constraint allows. */
export function isFibPoint(n: number): n is FibPoints {
  return (FIB_POINTS as readonly number[]).includes(n);
}
