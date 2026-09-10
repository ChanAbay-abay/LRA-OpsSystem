/**
 * LRA Global Ops :: `useMediaQuery` — a live `matchMedia` read
 *
 * The same live-listener shape as `components/ui/hint.tsx`'s
 * `usePointerCoarse` (not imported from there — that hook is one
 * component's internal helper, not exported, and duplicating six lines
 * of `matchMedia` plumbing here is cheaper than exporting a private hook
 * out of an unrelated file for one new caller). First real use:
 * DESIGN.md §16.4's briefing commit grid, which renders a genuinely
 * different DOM shape below `md` (a collapsible per person) than at or
 * above it (the grid open, unconditionally) — a CSS-only `hidden md:block`
 * would still mount the collapsed version's Radix state and triggers,
 * which is the "a collapsible with a dead trigger is worse than no
 * collapsible" trap DESIGN.md calls out by name.
 */
import * as React from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches
  );
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
