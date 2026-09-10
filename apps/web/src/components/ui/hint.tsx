/**
 * LRA Global Ops :: `<Hint>` — DESIGN.md §20.2
 *
 * Chan: "i also want general tooltips incase the users forget how they
 * work." The deliverable isn't really "a tooltip component" — it's that
 * nobody writing a screen has to think about touch. `<Hint>` is Radix
 * `Tooltip` on a fine pointer, and the SAME component swaps itself to a
 * Radix `Popover` under `(pointer: coarse)`, because hover does not
 * exist on a touchscreen. The branch lives here, once — a consumer
 * never checks `matchMedia` itself.
 *
 * `title=` is banned by §20.2: it is invisible on touch, unstyled, slow
 * to appear, and unreadable to some screen readers. `<Hint text={x}>`
 * is the drop-in replacement for the `title={x ?? undefined}` pattern
 * that is scattered through the board and the scoreboard — passing
 * `null`/`undefined`/`''` makes `<Hint>` a pure pass-through (no
 * wrapper element at all), so a conditional title becomes a conditional
 * hint with no extra branch at the call site.
 *
 * `<Hint>` never carries information that exists nowhere else on
 * screen (§20.2) — that rule is enforced by the humans writing the
 * copy, not by this component.
 */
import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';

/**
 * Touch has no hover, so this is re-checked live rather than read once
 * at mount — a Bluetooth mouse paired to a tablet, or a 2-in-1 folded
 * into laptop mode, both change the answer without a page reload.
 */
function usePointerCoarse(): boolean {
  const [coarse, setCoarse] = React.useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(pointer: coarse)').matches
  );
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(pointer: coarse)');
    const onChange = () => setCoarse(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return coarse;
}

// Elements that already have a keyboard/screen-reader path of their
// own — a trigger built from one of these does not need `tabIndex`/
// `role="button"` added on top.
const NATIVELY_INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);
const NATIVELY_INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox']);

function isAlreadyInteractive(element: React.ReactElement): boolean {
  const props = (element.props ?? {}) as Record<string, unknown>;
  if (typeof element.type === 'string' && NATIVELY_INTERACTIVE_TAGS.has(element.type)) return true;
  if (typeof props.role === 'string' && NATIVELY_INTERACTIVE_ROLES.has(props.role)) return true;
  if (typeof props.tabIndex === 'number') return true;
  return false;
}

/**
 * Shared between the tooltip and the popover on purpose — §20.2:
 * "identical content and identical styling."
 */
const HINT_CONTENT_CLASS =
  'z-50 max-w-[240px] rounded-sm bg-navy-900 px-2.5 py-1.5 text-label text-on-dark shadow-pop ' +
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 ' +
  'data-[state=delayed-open]:animate-in data-[state=instant-open]:animate-in data-[state=open]:animate-in ' +
  'fade-in-0 zoom-in-95 duration-pop ease-out';

export interface HintProps {
  /**
   * The tooltip/popover body. `null`, `undefined` or `''` makes
   * `<Hint>` a no-op pass-through — children render with no wrapper at
   * all, which is what lets a call site write
   * `<Hint text={refusal}>…</Hint>` in place of the old
   * `title={refusal ?? undefined}` without adding a branch.
   */
  text: string | null | undefined;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
  className?: string;
}

/** DESIGN.md §20.2. See the module comment for the touch/pointer contract. */
export function Hint({ text, children, side = 'top', sideOffset = 6, className }: HintProps) {
  const coarse = usePointerCoarse();

  if (!text) return children;

  const a11yProps = isAlreadyInteractive(children) ? {} : { tabIndex: 0, role: 'button' as const };
  const trigger = React.cloneElement(children, a11yProps);

  if (coarse) {
    return (
      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side={side}
            sideOffset={sideOffset}
            collisionPadding={8}
            className={cn(HINT_CONTENT_CLASS, className)}
          >
            {text}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    );
  }

  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild>{trigger}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cn(HINT_CONTENT_CLASS, className)}
        >
          {text}
          <TooltipPrimitive.Arrow className="fill-navy-900" width={12} height={6} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * One `TooltipPrimitive.Provider` at the shell root (`app-shell.tsx`)
 * is what makes `skipDelayDuration` (§20.2: "300 within a
 * TooltipProvider group") a real cross-tooltip behaviour rather than a
 * per-`<Hint>` reset — moving the pointer from one hinted control to
 * another within 300ms skips the 350ms open delay the second time.
 * `<Hint>` itself still sets `delayDuration` on its own `Root` too, so
 * it degrades gracefully (just without the "group" feel) anywhere this
 * provider isn't an ancestor, e.g. a unit test that renders `<Hint>` in
 * isolation.
 */
export const HintProvider = TooltipPrimitive.Provider;
