/**
 * LRA Global Ops :: the activity heatmap — DESIGN.md §19
 *
 * Chan: "like git commits, the greens on how many tasks they complete on
 * those days, the greener it is — but instead of green use a blue."
 *
 * A cell counts TASKS cleared that Manila day (§19.1), read server-side
 * from `ops.point_ledger` — the identical rows the balance figures
 * above it on `/points`/`/people/:id` come from, so the picture can
 * never disagree with the number. Points are the tooltip's second line
 * only, never the colour.
 *
 * Two variants, one component (§19.2):
 *   - `full` — `/points` (another lane's screen; not wired there yet)
 *     and `/people/:id`. 12px cells, day/month labels, legend, total
 *     line. Weeks shown is MEASURED via `ResizeObserver`
 *     (`weeksForWidth`), never a JS breakpoint constant, so it can never
 *     overflow its container.
 *   - `mini` — the scoreboard card's 13-week strip (§23.1). 8px cells,
 *     no labels, no legend, fixed at 13 weeks.
 *
 * States (§19.5), all built: a real zero (L0 + ring + tooltip), a day
 * before the person's account existed (dimmed, `aria-hidden`, no
 * tooltip — an absence, not a zero), no history at all (the full empty
 * grid plus one sentence, never hidden), loading (one `skeleton-pulse`
 * for the whole block, never 182 staggered ones), and error (the shared
 * `ErrorPanel` band — the rest of the page keeps working).
 *
 * Not a chart (§19.7): no axes, no y-axis, one series, nothing to
 * compare against. It answers exactly one question.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';
import { Hint } from '@/components/ui/hint';
import { ErrorPanel } from '@/components/ui/resource-state';
import { fmtCalendarDate, fmtCalendarDateLong } from '@/lib/dates';
import {
  dayKind,
  heatLevelFor,
  monthLabelsForColumns,
  toWeekColumns,
  weeksForWidth,
  HEAT_LEVEL_THRESHOLD_LABELS,
  type ActivityDay,
  type ActivityWindow,
  type HeatLevel,
} from './activity-heatmap-model';

const HEAT_CELL_CLASS: Record<HeatLevel, string> = {
  0: 'bg-heat-0 shadow-[inset_0_0_0_1px_var(--heat-ring)]',
  1: 'bg-heat-1',
  2: 'bg-heat-2',
  3: 'bg-heat-3',
  4: 'bg-heat-4',
};

const MINI_WEEKS = 13;
const FULL_MIN_WEEKS = 8;
const FULL_MAX_WEEKS = 26;

interface Geometry {
  cell: number;
  gap: number;
  labelCol: number;
}

const FULL_GEOMETRY: Geometry = { cell: 12, gap: 3, labelCol: 24 };
const MINI_GEOMETRY: Geometry = { cell: 8, gap: 2, labelCol: 0 };

/** `(pointer: coarse)` bumps the full variant's cell up to 13px (§19.2) — the mini variant never grows, it has no room to. */
function useCoarseCellBump(active: boolean): number {
  const [bump, setBump] = React.useState(0);
  React.useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    const mql = window.matchMedia('(pointer: coarse)');
    const apply = () => setBump(mql.matches ? 1 : 0);
    apply();
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [active]);
  return bump;
}

/**
 * §19.2's measured clamp, live. Mirrors `use-rail.ts`'s `ResizeObserver`
 * pattern: measure on mount and on every resize, never on a fixed
 * breakpoint list.
 */
function useMeasuredWeeks(active: boolean, geometry: Geometry): { ref: React.RefObject<HTMLDivElement | null>; weeks: number } {
  const ref = React.useRef<HTMLDivElement>(null);
  const [weeks, setWeeks] = React.useState(FULL_MAX_WEEKS);

  React.useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (el == null) return;
    const measure = () => {
      setWeeks(
        weeksForWidth(el.clientWidth, {
          labelCol: geometry.labelCol,
          cell: geometry.cell,
          gap: geometry.gap,
          min: FULL_MIN_WEEKS,
          max: FULL_MAX_WEEKS,
        })
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, geometry.labelCol, geometry.cell, geometry.gap]);

  return { ref, weeks };
}

