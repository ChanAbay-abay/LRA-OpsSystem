/**
 * LRA Global Ops :: the briefing's step rail and step headings — DESIGN.md §21.1
 *
 * "The existing four sections are already the right steps; they just
 * don't say so." This file adds the two things DESIGN.md asks for on
 * top of the four sections that already exist (`routes/briefing.tsx`):
 * a `text-eyebrow` step marker + one-line purpose above each heading
 * (`<StepHeading>`), and a progress rail under the page header built out
 * of the same chain-of-custody dot language §6.3 already uses everywhere
 * else in the app — "reusing that language rather than inventing a
 * stepper is the point: the whole app already means left to right,
 * collecting endorsements."
 *
 * Driven by an `IntersectionObserver` on the four `<section id=…>`
 * elements the route renders, per spec (`useActiveBriefingStep`, split
 * into its own module — see that file's header for why). Below `md` the
 * rail is sticky under the header; above `md` it is static (handled by
 * the caller's className, not here — the rail itself doesn't know its
 * own position).
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface BriefingStep {
  id: string;
  title: string;
}

export function StepRail({
  steps,
  activeIndex,
  className,
}: {
  steps: readonly BriefingStep[];
  activeIndex: number;
  className?: string;
}) {
  const active = steps[activeIndex];
  return (
    <div
      className={cn(
        'sticky top-0 z-10 flex items-center gap-2 border-b border-hairline bg-surface px-1 py-2.5 md:static md:border-0 md:bg-transparent md:px-0 md:py-0',
        className
      )}
    >
      <div className="flex items-center gap-1.5" aria-hidden>
        {steps.map((step, i) => (
          <React.Fragment key={step.id}>
            {i > 0 ? (
              <span className={cn('h-px w-4 shrink-0 md:w-6', i <= activeIndex ? 'bg-cleared' : 'bg-hairline-strong')} />
            ) : null}
            <span
              className={cn(
                'flex size-[6px] shrink-0 rounded-full',
                i < activeIndex && 'bg-cleared',
                i === activeIndex && 'bg-pending ring-2 ring-pending-wash',
                i > activeIndex && 'border border-hairline-strong bg-transparent'
              )}
            />
          </React.Fragment>
        ))}
      </div>
      <span className="text-eyebrow text-ink-3">
        STEP {activeIndex + 1} OF {steps.length}
        {active ? <span className="ml-1.5 normal-case text-ink-2">{active.title}</span> : null}
      </span>
      {/* Decorative dots above are `aria-hidden`; this is the one thing a
          screen reader needs — same split §6.3 uses for the chain dots. */}
      <span className="sr-only" aria-live="polite">
        {active ? `Step ${activeIndex + 1} of ${steps.length}: ${active.title}` : null}
      </span>
    </div>
  );
}

export function StepHeading({
  step,
  total,
  title,
  purpose,
}: {
  step: number;
  total: number;
  title: string;
  purpose: string;
}) {
  return (
    <div className="mb-3">
      <p className="text-eyebrow text-ink-3">
        STEP {step} OF {total}
      </p>
      <h2 className="mt-0.5 text-title-lg text-ink lg:text-display">{title}</h2>
      <p className="mt-1 text-body-sm text-ink-3">{purpose}</p>
    </div>
  );
}
