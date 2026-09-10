/**
 * LRA Global Ops :: `<ListRow>` — DESIGN.md §16.6
 *
 * Eight screens render "a list of things with meta on the right" as
 * `flex items-center gap-4` with fixed-width columns, and every one of
 * them squeezes below `sm` (375px design target). One shared shape,
 * used everywhere that pattern shows up, rather than eight local fixes
 * that drift from each other the next time one of them changes:
 *
 * ```
 * ≥640:   [ icon ] [ title ......................... ] [ meta ] [ meta ] [ actions ]
 * <640:   [ icon ] [ title ..................... ] [ actions ]
 *                  [ meta · meta · meta ]
 * ```
 *
 * `meta` renders twice in the DOM on purpose — once inline as fixed-width
 * columns for `sm:` and up, once as a wrapped, dot-separated line below
 * it that only shows below `sm` — rather than trying to reflow one set
 * of nodes between two layouts with CSS alone. A list row is cheap; the
 * duplication costs nothing a user or a profiler would notice.
 *
 * `<ListRow>` does not decide colour or numeric formatting for a meta
 * value — the caller passes already-toned content (`ageTone(ms)`,
 * `.num-pending`, etc., per §16.6: "each keeps its own tone"). This
 * component only owns the row's structure and where things sit at each
 * width.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ListRowMetaItem {
  key: string;
  content: React.ReactNode;
  /**
   * A fixed column width, applied ONLY at `sm:` and up
   * (`sm:w-14`, `sm:w-20`, …) — DESIGN.md §16.2 rule 5: a fixed pixel
   * width below `sm` is a bug. Omit it to let the column size to its
   * content instead.
   */
  smWidth?: string;
  className?: string;
}

export interface ListRowProps {
  icon?: React.ReactNode;
  /** The identifying text — `text-body-sm`, truncated, never the thing that wraps. */
  title: React.ReactNode;
  meta?: ListRowMetaItem[];
  /** Right-aligned on line 1, always — never wrapped, never collapsed into a menu. */
  actions?: React.ReactNode;
  className?: string;
  /** Forwarded to the row's outer element — e.g. `onClick` for a clickable row. */
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}

export function ListRow({ icon, title, meta = [], actions, className, onClick }: ListRowProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)} onClick={onClick}>
      {/* Line 1: icon, title, actions always; each meta value gets its
          own column from `sm:` up. */}
      <div className="flex items-center gap-3">
        {icon ? (
          <span className="flex shrink-0 items-center justify-center" aria-hidden>
            {icon}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{title}</span>
        {meta.map((item) => (
          <span
            key={item.key}
            className={cn('hidden shrink-0 text-right text-micro text-ink-2 sm:block', item.smWidth, item.className)}
          >
            {item.content}
          </span>
        ))}
        {actions ? (
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">{actions}</div>
        ) : null}
      </div>

      {/* Line 2, below `sm` only: every meta value, wrapped, `·`-separated,
          no column alignment — `tnum` buys column alignment and at one
          column there are no columns (§16.6). */}
      {meta.length > 0 ? (
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-1.5 gap-y-1 text-micro text-ink-3 sm:hidden',
            icon ? 'pl-[26px]' : undefined
          )}
        >
          {meta.map((item, i) => (
            <React.Fragment key={item.key}>
              {i > 0 ? (
                <span aria-hidden className="text-ink-3">
                  ·
                </span>
              ) : null}
              <span className={item.className}>{item.content}</span>
            </React.Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