const DAY_LABELS: Record<number, string> = { 0: 'Mon', 2: 'Wed', 4: 'Fri' };

function Cell({
  day,
  sinceDate,
  cellSize,
  isRoving,
  interactive,
  flatIndex,
}: {
  day: ActivityDay;
  sinceDate: string | null;
  cellSize: number;
  isRoving: boolean;
  /**
   * `false` on the mini variant: the whole scoreboard card is already
   * one `<Link>` (§23), and a per-cell `tabIndex`/`role="gridcell"`
   * nested inside it would be an interactive element inside an
   * interactive element — invalid HTML and an extra, confusing tab stop
   * on every card. The mini strip is a glance, not its own widget: it
   * still paints the right colours, it just never becomes a focus
   * target or a `<Hint>` trigger.
   */
  interactive: boolean;
  /**
   * This cell's position in the flat, oldest-first day list — stamped
   * on every cell (including a non-focusable "before-account" one) so
   * the grid's arrow-key handler can look a specific day up by DOM
   * query rather than trust a ref forwarded through `<Hint>`'s Radix
   * `Tooltip.Trigger asChild`.
   */
  flatIndex: number;
}) {
  const kind = dayKind(day, sinceDate);
  const level = heatLevelFor(day.count);

  if (kind === 'before-account') {
    return (
      <div
        aria-hidden
        data-cell-index={flatIndex}
        className="rounded-cell bg-heat-0 opacity-40"
        style={{ width: cellSize, height: cellSize }}
      />
    );
  }

  const swatch = (
    <div
      role={interactive ? 'gridcell' : undefined}
      aria-hidden={interactive ? undefined : true}
      tabIndex={interactive && isRoving ? 0 : interactive ? -1 : undefined}
      data-cell-index={flatIndex}
      aria-label={
        interactive
          ? kind === 'zero'
            ? `${fmtCalendarDateLong(day.date)}: no tasks cleared`
            : `${fmtCalendarDateLong(day.date)}: ${day.count} task${day.count === 1 ? '' : 's'} cleared, ${day.points} point${day.points === 1 ? '' : 's'}`
          : undefined
      }
      className={cn(
        'activity-heatmap-cell rounded-cell outline-1 outline-offset-1 outline-transparent',
        interactive && 'hover:outline-ink-3 focus-visible:outline-ink-3',
        HEAT_CELL_CLASS[level]
      )}
      style={{ width: cellSize, height: cellSize }}
      data-heat-level={level}
    />
  );

  if (!interactive) return swatch;

  const label =
    kind === 'zero'
      ? `No tasks cleared · ${fmtCalendarDate(day.date)}`
      : `${day.count} task${day.count === 1 ? '' : 's'} cleared · ${day.points} point${day.points === 1 ? '' : 's'}\n${fmtCalendarDate(day.date)}`;

  return <Hint text={label}>{swatch}</Hint>;
}

