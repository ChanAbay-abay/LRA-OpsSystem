/**
 * LRA Global Ops :: the scoreboard rail's scroll state
 *
 * Split out of `card-rail.tsx` so that file only exports components
 * (the `react(only-export-components)` fast-refresh rule oxlint enforces
 * across this app).
 *
 * All this hook knows is whether the rail overflows and where in the
 * track it currently sits. That is what decides whether a scroll
 * affordance exists at all: Chan's rail must make a fourth card off the
 * right edge discoverable, but at the real team size of three there is
 * nothing to scroll and a pair of permanently disabled arrows would be
 * chrome that never does anything.
 */
import * as React from 'react';

export interface RailScrollState {
  overflowing: boolean;
  atStart: boolean;
  atEnd: boolean;
}

/** Sub-pixel scroll widths never land exactly on their maximum. */
const AT_END_SLACK = 2;

/** One card plus the rail's 16px gap. */
const RAIL_GAP = 16;

/**
 * `revision` exists because the rail does not exist yet on first mount:
 * the screen is showing its skeleton, `ref.current` is `null`, and an
 * effect that only ran once would attach the ResizeObserver to nothing
 * and then never learn that the real rail had arrived. Callers pass
 * something that changes when the rail's contents do (the resource
 * status and the row count).
 */
export function useRail(revision?: unknown) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState<RailScrollState>({
    overflowing: false,
    atStart: true,
    atEnd: true,
  });

  const measure = React.useCallback(() => {
    const el = ref.current;
    if (el == null) return;
    const max = el.scrollWidth - el.clientWidth;
    setState({
      overflowing: max > AT_END_SLACK,
      atStart: el.scrollLeft <= AT_END_SLACK,
      atEnd: el.scrollLeft >= max - AT_END_SLACK,
    });
  }, []);

  React.useEffect(() => {
    const el = ref.current;
    if (el == null) return;
    measure();
    // A card can arrive, the window can resize, and the sidebar can
    // collapse -- all three change whether this rail overflows, and none
    // of them fire `scroll`.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [measure, revision]);

  const page = React.useCallback((direction: -1 | 1) => {
    const el = ref.current;
    if (el == null) return;
    const first = el.firstElementChild as HTMLElement | null;
    const step = first != null ? first.getBoundingClientRect().width + RAIL_GAP : el.clientWidth * 0.8;
    // DESIGN.md §7.5 is explicit that the CSS reduced-motion block
    // cannot stop a script-driven scroll — the preference has to be read
    // in JS for this path.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: direction * step, behavior: reduced ? 'auto' : 'smooth' });
  }, []);

  return { ref, state, page };
}
