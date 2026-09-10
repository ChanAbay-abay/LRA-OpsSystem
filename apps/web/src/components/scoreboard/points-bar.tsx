/**
 * LRA Global Ops :: the settlement bar, per person
 *
 * DESIGN.md §6.2's 4px settlement bar, applied to a person's window
 * instead of one week's balance panel: `--cleared` for the settled
 * proportion, `--pending` for what is waiting to clear, `--blocked` for
 * the undecided `atRisk` slice, `--surface-3` for committed-but-not-
 * started. "No labels, no legend, no percentages — it is a texture, not
 * a chart", so the numbers live in the cells above it and this is only
 * the shape of them.
 *
 * `atRisk` gets `--blocked` rather than a sixth hue for exactly
 * DESIGN.md §2.3's reason: a task awaiting a cancellation decision is a
 * stall, not an error — nobody did anything wrong — and a third warm
 * hue next to amber would go muddy.
 *
 * Zero-point buckets are not painted (a 0%-wide segment would still show
 * as a 1px sliver of the wrong colour), but they are never dropped from
 * the accessible description: the whole bar is one `img` with an
 * `aria-label` that reads every bucket out including the empty ones.
 *
 * No width transition. DESIGN.md §7 never animates `width`, and §7.2
 * bans motion on filtering — switching period must swap the shape, not
 * animate to it.
 */
import { pointsSegmentLabel } from '@/lib/labels';
import { bucketSegments, type PointBuckets, type SegmentKey } from './scoreboard-model';

const SEGMENT_FILL: Record<SegmentKey, string> = {
  completed: 'var(--cleared)',
  pending: 'var(--pending)',
  atRisk: 'var(--blocked)',
  toDo: 'var(--surface-3)',
};

// DESIGN.md §17.1's move table: the words now live in `lib/labels.ts`.
const SEGMENT_WORD: Record<SegmentKey, string> = {
  completed: pointsSegmentLabel('completed'),
  pending: pointsSegmentLabel('pending'),
  atRisk: pointsSegmentLabel('atRisk'),
  toDo: pointsSegmentLabel('toDo'),
};

export function PointsBar({ buckets }: { buckets: PointBuckets }) {
  const segments = bucketSegments(buckets);

  // Nothing on the plate at all: an empty dashed track, because an empty
  // *solid* track reads as "0% done" and this person has no denominator
  // to be 0% of (DESIGN.md §8, zero vs nothing).
  if (buckets.possible <= 0) {
    return (
      <div
        role="img"
        aria-label="No points in this window."
        className="h-1 rounded-full border border-dashed border-hairline-strong"
      />
    );
  }

  const label = `${buckets.completed} of ${buckets.possible} points completed. ${segments
    .map((s) => `${s.points} ${SEGMENT_WORD[s.key]}`)
    .join(', ')}.`;

  return (
    <div role="img" aria-label={label} className="flex h-1 overflow-hidden rounded-full bg-surface-3">
      {segments
        .filter((s) => s.points > 0)
        .map((s) => (
          <div key={s.key} style={{ width: `${s.percent}%`, background: SEGMENT_FILL[s.key] }} />
        ))}
    </div>
  );
}
