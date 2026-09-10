/**
 * LRA Global Ops :: `<WhatIsThis>` — DESIGN.md §20.3
 *
 * The permanent, per-screen answer to "what am I looking at, and what
 * do I do here" — sitting next to every `PageHeader` title so a person
 * can answer their own question instead of messaging Chan. Unlike
 * `<Hint>` (§20.2) this is a `Popover`, never a `Tooltip`: it holds a
 * few sentences and sometimes a short list, and a hover-triggered
 * tooltip that vanishes the moment the pointer leaves would make it
 * unreadable.
 *
 * It deliberately does NOT trap focus and does NOT dim the page — a
 * person reads this while still working, the same way they'd glance at
 * a help card taped to a monitor.
 */
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ArrowRight, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getHelpTopic, type HelpTopicId } from '@/lib/help';

export function WhatIsThis({ topic, className }: { topic: HelpTopicId; className?: string }) {
  const help = getHelpTopic(topic);

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors duration-fast hover:text-ink-2',
            className
          )}
          aria-label="What is this screen for?"
        >
          <HelpCircle className="size-5" aria-hidden />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className={cn(
            'z-50 w-[320px] rounded-lg border border-hairline bg-surface p-4 shadow-pop',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
            'data-[state=open]:animate-in fade-in-0 zoom-in-95 duration-pop ease-out'
          )}
        >
          <p className="text-subtitle text-ink">{help.title}</p>
          <div className="mt-2 flex max-w-prose flex-col gap-2">
            {help.body.map((paragraph, i) => (
              <p key={i} className="text-body-sm text-ink-2">
                {paragraph}
              </p>
            ))}
          </div>
          {help.todo && help.todo.length > 0 ? (
            <div className="mt-3 flex flex-col gap-1.5">
              <p className="text-eyebrow text-ink-3">WHAT TO DO HERE</p>
              <ul className="flex flex-col gap-1">
                {help.todo.map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-body-sm text-ink-2">
                    <ArrowRight className="mt-[3px] size-3 shrink-0 text-brand-600" aria-hidden />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
