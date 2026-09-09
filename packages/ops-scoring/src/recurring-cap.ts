/**
 * LRA Ops :: the recurring cap — pure, no I/O
 *
 * PLAN.md §2.6: "The recurring cap is applied in `packages/ops-scoring`,
 * on top of [`ops.v_point_balances`], never in SQL. The ledger stores
 * true cleared points; the scorecard computes the capped figure; both
 * are shown, with the capped one labelled, so nobody discovers a silent
 * haircut." That sentence is the whole reason this is a separate,
 * independently testable function instead of a SQL `case` buried in a
 * view: a haircut nobody can see coming is worse than no cap at all.
 *
 * The rule, in words: recurring work may contribute at most
 * `recurring_cap_pct` of a person's *effective* total for the week
 * (new + counted-recurring), so a week entirely full of recurring
 * chores cannot read as equal to a week of real, new work. But a
 * person who did nothing but their recurring load should not be
 * credited zero either — `recurring_floor_points` guarantees a floor,
 * because "you did your recurring duties" is still real work.
 *
 * Solving `cappedR / (N + cappedR) = capPct` for `cappedR` gives
 * `cappedR = capPct * N / (1 - capPct)`. Floored to an integer point
 * value (points are always whole numbers here), which is why the
 * resulting ratio ends up strictly *at or under* `capPct`, never
 * exactly equal to it in general.
 */

export interface RecurringCapInput {
  /** Points cleared this week from non-recurring tasks. */
  newPoints: number;
  /** Points cleared this week from recurring tasks, uncapped. */
  recurringPoints: number;
  /** `ops.settings.recurring_cap_pct` — in [0, 1). */
  capPct: number;
  /** `ops.settings.recurring_floor_points` — the guaranteed minimum recurring credit. */
  floorPoints: number;
}

export interface RecurringCapResult {
  /** Recurring points actually counted, after the cap and the floor. */
  cappedRecurringPoints: number;
  /** `newPoints + cappedRecurringPoints` — the figure shown as "capped score". */
  totalPoints: number;
  /** `cappedRecurringPoints / totalPoints`, or 0 when `totalPoints` is 0. */
  recurringRatio: number;
}

export function applyRecurringCap({
  newPoints,
  recurringPoints,
  capPct,
  floorPoints,
}: RecurringCapInput): RecurringCapResult {
  if (recurringPoints <= 0) {
    return { cappedRecurringPoints: 0, totalPoints: Math.max(0, newPoints), recurringRatio: 0 };
  }

  // capPct is DB-constrained to [0, 1), but a defensive clamp costs
  // nothing and keeps this function safe to call with a raw settings
  // row that has not been through zod yet.
  const pct = Math.min(0.999, Math.max(0, capPct));

  const computedCap = pct <= 0 ? 0 : Math.floor((pct * newPoints) / (1 - pct));
  const beforeFloor = Math.min(recurringPoints, computedCap);
  const cappedRecurringPoints = Math.min(recurringPoints, Math.max(floorPoints, beforeFloor));

  const totalPoints = Math.max(0, newPoints) + cappedRecurringPoints;
  const recurringRatio = totalPoints > 0 ? cappedRecurringPoints / totalPoints : 0;

  return { cappedRecurringPoints, totalPoints, recurringRatio };
}
