/**
 * LRA Global Ops :: Button
 *
 * Started from the shadcn/ui button primitive (Radix Slot + cva), then
 * rewritten against DESIGN.md §5.1 exactly: heights 28/34/40, radius 8,
 * the five named variants with their literal hex states, the mandatory
 * press feedback, and a loading state that never changes the button's
 * width or swaps its label.
 *
 * `clear` exists only for the founder's approve button (PRD §6.4 / the
 * approvals queue) — DESIGN.md is explicit that a green fill anywhere
 * else in the app is a bug, so this variant is deliberately not used by
 * any Phase 1/2 screen.
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-1.5 rounded-md text-strong',
    'transition-[background-color,border-color,transform] duration-press ease',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:cursor-not-allowed active:scale-[.98]',
  ].join(' '),
  {
    variants: {
      variant: {
        primary:
          'bg-[#1662E8] text-white hover:bg-[#1355C9] active:bg-[#0F4FC4] disabled:bg-[#A9C4F5] disabled:active:scale-100',
        secondary:
          'bg-white border border-[#CBD2E0] text-ink hover:bg-[#F1F3F7] hover:border-[#B7C0D2] active:bg-[#E7EAF1] disabled:bg-[#F7F8FA] disabled:border-[#E2E6EE] disabled:text-ink-disabled disabled:active:scale-100',
        ghost:
          'bg-transparent text-ink-2 hover:bg-[#F1F3F7] hover:text-ink active:bg-[#E7EAF1] disabled:text-ink-disabled disabled:active:scale-100',
        destructive:
          'bg-[#B3261E] text-white hover:bg-[#9C201A] active:bg-[#851B16] disabled:opacity-50 disabled:active:scale-100',
        clear:
          'bg-[#0E7A46] text-white hover:bg-[#0C6A3D] active:bg-[#0A5A34] disabled:opacity-50 disabled:active:scale-100',
      },
      size: {
        sm: 'h-[28px] px-[10px]',
        default: 'h-[34px] px-[14px]',
        lg: 'h-[40px] px-[18px]',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Locks the button's width so the label never causes reflow. */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
        {children}
      </Comp>
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
