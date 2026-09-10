/**
 * LRA Global Ops :: one person's card on the scoreboard rail
 *
 * Chan, 2026-09-10: "make the scoreboard UI better and closer so the
 * data on the left is not too far from the right… can we have a display
 * as well of points that are yet to be done, points pending and waiting
 * approval, and completed. then another one to have the points with
 * total points that they could have… make each user a card that displays
 * from left to right making it a horizontal scroll."
 *
 * The density complaint was real and specific: the old table put a name
 * at the far left of a 1440px row and its number at the far right, with
 * a `gap-4` lake in between. The fix is not a smaller gap — it is that
 * **every label sits directly above its own value**, inside a 300–420px
 * card, so no eye has to travel to pair them.
 *
 * Hierarchy, per DESIGN.md §11 ("never more than one 24px+ number per
 * panel"): the card has exactly one `num-lg` — completed points — and it
 * is immediately followed by "of N possible", which is Chan's second
 * display. The other three buckets are `num-md` cells underneath. Money
 * colour is DESIGN.md §6.1 throughout and is not re-decided here:
 * completed is solid ink, pending is amber with the dashed underline,
 * to-do is `--ink-3`, and `atRisk` is `--blocked` because a task
 * awaiting a cancellation decision is a stall, not an error (§2.3).
 *
 * The recurring-cap disclosure lives on this card, on the completed
 * figure, and only on the "This week" period — see
 * `scoreboard-model.ts#capDisclosure` for why it cannot honestly be
 * shown against a 4- or 13-week total. PLAN.md §2.6 requires the cap
 * never to land as a *silent* haircut; Chan removed the permanent
 * two-number readout, not the disclosure.
 */
import { Link } from 'react-router-dom';
import { Percent } from 'lucide-react';
import { cn } from '@/lib/utils';
import { bandChipClass, BAND_LABEL } from '@/lib/reliability-ui';
import { Hint } from '@/components/ui/hint';
import { positionLabel } from '@/lib/labels';
import { PointsBar } from './points-bar';
import {
  capDisclosure,
  capSentence,
  sharePercent,
  type PeriodKey,
  type PointBuckets,
  type ScoreboardRow,
} from './scoreboard-model';

/**
 * Local copy of the 20/24px avatar initials. `lib/task-types.ts` has the
 * same two lines, but that file belongs to the tasks surface and is
 * being edited in parallel; a scoreboard card is not a good enough
 * reason to couple two screens together (see the report's
 * "noticed, not done").
 */
function initials(name: string | null) {
  return (name ?? '?').slice(0, 2).toUpperCase();
}

