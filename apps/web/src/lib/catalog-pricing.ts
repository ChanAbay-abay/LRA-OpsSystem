/**
 * LRA Global Ops :: catalog pricing markers
 *
 * A catalog type's `guideline_note` can carry leading markers saying the
 * row is not yet the founder's real answer:
 *
 *   `DRAFT —`        the note was drafted by an agent and needs review
 *                    (PLAN.md §8's risk: "a seeded catalog invented by an
 *                    agent becomes company policy by default")
 *   `PLACEHOLDER —`  the POINT VALUE is a starting number, not a decision
 *
 * Both can be true at once, and on live data both usually are: 14 of the
 * 15 active types read `PLACEHOLDER — DRAFT — …`.
 *
 * WHY THIS MODULE EXISTS. The single-prefix regex `^(PLACEHOLDER|DRAFT)\s*—\s*`
 * was copy-pasted into four places across two screens, and it strips only
 * ONE marker. On the doubled notes that meant:
 *
 *   - the scoreboard's new points reference showed `DRAFT — actively
 *     chasing…` in a tooltip, leaking an internal marker at a reader; and
 *   - far worse, `catalog.tsx` used the same regex to PRE-FILL its edit
 *     dialog, so opening a note to edit it loaded `DRAFT — …` into the
 *     textarea and saving baked that marker into the note as real prose —
 *     a quiet data-corruption path, and one that compounds every edit.
 *
 * So the markers are stripped repeatedly, and the rule lives in one place
 * that both screens import. The visual signal (amber `--pending`) is what
 * carries the meaning to a reader; the marker text never should.
 */

/** Matches any run of leading `PLACEHOLDER —` / `DRAFT —` markers. */
const PRICING_MARKERS = /^(?:(?:PLACEHOLDER|DRAFT)\s*—\s*)+/i;

export interface PricedType {
  default_points: number | null;
  guideline_note: string;
}

/**
 * True when this type's POINT VALUE should not be presented as settled —
 * either it has no price at all, or its note still carries a marker.
 */
export function isPlaceholderPricing(t: PricedType): boolean {
  return t.default_points == null || PRICING_MARKERS.test(t.guideline_note ?? '');
}

/**
 * The note as a person should read it, with every leading marker removed.
 * Safe to run on an already-clean note.
 */
export function stripPricingPrefix(note: string): string {
  return (note ?? '').replace(PRICING_MARKERS, '');
}
