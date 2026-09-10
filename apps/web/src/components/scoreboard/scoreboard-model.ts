/**
 * LRA Global Ops :: scoreboard model — types and the arithmetic behind
 * the person cards
 *
 * Everything on `/scoreboard` that a person could argue about is
 * computed here, in a plain module with no React and no DOM, so it can
 * be unit-tested directly (the level `lib/task-permissions.ts` and
 * `lib/task-menu-items.ts` are already tested at). The card components
 * only lay these values out.
 *
 * The four buckets and `possible` come straight off the API
 * (`GET /api/scoreboard`, build contract §D) and are deliberately named
 * in DESIGN.md §6's bank-balance vocabulary rather than a new one:
 * `completed` is settled money, `pending` is money waiting to clear,
 * `toDo` is committed-but-unsubmitted, and `atRisk` is a task awaiting a
 * cancellation decision — still on the plate, because nobody has
 * decided otherwise yet.
 *
 * Two rules live here rather than in JSX because getting either wrong is
 * a silent lie about someone's week:
 *
 *   1. `possible === 0` is not 100%. A person with nothing assigned has
 *      no proportion at all, and `sharePercent` returns `null` for it so
 *      the card renders an absence (DESIGN.md §8: `0` and "no data" must
 *      look different) instead of a full green bar.
 *   2. The recurring cap (PRD.md §3.4, PLAN.md §2.6) must never land as
 *      a *silent* haircut. Chan: "i dont see a point in seeing the raw
 *      points" — so the permanent `capped / raw raw` readout is gone,
 *      but `capDisclosure` still reports, per person, when the capped
 *      score differs from the true cleared total, and the card shows it
 *      where it applies.
 */
import type { ReliabilityBand } from '@/lib/reliability-ui';
// Relative, not `@/lib/labels` — this module is unit-tested directly by
// `node --test`, which resolves imports with plain Node module
// resolution and has no Vite alias to expand `@/`. A `type`-only import
// (like the `ReliabilityBand` one above) gets erased and never hits
// this problem; `periodTabLabel` is a real runtime import, so it needs
// a path Node can actually follow.
import { periodTabLabel, type PeriodKey } from '../../lib/labels';

export type { PeriodKey };

export const PERIOD_KEYS: readonly PeriodKey[] = ['week', 'month', 'quarter', 'all'];

/**
 * Chan asked for "this week, month, 3 month, and overall". Those are
 * *intents*; the number of weeks a window actually covers is a fact the
 * API sends back in `weekCount`. The tabs carry the intent (so two tabs
 * never end up with the same label on a young dataset) and the caption
 * carries the fact — see `periodShortfall`.
 *
 * DESIGN.md §17.1's move table: the words now live in `lib/labels.ts`.
 * Sourced from there so `period-tabs.tsx`'s call site needs no change.
 */
export const PERIOD_TAB_LABEL: Record<PeriodKey, string> = {
  week: periodTabLabel('week'),
  month: periodTabLabel('month'),
  quarter: periodTabLabel('quarter'),
  all: periodTabLabel('all'),
};

/** Weeks each window is *meant* to span. `all` spans whatever exists. */
const NOMINAL_WEEKS: Record<PeriodKey, number | null> = {
  week: 1,
  month: 4,
  quarter: 13,
  all: null,
};

export interface PointBuckets {
  /** The server's own words for the window, e.g. "Last 13 weeks". */
  label: string;
  /** Weeks actually in the window (for `all`, weeks that exist at all). */
  weekCount: number;
  /** Committed but not yet submitted: todo, in_progress, rejected. */
  toDo: number;
  /** Submitted or verified — with GM or with the founder. */
  pending: number;
  /** Cleared. Settled money. */
  completed: number;
  /** `pending_cancellation` — undecided, so not yet off the plate. */
  atRisk: number;
  /** toDo + pending + completed + atRisk. `cancelled` is in none of them. */
  possible: number;
  taskCounts: { toDo: number; pending: number; completed: number; atRisk: number };
}

export interface CurrentWeekPoints {
  rawClearedPoints: number;
  cappedScore: number;
  cappedRecurringPoints: number;
  rawRecurringPoints: number;
}

export interface ScoreboardRow {
  userId: string;
  name: string | null;
  position: string;
  currentWeek: CurrentWeekPoints;
  periods: Record<PeriodKey, PointBuckets>;
  // PLAN.md §10 #4: absent, not just falsy, for anyone who isn't
  // founder/admin — `apps/api/src/routes/scoreboard.ts` strips both
  // fields from the JSON before it leaves the server. Points, cleared
  // totals, velocity and the four buckets are unaffected: Chan's
  // explicit "staff keep those" instruction, and PLAN.md §10.2's
  // reasoning that the point system is a self-tracking instrument for
  // the person doing the work.
  lastClosedWeek?: { hitRate: number | null } | null;
  reliability?: { score: number | null; band: ReliabilityBand; ratedWeeks: number };
}

export interface ScoreboardSummary {
  visibility: 'all' | 'oversight_only';
  weekId: string;
  weekStart: string;
  rows: ScoreboardRow[];
}

/** The bar's segments, left to right in the direction of custody. */
export type SegmentKey = 'completed' | 'pending' | 'atRisk' | 'toDo';

export interface Segment {
  key: SegmentKey;
  points: number;
  /** Exact fraction of `possible`, 0–100. Not rounded — it drives a width. */
  percent: number;
}