/** One label/value pair. The pairing IS the fix for Chan's complaint. */
function BucketCell({
  label,
  points,
  taskCount,
  tone,
}: {
  label: string;
  points: number;
  taskCount: number;
  tone: 'toDo' | 'pending' | 'atRisk';
}) {
  return (
    <div className="min-w-0">
      <div className="text-eyebrow text-ink-3">{label}</div>
      {/*
        A ZERO CARRIES NO TONE. `.num-pending`'s amber and dashed
        underline mean "these points exist and have not cleared yet"
        (DESIGN.md §6.1) — painted on a `0` it announces a debt that
        isn't there, and on a card with three zeroed buckets it was the
        loudest thing on the card. Same for `atRisk`'s blocked hue.
        Absence is neutral; only a real number gets the treatment.
      */}
      <div
        className={cn(
          'num mt-1 text-num-md',
          points === 0
            ? 'text-ink-3'
            : cn(
                tone === 'toDo' && 'text-ink-3',
                // index.css `.num-pending` is the one place the amber +
                // dashed-underline "not yet cleared" treatment is defined
                // (DESIGN.md §6.1). Reused, not restated.
                tone === 'pending' && 'num-pending',
                tone === 'atRisk' && 'text-blocked'
              )
        )}
      >
        {points}
      </div>
      <div className="mt-1 text-micro text-ink-3">
        {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
      </div>
    </div>
  );
}

export function PersonCard({
  row,
  period,
  canSeeReliability,
}: {
  row: ScoreboardRow;
  period: PeriodKey;
  /**
   * PLAN.md §10 #4: founder + admin only, restated client-side purely to
   * pick a layout — `apps/api/src/routes/scoreboard.ts` has already
   * dropped `reliability` and `lastClosedWeek` from the JSON for
   * everyone else, so this branch is never the thing standing between a
   * GM or staff caller and the numbers. Points, the four buckets and
   * velocity are not gated for anyone (PLAN.md §10.2).
   */
  canSeeReliability: boolean;
}) {
  const buckets: PointBuckets = row.periods[period];
  const share = sharePercent(buckets);
  // Scoped to the current week on purpose — see the module comment.
  const cap = period === 'week' ? capDisclosure(row.currentWeek) : null;

  return (
    <Link
      to={`/people/${row.userId}`}
      className={cn(
        'flex min-w-[300px] max-w-[420px] flex-[1_1_300px] snap-start flex-col gap-3 rounded-xl',
        'border border-hairline bg-surface p-4 transition-[background-color,border-color] duration-press ease',
        'hover:border-hairline-strong hover:bg-[#FCFDFF]'
      )}
    >
      {/* Person */}
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-navy-800 text-micro text-on-dark"
        >
          {initials(row.name)}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-strong text-ink">{row.name ?? 'Unnamed'}</span>
          <span className="block truncate text-micro text-ink-3">{positionLabel(row.position)}</span>
        </span>
      </div>

      <div className="border-t border-hairline" />

      {/* Completed against possible — Chan's "points with total points
          that they could have", and the card's single 24px figure. */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-eyebrow text-ink-3">Completed</span>
          {cap ? (
            <Hint text={capSentence(cap)}>
              <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-xs border border-pending-border bg-pending-wash px-[7px] text-label text-pending">
                <Percent className="size-3 shrink-0" aria-hidden />
                Capped <span className="num text-num-xs">{cap.capped}</span>
                <span className="sr-only">. {capSentence(cap)}</span>
              </span>
            </Hint>
          ) : null}
        </div>
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="num text-num-lg text-ink">{buckets.completed}</span>
          {share == null ? (
            // `possible` is 0 here, so the thing that does not exist is
            // the SHARE, not the denominator — and an em dash in the
            // denominator's place ("0 of — possible") claims the total is
            // unknown when we know it exactly. What is actually true is
            // that this person had nothing on their plate in this window,
            // so say that. DESIGN.md §8's em dash still governs the share
            // itself, which is simply not rendered.
            <span className="text-body-sm text-ink-3">— nothing on the plate</span>
          ) : (
            <span className="text-body-sm text-ink-3">
              of <span className="num text-num-sm text-ink-2">{buckets.possible}</span> possible
            </span>
          )}
        </div>
        <div className="mt-2">
          <PointsBar buckets={buckets} />
        </div>
      </div>

      {/* The three remaining buckets. `atRisk` keeps its own cell rather
          than being folded into pending or dropped: it is a task nobody
          has decided about yet, and it is inside `possible`. */}
      <div className="grid grid-cols-3 gap-2 border-t border-hairline pt-3">
        <BucketCell label="To do" points={buckets.toDo} taskCount={buckets.taskCounts.toDo} tone="toDo" />
        <BucketCell
          label="Pending"
          points={buckets.pending}
          taskCount={buckets.taskCounts.pending}
          tone="pending"
        />
        <BucketCell
          label="At risk"
          points={buckets.atRisk}
          taskCount={buckets.taskCounts.atRisk}
          tone="atRisk"
        />
      </div>

      {canSeeReliability ? (
        <div className="flex items-center justify-between gap-3 border-t border-hairline pt-3">
          <span className="flex flex-col gap-1">
            <span className="text-eyebrow text-ink-3">Hit-rate</span>
            <span className="num text-num-sm text-ink-2">
              {row.lastClosedWeek?.hitRate != null ? `${Math.round(row.lastClosedWeek.hitRate * 100)}%` : '—'}
            </span>
          </span>
          <span className="flex flex-col items-end gap-1">
            <span className="text-eyebrow text-ink-3">Reliability</span>
            {row.reliability?.score != null ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="num text-num-sm text-ink">{row.reliability.score}</span>
                <span className={bandChipClass(row.reliability.band)}>{BAND_LABEL[row.reliability.band]}</span>
              </span>
            ) : (
              <span className={bandChipClass('unrated')}>Unrated</span>
            )}
          </span>
        </div>
      ) : null}
    </Link>
  );
}

/**
 * The rail's loading placeholder, in the rail's own geometry (DESIGN.md
 * §8 — skeletons match the real layout, and the old table skeleton would
 * have been the wrong shape entirely). Three cards, because three is the
 * real team size.
 */
export function PersonCardSkeleton({ index = 0 }: { index?: number }) {
  const delay = index * 90;
  return (
    <div
      aria-hidden
      className="flex min-w-[300px] max-w-[420px] flex-[1_1_300px] flex-col gap-3 rounded-xl border border-hairline bg-surface p-4"
    >
      <div className="flex items-center gap-2">
        <div className="skeleton-pulse size-6 shrink-0 rounded-full bg-surface-3" style={{ animationDelay: `${delay}ms` }} />
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="skeleton-pulse h-3 w-2/5 rounded-xs bg-surface-2" style={{ animationDelay: `${delay}ms` }} />
          <div className="skeleton-pulse h-2 w-1/4 rounded-xs bg-surface-2" style={{ animationDelay: `${delay + 60}ms` }} />
        </div>
      </div>
      <div className="border-t border-hairline" />
      <div className="flex flex-col gap-2">
        <div className="skeleton-pulse h-2 w-16 rounded-xs bg-surface-3" style={{ animationDelay: `${delay}ms` }} />
        <div className="skeleton-pulse h-6 w-24 rounded-xs bg-surface-2" style={{ animationDelay: `${delay + 60}ms` }} />
        <div className="skeleton-pulse h-1 w-full rounded-full bg-surface-3" style={{ animationDelay: `${delay + 120}ms` }} />
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-hairline pt-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <div className="skeleton-pulse h-2 w-10 rounded-xs bg-surface-3" style={{ animationDelay: `${delay + i * 60}ms` }} />
            <div className="skeleton-pulse h-4 w-8 rounded-xs bg-surface-2" style={{ animationDelay: `${delay + i * 60 + 60}ms` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
