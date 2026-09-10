/**
 * LRA Global Ops :: scoreboard period control
 *
 * Chan: "should have record of this week, month, 3 month, and overall."
 *
 * All four windows arrive in one `GET /api/scoreboard` payload (build
 * contract §D), so switching windows is a local state change — no
 * refetch, no skeleton, no spinner. That is the whole reason this is a
 * segmented control and not a `<Select>` that reloads the screen.
 *
 * Toggle buttons in a labelled group rather than a `tablist` with a
 * roving tabindex: there are four options, all four should be reachable
 * with Tab like every other control in this app, and `aria-pressed`
 * states the selection without this component having to reimplement
 * arrow-key focus management that Radix would otherwise own.
 *
 * No motion. DESIGN.md §7.2 bans movement on filtering, so the selected
 * segment's background changes colour (120ms, `--ease`) and nothing
 * slides.
 */
import { cn } from '@/lib/utils';
import { PERIOD_KEYS, PERIOD_TAB_LABEL, type PeriodKey } from './scoreboard-model';

export function PeriodTabs({
  value,
  onChange,
}: {
  value: PeriodKey;
  onChange: (next: PeriodKey) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Points period"
      className="inline-flex items-center gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5"
    >
      {PERIOD_KEYS.map((key) => {
        const selected = key === value;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(key)}
            className={cn(
              'h-[28px] rounded-sm px-2.5 text-label transition-[background-color,color] duration-press ease',
              selected
                ? 'bg-surface text-ink shadow-none'
                : 'text-ink-3 hover:text-ink-2 hover:bg-surface-3'
            )}
          >
            {PERIOD_TAB_LABEL[key]}
          </button>
        );
      })}
    </div>
  );
}