function Legend() {
  return (
    <div className="flex items-center gap-1.5 text-micro text-ink-3">
      <span>Less</span>
      {([0, 1, 2, 3, 4] as const).map((level) => (
        <span key={level} className={cn('size-[10px] rounded-cell', HEAT_CELL_CLASS[level])} aria-hidden />
      ))}
      <span>More</span>
      <span className="ml-2 flex items-center gap-1.5 num text-num-xs">
        {HEAT_LEVEL_THRESHOLD_LABELS.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </span>
    </div>
  );
}

export interface ActivityHeatmapProps {
  data: ActivityWindow | null;
  variant: 'full' | 'mini';
  error?: string | null;
  onRetry?: () => void;
  className?: string;
}

/**
 * The grid itself, shared by both variants — everything variant-
 * specific (labels, legend, total line, the wrapping panel) is decided
 * by the caller below.
 */
function Grid({
  data,
  variant,
}: {
  data: ActivityWindow;
  variant: 'full' | 'mini';
}) {
  const isFull = variant === 'full';
  const geometry = isFull ? FULL_GEOMETRY : MINI_GEOMETRY;
  const cellBump = useCoarseCellBump(isFull);
  const cellSize = geometry.cell + cellBump;
  const { ref, weeks } = useMeasuredWeeks(isFull, geometry);
  const activeWeeks = isFull ? weeks : MINI_WEEKS;

  const columns = React.useMemo(() => toWeekColumns(data.days, activeWeeks), [data.days, activeWeeks]);
  const monthLabels = React.useMemo(() => (isFull ? monthLabelsForColumns(columns) : []), [isFull, columns]);

  // Roving tabindex (§19.6): the grid is one tab stop, arrow keys move
  // focus within it, so 182 cells are never 182 tab stops. The actual
  // focusable node for a cell sits one layer inside `<Hint>` (a Radix
  // `Tooltip.Trigger asChild`), so rather than trust ref-forwarding
  // through a third-party primitive, arrow-key focus is moved by
  // querying the rendered `[role="gridcell"]` nodes directly off the
  // grid container — simpler, and correct regardless of how Hint
  // composes its own ref internally.
  //
  // Starts on the MOST RECENT day (the last cell), not the oldest one:
  // the oldest day in a 26-week window is "before this person's account
  // existed" for almost every real account (§19.5), which has no
  // `role="gridcell"` at all — starting the roving index there would
  // leave the whole widget with no tabbable cell for a Tab key to land
  // on. Today is always on-or-after the account's own join date, so it
  // is always a real, focusable cell.
  const [rovingIndexState, setRovingIndex] = React.useState(() => activeWeeks * 7 - 1);
  const flat = React.useMemo(() => columns.flat(), [columns]);
  // A resize can shrink the visible window (`activeWeeks` falls) between
  // the state's last write and this render — clamped here, at render
  // time, so the roving index never points past the end of a shorter
  // list without a second `setState` (and the extra render) an effect
  // would cost.
  const rovingIndex = Math.min(rovingIndexState, flat.length - 1);
  const gridRef = React.useRef<HTMLDivElement>(null);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let next = rovingIndex;
    if (e.key === 'ArrowRight') next = Math.min(flat.length - 1, rovingIndex + 7);
    else if (e.key === 'ArrowLeft') next = Math.max(0, rovingIndex - 7);
    else if (e.key === 'ArrowDown') next = Math.min(flat.length - 1, rovingIndex + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, rovingIndex - 1);
    else return;
    e.preventDefault();
    // A "before-account" day at `next` has no `role="gridcell"` and no
    // tabIndex (§19.5 — it's `aria-hidden`, never a focus target), so a
    // plain lookup-and-focus would silently do nothing on it. Rather
    // than land keyboard focus nowhere, step past it in the same
    // direction until a real cell is found or the window's edge is hit.
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? Math.sign(next - rovingIndex) * 7 : Math.sign(next - rovingIndex);
    while (next >= 0 && next < flat.length) {
      const el = gridRef.current?.querySelector<HTMLElement>(`[data-cell-index="${next}"][role="gridcell"]`);
      if (el) {
        setRovingIndex(next);
        el.focus();
        return;
      }
      if (step === 0) return;
      next += step;
    }
  };

  return (
    <div ref={isFull ? ref : undefined} className="w-full">
      <div
        ref={gridRef}
        role={isFull ? 'grid' : undefined}
        aria-label={isFull ? 'Tasks cleared per day' : undefined}
        // Mini is a glance inside an already-interactive scoreboard card
        // (§23) — no grid semantics, no keyboard handling, nothing to
        // steal a tab stop from the card's own `<Link>`.
        aria-hidden={isFull ? undefined : true}
        className="flex gap-[var(--heatmap-gap)]"
        style={{ '--heatmap-gap': `${geometry.gap}px` } as React.CSSProperties}
        onKeyDown={isFull ? onKeyDown : undefined}
      >
        {isFull ? (
          <div
            aria-hidden
            className="flex shrink-0 flex-col justify-between text-micro text-ink-3"
            style={{ width: geometry.labelCol, height: cellSize * 7 + geometry.gap * 6, paddingTop: cellSize + geometry.gap }}
          >
            {[0, 1, 2, 3, 4, 5, 6].map((row) => (
              <span key={row} className="leading-none" style={{ height: cellSize }}>
                {DAY_LABELS[row] ?? ''}
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          {isFull ? (
            <div className="flex gap-[var(--heatmap-gap)]" aria-hidden>
              {columns.map((col, i) => (
                <span key={col[0]?.date ?? i} className="text-micro text-ink-3" style={{ width: cellSize }}>
                  {monthLabels[i] ?? ''}
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex gap-[var(--heatmap-gap)]">
            {columns.map((col, colIndex) => (
              <div key={col[0]?.date ?? colIndex} role={isFull ? 'row' : undefined} className="flex flex-col gap-[var(--heatmap-gap)]">
                {col.map((d, rowIndex) => {
                  const flatIndex = colIndex * 7 + rowIndex;
                  const isRoving = flatIndex === rovingIndex;
                  return (
                    <Cell
                      key={d.date}
                      day={d}
                      sinceDate={data.sinceDate}
                      cellSize={cellSize}
                      isRoving={isRoving}
                      interactive={isFull}
                      flatIndex={flatIndex}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function HeatmapSkeleton({ variant }: { variant: 'full' | 'mini' }) {
  const isFull = variant === 'full';
  const geometry = isFull ? FULL_GEOMETRY : MINI_GEOMETRY;
  const weeks = isFull ? FULL_MAX_WEEKS : MINI_WEEKS;
  const height = geometry.cell * 7 + geometry.gap * 6;
  return (
    <div aria-hidden className="w-full">
      {isFull ? <div className="skeleton-pulse mb-2 h-3 w-40 rounded-xs bg-surface-2" /> : null}
      <div
        className="skeleton-pulse rounded-md bg-surface-2"
        style={{ height, width: isFull ? undefined : weeks * (geometry.cell + geometry.gap) }}
      />
      {isFull ? <div className="skeleton-pulse mt-2 h-3 w-56 rounded-xs bg-surface-2" /> : null}
    </div>
  );
}

/** DESIGN.md §8/§19.5 — matches the real geometry of whichever variant is loading. */
export function ActivityHeatmapSkeleton({ variant }: { variant: 'full' | 'mini' }) {
  return <HeatmapSkeleton variant={variant} />;
}

export function ActivityHeatmap({ data, variant, error, onRetry, className }: ActivityHeatmapProps) {
  if (error) {
    return <ErrorPanel message={error} onRetry={onRetry ?? (() => {})} />;
  }
  if (data == null) {
    return <HeatmapSkeleton variant={variant} />;
  }

  const hasHistory = data.totalCleared > 0;

  return (
    <div className={cn('w-full', className)}>
      <Grid data={data} variant={variant} />
      {variant === 'full' ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-body-sm text-ink-2">
            <span className="num text-num-sm">{data.totalCleared}</span> tasks cleared in the last{' '}
            <span className="num text-num-sm">{toWeekColumns(data.days, data.windowWeeks).length}</span> weeks
          </p>
          <Legend />
        </div>
      ) : null}
      {!hasHistory ? (
        <p className={cn('text-body-sm text-ink-3', variant === 'full' ? 'mt-2' : 'mt-1.5')}>
          No cleared work yet. Squares fill in as you clear tasks.
        </p>
      ) : null}
    </div>
  );
}