const SEGMENT_ORDER: readonly SegmentKey[] = ['completed', 'pending', 'atRisk', 'toDo'];

/**
 * Left-to-right because that is the direction of release in this whole
 * system (DESIGN.md §1): settled first, then waiting to clear, then
 * undecided, then not started. Always returns all four segments,
 * including zero ones — the card decides not to paint a zero-width
 * sliver, but nothing here silently drops a bucket.
 */
export function bucketSegments(b: PointBuckets): Segment[] {
  const total = b.possible;
  return SEGMENT_ORDER.map((key) => ({
    key,
    points: b[key],
    percent: total > 0 ? (b[key] / total) * 100 : 0,
  }));
}

/**
 * Completed as a share of possible, or `null` when there is nothing to
 * take a share of. `null` is the whole point: 0/0 is not 100%, and it is
 * not 0% either — it is "nothing was on this person's plate in this
 * window", which the card renders as an em dash per DESIGN.md §8.
 */
export function sharePercent(b: PointBuckets): number | null {
  if (b.possible <= 0) return null;
  return Math.round((b.completed / b.possible) * 100);
}

/**
 * How many weeks short of its nominal span this window actually is.
 * `0` when the window is full, `null` when the window has no nominal
 * span (`all`). Drives the caption's honesty: a "13 weeks" tab on a
 * three-week-old system must not claim thirteen weeks of history.
 */
export function periodShortfall(key: PeriodKey, b: PointBuckets): number | null {
  const nominal = NOMINAL_WEEKS[key];
  if (nominal == null) return null;
  return Math.max(0, nominal - b.weekCount);
}

/**
 * The window caption under the tabs. Uses the server's own `label`
 * verbatim, then states the shortfall when there is one — so
 * "Last 13 weeks" never silently means three.
 *
 * `weekStart` (the summary's reference week) is what stops the caption
 * degenerating into a second copy of the pressed tab. On a full `week`
 * window the label alone is literally the tab's own text, which is a
 * line of screen real estate telling the reader something they just
 * clicked; naming the actual week is the information they don't have.
 */
export function periodCaption(key: PeriodKey, b: PointBuckets, weekStart?: string): string {
  const shortfall = periodShortfall(key, b);
  if (shortfall == null) {
    return `${b.label} · ${b.weekCount} ${b.weekCount === 1 ? 'week' : 'weeks'} of history`;
  }
  if (shortfall === 0) {
    if (key === 'week' && weekStart) return `${b.label} · beginning ${formatWeekStart(weekStart)}`;
    return b.label;
  }
  return `${b.label} · only ${b.weekCount} ${b.weekCount === 1 ? 'week' : 'weeks'} of history so far`;
}

/**
 * `ops.weeks.week_start` is a DATE ("2026-09-08"), so it is parsed as a
 * plain calendar day and never through `new Date(iso)` — that would read
 * it as UTC midnight and render the Sunday before in Manila.
 */
function formatWeekStart(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  if (!y || !m || !d) return weekStart;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export interface CapDisclosure {
  /** True cleared points in the current week — what the ledger records. */
  raw: number;
  /** What the week actually scores after the recurring cap. */
  capped: number;
  rawRecurring: number;
  cappedRecurring: number;
  /** Points the cap removed. Always > 0 when a disclosure exists. */
  haircut: number;
}

/**
 * PLAN.md §2.6: "the ledger stores true cleared points; the scorecard
 * computes the capped figure; both are shown, with the capped one
 * labelled, so nobody discovers a silent haircut." Chan killed the
 * permanent two-number readout, not the disclosure — so this returns
 * `null` (nothing to say) for the overwhelmingly common case where the
 * cap did not bite, and the numbers to say it with when it did.
 *
 * Deliberately scoped to the *current week*: `cappedScore` is a weekly
 * figure by construction (PRD.md §3.4 caps recurring work per person per
 * week) and the API does not compute a capped total for a 4- or 13-week
 * window. Attaching a this-week haircut to a 13-week completed figure
 * would be a new, quieter lie than the one Chan asked to remove, so the
 * card only shows this on the "This week" period.
 */
export function capDisclosure(cw: CurrentWeekPoints): CapDisclosure | null {
  if (cw.cappedScore >= cw.rawClearedPoints) return null;
  return {
    raw: cw.rawClearedPoints,
    capped: cw.cappedScore,
    rawRecurring: cw.rawRecurringPoints,
    cappedRecurring: cw.cappedRecurringPoints,
    haircut: cw.rawClearedPoints - cw.cappedScore,
  };
}

/** The full sentence, for the chip's tooltip and its screen-reader text. */
export function capSentence(d: CapDisclosure): string {
  return (
    `Recurring cap: ${d.rawRecurring} recurring points cleared, ${d.cappedRecurring} of them count. ` +
    `${d.raw} cleared points score as ${d.capped} this week (−${d.haircut}).`
  );
}

const PERIOD_STORAGE_KEY = 'lra.scoreboard.period';

export { PERIOD_STORAGE_KEY };

/**
 * The remembered period. Follows `board.tsx`'s `OWNER_FILTER_KEY`
 * precedent rather than inventing a second persistence idiom, and
 * validates what comes back — `localStorage` can hold anything, and an
 * unrecognised key would index `periods` with `undefined` and crash the
 * rail.
 */
export function readStoredPeriod(raw: string | null): PeriodKey {
  return PERIOD_KEYS.includes(raw as PeriodKey) ? (raw as PeriodKey) : 'week';
}
