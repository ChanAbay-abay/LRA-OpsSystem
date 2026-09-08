/**
 * LRA Global Ops :: Input
 *
 * DESIGN.md §5.2. Height 34, radius 8, border `#CBD2E0`.
 *
 * WCAG NOTE (binding, do not "fix" by darkening the border): DESIGN.md
 * deliberately chooses the lighter `--hairline-strong` (#CBD2E0) for
 * input borders over a darker, fully-compliant tone, because the
 * heavier border read as "boxy" against this app's otherwise hairline-
 * driven surface language. Against white (#FFFFFF) #CBD2E0 measures
 * ~1.5:1, short of the WCAG 1.4.11 non-text contrast minimum of 3:1 for
 * a UI component boundary. The gap is accepted, not hidden: focus adds
 * a 3px `--brand-100` ring plus a `--brand-600` border (well over 3:1),
 * and every input sits inside a bordered panel, so the control is never
 * the only cue that a field exists. Documented here per PLAN.md §4 so
 * the tester can confirm the note, not report the ratio as a new find.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => {
    return (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-[34px] w-full rounded-md border border-[#CBD2E0] bg-white px-[10px] text-body text-ink',
          'placeholder:text-ink-3',
          'hover:border-[#B7C0D2]',
          'focus-visible:outline-none focus-visible:border-[#1662E8] focus-visible:ring-[3px] focus-visible:ring-[#E8F0FE]',
          'disabled:bg-[#F1F3F7] disabled:border-[#E2E6EE] disabled:text-ink-disabled',
          invalid &&
            'border-[#B3261E] focus-visible:border-[#B3261E] focus-visible:ring-[#FBEBE9]',
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
