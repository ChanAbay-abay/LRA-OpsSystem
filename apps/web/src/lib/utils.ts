/**
 * LRA Global Ops :: class-merge helper
 *
 * Standard shadcn `cn()` — `clsx` for conditional classes, `tailwind-merge`
 * to resolve conflicting Tailwind utilities (e.g. two different `px-*`
 * values) in favour of the last one, rather than emitting both.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
