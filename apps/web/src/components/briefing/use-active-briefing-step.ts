/**
 * LRA Global Ops :: which briefing step is "current" — DESIGN.md §21.1
 *
 * Split out of `step-rail.tsx` so that file only exports components
 * (the `react(only-export-components)` fast-refresh rule oxlint enforces
 * across this app — same reasoning as `components/scoreboard/use-rail.ts`).
 *
 * Driven by an `IntersectionObserver` on the four `<section id=…>`
 * elements `routes/briefing.tsx` renders. Not simply the first
 * intersecting section — that would jump straight past a short section
 * (Carry-overs, often empty) the instant its top crosses the trigger
 * line. Instead: among the sections currently intersecting the trigger
 * band, the one closest to the top of the viewport.
 */
import * as React from 'react';

export function useActiveBriefingStep(stepIds: readonly string[]): number {
  const [activeIndex, setActiveIndex] = React.useState(0);
  const idsKey = stepIds.join('|');

  React.useEffect(() => {
    const elements = stepIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        const topmost = visible.reduce((a, b) => (a.boundingClientRect.top <= b.boundingClientRect.top ? a : b));
        const index = elements.findIndex((el) => el === topmost.target);
        if (index !== -1) setActiveIndex(index);
      },
      // A band near the top of the viewport, not the whole viewport —
      // "current" should mean "the section you're actually reading",
      // not "any section at all still partly on screen".
      { rootMargin: '-15% 0px -70% 0px', threshold: [0, 1] }
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `idsKey` is the intentional, stable dependency for an array prop.
  }, [idsKey]);

  return activeIndex;
}
