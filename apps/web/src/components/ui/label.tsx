/**
 * LRA Global Ops :: Label
 *
 * DESIGN.md §5.2: `text-label` `--ink-2`. "Required" is spelled out in
 * `text-micro` `--ink-3` to the right of the label row, never a red
 * asterisk — see the `required` prop on <Field>.
 */
import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/utils';

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn('text-label text-ink-2', className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
