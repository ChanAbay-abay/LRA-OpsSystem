/**
 * LRA Global Ops :: reliability band presentation
 *
 * DESIGN.md §2.5 — the five bands, to the pixel. Extracted once
 * `/scoreboard` and `/people/:id` both needed the identical chip
 * (Chan's standing rule: share only once a second real consumer needs
 * it). `Unrated` is deliberately not a fill — DESIGN.md: "a thin file
 * is an absence, so it gets an outline and no fill," and it renders
 * `—` rather than `0` wherever a score would otherwise sit.
 *
 * The band type is a plain string union, not imported from
 * `@lra/ops-scoring` — that package is a server-only dependency
 * (`apps/api`) and the web app reads the band as a string off the API
 * response, the same way every other domain enum in this app (task
 * status, authority) is typed locally rather than shared cross-runtime.
 */
import { reliabilityBandLabel, type ReliabilityBand } from './labels';

export type { ReliabilityBand };

/**
 * DESIGN.md §17.1's move table: the words now live in `lib/labels.ts`.
 * `BAND_LABEL` stays exported as the same `Record<ReliabilityBand,
 * string>` it always was, sourced from there, so its two call sites
 * (`person-card.tsx`, `routes/person.tsx`) need no change.
 */
export const BAND_LABEL: Record<ReliabilityBand, string> = {
  excellent: reliabilityBandLabel('excellent'),
  solid: reliabilityBandLabel('solid'),
  watch: reliabilityBandLabel('watch'),
  at_risk: reliabilityBandLabel('at_risk'),
  unrated: reliabilityBandLabel('unrated'),
};

export const BAND_CLASS: Record<ReliabilityBand, string> = {
  excellent: 'bg-cleared-wash text-cleared',
  solid: 'bg-surface-2 text-ink-2',
  watch: 'bg-pending-wash text-pending',
  at_risk: 'bg-danger-wash text-danger',
  unrated: 'border border-dashed border-hairline-strong text-ink-3',
};

export function bandChipClass(band: ReliabilityBand): string {
  return `inline-flex h-5 items-center rounded-xs px-[7px] text-label ${BAND_CLASS[band]}`;
}
