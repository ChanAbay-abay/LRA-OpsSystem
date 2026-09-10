/**
 * LRA Global Ops :: the scoreboard rail
 *
 * Chan: "make each user a card that displays from left to right making
 * it a horizontal scroll."
 *
 * The requirements that make this a component rather than a `div` with
 * `overflow-x-auto`:
 *
 * - **The page body must never scroll horizontally.** The scroll lives
 *   on this element alone; the app shell above it is unchanged.
 * - **Keyboard-scrollable**, like the board's own scroller (DESIGN.md
 *   §12): the rail is `tabIndex={0}` with an accessible name, so arrow
 *   keys scroll it natively, and every card inside it is a link, so
 *   tabbing through them scrolls them into view.
 * - **A discoverable affordance.** A fourth card off the right edge must
 *   be findable without a horizontal-scroll instinct. DESIGN.md §14 bans
 *   gradients, so there is no fade mask: instead there are two real
 *   buttons that page the rail by one card, and they only exist when the
 *   rail actually overflows. Each is disabled at its end of the track,
 *   which is also how a mouse user learns there is nothing more.
 * - **It must not look broken at three people.** Cards are
 *   `flex: 1 1 300px` with `min-width: 300px` and `max-width: 420px`, so
 *   at the real team size of three they grow to fill the row and read as
 *   a deliberate three-up layout; past four or five they settle at 300px
 *   and the rail starts scrolling. One card (the `oversight_only` case)
 *   is a single 420px panel, which is a normal-looking panel.
 *
 * The scroll state itself (does it overflow, where is it in the track)
 * lives in `use-rail.ts`, including the reduced-motion handling for the
 * script-driven scroll.
 */
import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RailScrollState } from './use-rail';

export function RailControls({
  state,
  page,
  className,
}: {
  state: RailScrollState;
  page: (direction: -1 | 1) => void;
  className?: string;
}) {
  // No overflow means nothing to page through, and a pair of permanently
  // disabled buttons would be chrome that never does anything.
  if (!state.overflowing) return null;
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <RailButton label="Scroll left" onClick={() => page(-1)} disabled={state.atStart}>
        <ChevronLeft className="size-4" aria-hidden />
      </RailButton>
      <RailButton label="Scroll right" onClick={() => page(1)} disabled={state.atEnd}>
        <ChevronRight className="size-4" aria-hidden />
      </RailButton>
    </div>
  );
}

/**
 * Square 40px — the tallest control DESIGN.md §5.1 defines. That is
 * still under §12's 44×44 touch target; these buttons are deliberately
 * not the only way to move the rail (swipe, trackpad, native scrollbar
 * and arrow keys all work), so the shortfall is real, measured, and does
 * not gate the interaction.
 */
function RailButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex size-10 items-center justify-center rounded-md border border-hairline-strong bg-surface text-ink-2',
        'transition-[background-color,border-color,color] duration-press ease',
        'hover:bg-surface-2 hover:text-ink active:scale-[.98]',
        'disabled:cursor-not-allowed disabled:border-hairline disabled:bg-canvas disabled:text-ink-disabled disabled:active:scale-100'
      )}
    >
      {children}
    </button>
  );
}

export function CardRail({
  railRef,
  label,
  children,
}: {
  railRef: React.RefObject<HTMLDivElement | null>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={railRef}
      // `region` + a name so the rail is announced and reachable, and
      // `tabIndex` so arrow keys scroll it -- the same contract the
      // board's horizontal scroller has (DESIGN.md §12).
      role="region"
      aria-label={label}
      tabIndex={0}
      className="flex snap-x gap-4 overflow-x-auto pb-3"
    >
      {children}
    </div>
  );
}
