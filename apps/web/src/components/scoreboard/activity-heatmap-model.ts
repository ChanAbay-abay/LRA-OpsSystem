/**
 * LRA Global Ops :: the activity heatmap's pure model — DESIGN.md §19
 *
 * Split out of `activity-heatmap.tsx` for the same reason `use-rail.ts`
 * was split out of `card-rail.tsx`: oxlint's `react(only-export-
 * components)` fast-refresh rule wants a component file to export only
 * components, and everything below is plain data shaping that is far
 * more useful tested directly (`node --test`, no DOM) than exercised
 * through a render.
 *
 * `ActivityWindow`/`ActivityDay` mirror `apps/api/src/routes/
 * scoreboard.ts` field for field — this file does not recompute the day
 * grouping (that already happened server-side, in Manila time, off the
 * same `ops.point_ledger` rows the balance figures read); it only turns
 * that server response into what the grid needs to paint.
 */

export interface ActivityDay {
  /** Manila calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Tasks cleared that day — what the cell's colour encodes (§19.1). */
  count: number;
  /** Points those tasks were worth — the tooltip's second line only, never the colour. */
  points: number;
}

export interface ActivityWindow {
  /** Oldest to newest, always whole Manila weeks (Monday..Sunday). */
  days: ActivityDay[];
  windowWeeks: number;
  /** Sum of `count` across the whole window — the total line (§19.6). */
  totalCleared: number;
  /** The Manila day this person's membership began, or `null` if unknown (§19.5). */
  sinceDate: string | null;
}

/** The five fixed steps (§19.3) — a relative/quartile scale would make a quiet team's best day look identical to its worst, so these never move. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/**
 * `0` / `1` / `2` / `3–4` / `5+` (§19.3). Fixed thresholds, not
 * quartiles of this person's own history — the whole reason being that
 * two people's grids, and a person's own year against itself, stay
 * comparable regardless of how quiet or busy the team is.
 */
export function heatLevelFor(count: number): HeatLevel {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  return 4;
}

/** The legend's own numeral row (§19.6) — the non-colour channel, not decoration. */
export const HEAT_LEVEL_THRESHOLD_LABELS: readonly string[] = ['0', '1', '2', '3–4', '5+'];

export type DayKind = 'before-account' | 'zero' | 'active';

/**
 * Which of the three cell states (§19.5) one day is, for ONE person.
 * `sinceDate == null` (an unknown join date) is treated as "always
 * active" rather than hiding the whole grid behind a missing fact —
 * DESIGN.md never asks for a fourth state, and an unknown date is not
 * evidence the day predates the account.
 */
export function dayKind(day: ActivityDay, sinceDate: string | null): DayKind {
  if (sinceDate != null && day.date < sinceDate) return 'before-account';
  return day.count > 0 ? 'active' : 'zero';
}

/** One grid column: seven days, Monday first (§19.2). */
export type WeekColumn = ActivityDay[];

/**
 * Chunks a flat, oldest-first day list into Monday-first week columns
 * and takes the last `weeks` of them — `days` always arrives as whole
 * weeks already (the API only ever returns full Manila weeks), so this
 * never has to pad a partial week.
 */
export function toWeekColumns(days: ActivityDay[], weeks: number): WeekColumn[] {
  const columns: WeekColumn[] = [];
  for (let i = 0; i < days.length; i += 7) {
    columns.push(days.slice(i, i + 7));
  }
  return columns.slice(-weeks);
}

/**
 * The tasks-cleared total over just the last `weeks` of a window — used
 * wherever a number sits next to a heatmap that shows FEWER weeks than
 * the API's full window (the scoreboard card's mini strip, §23.1's
 * "Velocity" line), so the figure never disagrees with the grid it sits
 * beside. `ActivityWindow.totalCleared` itself always covers the FULL
 * window and is left alone for that reason.
 */
export function sumLastWeeks(days: ActivityDay[], weeks: number): number {
  const slice = days.slice(-weeks * 7);
  return slice.reduce((sum, d) => sum + d.count, 0);
}

/**
 * How many weeks fit a container of `width` px (§19.2's measured, not
 * guessed, clamp): `clamp(floor((width - labelCol - 8) / (cell + gap)), min, max)`.
 * A pure function so the `ResizeObserver` callback in the component has
 * nothing left to get wrong except reading the width.
 */
export function weeksForWidth(
  width: number,
  opts: { labelCol: number; cell: number; gap: number; min: number; max: number }
): number {
  const usable = width - opts.labelCol - 8;
  const perWeek = opts.cell + opts.gap;
  const fit = Math.floor(usable / perWeek);
  return Math.max(opts.min, Math.min(opts.max, fit));
}

/**
 * Month-label placement (§19.2): a label appears above a week column
 * only where the month actually changes AND at least 3 columns have
 * passed since the last label — otherwise adjacent month names collide.
 * Returns the month label (or `null`) for every column, same length as
 * `columns`, so the component can render it as a plain positional map.
 */
export function monthLabelsForColumns(columns: WeekColumn[]): Array<string | null> {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const labels: Array<string | null> = [];
  let lastMonth = -1;
  let sinceLast = Infinity;
  for (const col of columns) {
    const first = col[0];
    const month = first ? Number(first.date.slice(5, 7)) - 1 : -1;
    if (first && month !== lastMonth && sinceLast >= 3) {
      labels.push(MONTHS[month]);
      lastMonth = month;
      sinceLast = 0;
    } else {
      labels.push(null);
      sinceLast += 1;
    }
  }
  return labels;
}
