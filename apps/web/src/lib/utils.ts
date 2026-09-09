/**
 * LRA Global Ops :: class-merge helper
 *
 * `clsx` for conditional classes, `tailwind-merge` to resolve conflicting
 * Tailwind utilities (e.g. two different `px-*` values) in favour of the
 * last one, rather than emitting both.
 *
 * The merge is EXTENDED, and it has to be. `tailwind-merge` decides which
 * classes conflict by parsing them against Tailwind's *default* scales,
 * and DESIGN.md's type scale replaces those wholesale — `text-micro`,
 * `text-body-sm`, `text-num-xs` and the rest are names stock
 * tailwind-merge has never heard of. Its `font-size` group only matches
 * t-shirt sizes (`text-sm`, `text-lg`, …), so an unrecognised `text-*`
 * falls through to the catch-all `text-color` group instead. That puts
 * `text-micro` in the same conflict group as `text-ink-2` — and two
 * classes in one group means the later one wins and the earlier one is
 * DELETED from the output.
 *
 * The failure is silent and it is not theoretical: it is what made the
 * task-detail chips render at the inherited 14px instead of their 11px
 * `text-micro` (Chan, 2026-09-09, "fix the badge sizing of the modal").
 * Every `cn('… text-<size> …', someToneThatCarriesATextColour)` in the
 * app had the same hole, so this is fixed here rather than one component
 * at a time.
 *
 * Only `font-size` is extended. Colours need no list: once the size names
 * are claimed by the font-size group, every other `text-*` still lands in
 * `text-color` exactly as before, so new colour tokens keep working with
 * no change here. New *type* tokens do not — add a `fontSize` key to
 * tailwind.config.ts and it must be added below in the same change, or
 * its size will start vanishing wherever a colour sits beside it.
 */
import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** Mirrors tailwind.config.ts → theme.extend.fontSize, key for key. */
const FONT_SIZES = [
  'display',
  'title-lg',
  'title',
  'subtitle',
  'strong',
  'body',
  'body-sm',
  'label',
  'eyebrow',
  'micro',
  'num-hero',
  'num-lg',
  'num-md',
  'num-sm',
  'num-xs',
];

const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: FONT_SIZES }] } },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
