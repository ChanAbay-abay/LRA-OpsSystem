/**
 * LRA Ops :: the reliability score — pure, no I/O
 *
 * PRD.md §5.2, verbatim spine:
 *
 *   λ = 0.5 ^ (1/3)                                    (a 3-week half-life)
 *           Σ  λ^i × cleared_committed_points(i)
 *   base =  ────────────────────────────────────
 *           Σ  λ^i × committed_points(i)
 *   reliability = clamp(0, 100, round(100 × base) + modifiers)
 *
 * with `i = 0` the most recent of the last 8 *completed* weeks.
 *
 * PLAN.md §8's risk table calls this "a management instrument with no
 * visible failure mode" — a wrong number does not crash, does not look
 * wrong, and quietly misrepresents a real person's work. Two design
 * choices exist specifically to keep that honest:
 *
 * 1. **Weeks with zero commitment contribute to neither sum.** This
 *    falls out of the arithmetic for free (a week with
 *    `committedPoints = 0` contributes `weight * 0` to both the
 *    numerator and the denominator), but `ratedWeeks` is tracked
 *    separately from "did this week affect the ratio" so a person who
 *    never commits cannot accidentally read as `UNRATED` forever *or*
 *    as perfectly reliable — they render `UNRATED` until they have at
 *    least `minWeeksForRating` weeks where they actually committed to
 *    something.
 * 2. **`weeklyBreakdown` is returned, not just the final number** —
 *    PLAN.md's own verification step demands a hand-computable result,
 *    and the profile screen (PLAN.md's coder brief, "reliability must
 *    always show its inputs") renders this array directly so anyone
 *    can add it up themselves.
 *
 * Blocked-time exoneration (PRD.md §5.2): "If your commitment failed
 * while a declared, unresolved block was open against it, that
 * commitment is excluded from your denominator for that week." The
 * caller (the API route, which has database access this package does
 * not) resolves that to a plain number per week — `exoneratedPoints`,
 * the committed points to strip from that week's denominator — so this
 * module stays pure. A week's `effectiveDenominator` is
 * `max(0, committedPoints - exoneratedPoints)`.
 */

export interface ReliabilityWeek {
  weekId: string;
  weekStart: string;
  /** Total points committed to at the briefing for this week. */
  committedPoints: number;
  /** Of those, the points from tasks that actually cleared. */
  clearedCommittedPoints: number;
  /**
   * Committed points to exclude from the denominator because a block
   * was declared against the task before the week ended and the
   * commitment did not clear. Defaults to 0 (no exoneration).
   */
  exoneratedPoints?: number;
}

export interface ReliabilityModifiers {
  /** Count of tasks currently carried 3+ consecutive weeks. −2 each, capped −10. */
  chronicCarryOverTasks?: number;
  /** Count of tasks currently flagged stale. −1 each, capped −5. */
  staleTaskCount?: number;
  /** Total hours of other people's work this person has blocked. −1 per 8h, capped −10. */
  blockedHoursCausedToOthers?: number;
  /** True when, in the single most recent rated week, 100% of commitments cleared. +3, this week only. */
  cleanSweepThisWeek?: boolean;
}

export interface ReliabilityOptions {
  /** `ops.settings.reliability_window_weeks`. Default 8. */
  windowWeeks?: number;
  /** `ops.settings.reliability_half_life_weeks`. Default 3. */
  halfLifeWeeks?: number;
  /** `ops.settings.min_weeks_for_rating`. Default 3. */
  minWeeksForRating?: number;
}

export type ReliabilityBand = 'excellent' | 'solid' | 'watch' | 'at_risk' | 'unrated';

export interface ReliabilityWeekContribution {
  weekId: string;
  weekStart: string;
  weight: number;
  committedPoints: number;
  clearedCommittedPoints: number;
  exoneratedPoints: number;
  effectiveDenominator: number;
  /** False when this week's effective denominator is 0 (nothing to rate, exonerated away). */
  includedInRating: boolean;
}

export interface ReliabilityModifierBreakdown {
  chronicCarryOver: number;
  staleness: number;
  blockingOthers: number;
  cleanSweep: number;
  total: number;
}

export interface ReliabilityResult {
  /** `null` exactly when the person has fewer than `minWeeksForRating` committed weeks — UNRATED, never a numeric default. */
  score: number | null;
  band: ReliabilityBand;
  /** The unrounded, pre-modifier hit-rate ratio (0..1). */
  base: number;
  weightedCleared: number;
  weightedCommitted: number;
  modifiers: ReliabilityModifierBreakdown;
  /** Weeks where `committedPoints > 0` — the UNRATED threshold counts these, not weeks in the window. */
  ratedWeeks: number;
  /** Per-week arithmetic, most recent first, so a reader can recompute `base` by hand. */
  weeklyBreakdown: ReliabilityWeekContribution[];
}

export function reliabilityBand(score: number | null): ReliabilityBand {
  if (score == null) return 'unrated';
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'solid';
  if (score >= 60) return 'watch';
  return 'at_risk';
}

export function reliability(
  weeks: ReliabilityWeek[],
  modifiers: ReliabilityModifiers = {},
  opts: ReliabilityOptions = {}
): ReliabilityResult {
  const windowWeeks = opts.windowWeeks ?? 8;
  const halfLifeWeeks = opts.halfLifeWeeks ?? 3;
  const minWeeksForRating = opts.minWeeksForRating ?? 3;

  const lambda = Math.pow(0.5, 1 / halfLifeWeeks);
  const used = weeks.slice(0, windowWeeks);

  let weightedCleared = 0;
  let weightedCommitted = 0;
  let ratedWeeks = 0;

  const weeklyBreakdown: ReliabilityWeekContribution[] = used.map((w, i) => {
    const exoneratedPoints = w.exoneratedPoints ?? 0;
    const effectiveDenominator = Math.max(0, w.committedPoints - exoneratedPoints);
    const weight = Math.pow(lambda, i);
    const includedInRating = effectiveDenominator > 0;

    if (w.committedPoints > 0) ratedWeeks += 1;
    if (includedInRating) {
      weightedCleared += weight * w.clearedCommittedPoints;
      weightedCommitted += weight * effectiveDenominator;
    }

    return {
      weekId: w.weekId,
      weekStart: w.weekStart,
      weight,
      committedPoints: w.committedPoints,
      clearedCommittedPoints: w.clearedCommittedPoints,
      exoneratedPoints,
      effectiveDenominator,
      includedInRating,
    };
  });

  const base = weightedCommitted > 0 ? weightedCleared / weightedCommitted : 0;

  const chronicCarryOver = -Math.min(10, 2 * (modifiers.chronicCarryOverTasks ?? 0));
  const staleness = -Math.min(5, 1 * (modifiers.staleTaskCount ?? 0));
  const blockingOthers = -Math.min(10, Math.floor((modifiers.blockedHoursCausedToOthers ?? 0) / 8));
  const cleanSweep = modifiers.cleanSweepThisWeek ? 3 : 0;
  const modifierTotal = chronicCarryOver + staleness + blockingOthers + cleanSweep;

  const unrated = ratedWeeks < minWeeksForRating;
  const score = unrated ? null : Math.min(100, Math.max(0, Math.round(100 * base) + modifierTotal));

  return {
    score,
    band: reliabilityBand(score),
    base,
    weightedCleared,
    weightedCommitted,
    modifiers: { chronicCarryOver, staleness, blockingOthers, cleanSweep, total: modifierTotal },
    ratedWeeks,
    weeklyBreakdown,
  };
}
