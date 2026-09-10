/**
 * LRA Global Ops :: `<TaskTypePicker>` — the points stepper
 *
 * Chan: "drop down for task type when creating a new task is too long.
 * maybe we could simplify it somehow where u can just click up or down
 * to increase the points then there are task examples for those
 * points." This replaces `create-task-dialog.tsx`'s 16-option `<select>`
 * with a Fibonacci points ladder (1/2/3/5/8/13/21) — step or jump to a
 * rung, then pick a catalog example priced there.
 *
 * MEASURED CAVEAT (do not remove this comment without re-checking the
 * live catalog): 15 active types, and **9 of them sit at 3 points** (3
 * at 5, 2 at 8, 1 at 21; nothing at 1, 2 or 13). The ladder alone turns
 * a 16-row list into a 9-row list at the rung people actually use — real,
 * but not by itself a fix for "too long". The filter input is what does
 * the remaining work at the crowded rung; it is not decoration.
 *
 * HARD CONSTRAINT: `ops.tasks.catalog_points` is server-derived (stamped
 * by a trigger from the chosen `task_type_id`) and the transition guard
 * refuses any client write to it (PLAN.md §2.4/§2.5). This component
 * therefore never emits a points number — `onChange` only ever carries a
 * catalog type id. The ladder is navigation onto that same catalog, not
 * a second source of the price.
 *
 * Empty rungs (1, 2, 13 today) still render, disabled, and say plainly
 * that nothing is priced there yet — DESIGN.md's "light, not daunting"
 * rule (§24 #10) never hides state, it explains it, and Chan's own
 * plan-review preference (PLAN.md §7 question 6) was explicit: hiding
 * half the scale makes the catalog look smaller than it is.
 *
 * A rung pill is kept a real `<button disabled>` for keyboard/AT
 * semantics, but its `<Hint>` still needs to fire on hover — native
 * `disabled` buttons drop pointer/mouse events in most engines before a
 * tooltip trigger ever sees them, which is why the disabled ones use
 * `aria-disabled` plus a no-op click guard instead of the `disabled`
 * attribute.
 */
import * as React from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Hint } from '@/components/ui/hint';
import { isPlaceholderPricing, stripPricingPrefix } from '@/lib/catalog-pricing';
import { cn } from '@/lib/utils';

/** `ops.task_types.default_points` CHECK constraint — the JS mirror lives in `@lra/ops-scoring`'s `fib.ts`; kept local here the same way `routes/catalog.tsx` does, since the web app does not depend on that package. */
const LADDER = [1, 2, 3, 5, 8, 13, 21] as const;

export interface PickableTaskType {
  id: string;
  name: string;
  category: string;
  guideline_note: string;
  default_points: number | null;
  is_active: boolean;
}

export interface TaskTypePickerProps {
  /** Active catalog types only — the caller already filters `is_active`. */
  types: PickableTaskType[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export function TaskTypePicker({ types, value, onChange, disabled = false }: TaskTypePickerProps) {
  const selected = types.find((t) => t.id === value) ?? null;

  const byRung = React.useMemo(() => {
    const map = new Map<number, PickableTaskType[]>();
    for (const t of types) {
      if (t.default_points == null) continue;
      const list = map.get(t.default_points) ?? [];
      list.push(t);
      map.set(t.default_points, list);
    }
    return map;
  }, [types]);

  const unpriced = React.useMemo(() => types.filter((t) => t.default_points == null), [types]);

  const firstNonEmptyRung = LADDER.find((r) => (byRung.get(r)?.length ?? 0) > 0) ?? LADDER[0];
  // Only initialised from `value` — after mount, `rung` and the
  // selection change together through this component's own handlers
  // (stepping the ladder, or picking a row from the current rung's
  // list), so there is never a render where they can drift and need an
  // effect to resync. No `useEffect` here on purpose.
  const [rung, setRung] = React.useState<number>(selected?.default_points ?? firstNonEmptyRung);
  const [query, setQuery] = React.useState('');

  const rungIndex = LADDER.indexOf(rung as (typeof LADDER)[number]);
  const canStepDown = rungIndex > 0;
  const canStepUp = rungIndex < LADDER.length - 1 && rungIndex !== -1;

  function stepBy(delta: number) {
    const i = LADDER.indexOf(rung as (typeof LADDER)[number]);
    const next = LADDER[Math.min(LADDER.length - 1, Math.max(0, (i === -1 ? 0 : i) + delta))];
    setRung(next);
  }

  const examples = byRung.get(rung) ?? [];
  const q = query.trim().toLowerCase();
  const filtered = q
    ? examples.filter((t) => t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q))
    : examples;
  const filteredUnpriced = q
    ? unpriced.filter((t) => t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q))
    : unpriced;

  if (types.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-hairline-strong bg-surface-2 px-3 py-4 text-center">
        <p className="text-body-sm text-ink-2">The catalog has nothing priced yet.</p>
        <p className="mt-0.5 text-micro text-ink-3">
          A task can still be created without a type — ask a GM or founder to price the catalog from Catalog.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Lower points"
          disabled={disabled || !canStepDown}
          onClick={() => stepBy(-1)}
          className="flex size-[34px] shrink-0 items-center justify-center rounded-md border border-[#CBD2E0] bg-white text-ink-2 hover:border-[#B7C0D2] hover:text-ink disabled:cursor-not-allowed disabled:border-[#E2E6EE] disabled:text-ink-disabled"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>

        <div role="group" aria-label="Points" className="flex flex-1 flex-wrap items-center justify-center gap-1">
          {LADDER.map((r) => {
            const count = byRung.get(r)?.length ?? 0;
            const isCurrent = r === rung;
            const isEmpty = count === 0;
            const pill = (
              <button
                key={r}
                type="button"
                aria-pressed={isCurrent}
                aria-disabled={isEmpty || disabled || undefined}
                onClick={() => {
                  if (isEmpty || disabled) return;
                  setRung(r);
                }}
                className={cn(
                  'num flex h-[34px] min-w-[34px] items-center justify-center rounded-md border px-2 text-num-sm transition-colors',
                  isEmpty
                    ? 'cursor-not-allowed border-dashed border-[#E2E6EE] text-ink-disabled'
                    : isCurrent
                      ? 'border-[#1662E8] bg-[#E8F0FE] text-[#1662E8]'
                      : 'border-[#CBD2E0] bg-white text-ink hover:border-[#B7C0D2]'
                )}
              >
                {r}
              </button>
            );
            return (
              <Hint
                key={r}
                text={isEmpty ? `Nothing priced at ${r} points yet.` : `${count} catalog type${count === 1 ? '' : 's'} at ${r} points`}
              >
                {pill}
              </Hint>
            );
          })}
        </div>

        <button
          type="button"
          aria-label="Higher points"
          disabled={disabled || !canStepUp}
          onClick={() => stepBy(1)}
          className="flex size-[34px] shrink-0 items-center justify-center rounded-md border border-[#CBD2E0] bg-white text-ink-2 hover:border-[#B7C0D2] hover:text-ink disabled:cursor-not-allowed disabled:border-[#E2E6EE] disabled:text-ink-disabled"
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>

      {examples.length > 0 ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Filter the ${examples.length} example${examples.length === 1 ? '' : 's'} at ${rung} points`}
            aria-label={`Filter catalog types at ${rung} points`}
            disabled={disabled}
            className="pl-8"
          />
        </div>
      ) : null}

      <div
        className="flex max-h-52 flex-col gap-1 overflow-y-auto rounded-md border border-hairline"
        aria-label={`Catalog types at ${rung} points`}
      >
        {examples.length === 0 ? (
          <p className="px-3 py-3 text-body-sm text-ink-3">Nothing priced at {rung} points yet.</p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-3 text-body-sm text-ink-3">No {rung}-point type matches “{query}”.</p>
        ) : (
          filtered.map((t) => (
            <TypeRow key={t.id} type={t} selected={t.id === value} disabled={disabled} onSelect={() => onChange(t.id)} />
          ))
        )}
      </div>

      {filteredUnpriced.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-eyebrow text-ink-3">Not yet priced</p>
          <div className="flex flex-col gap-1 rounded-md border border-hairline">
            {filteredUnpriced.map((t) => (
              <TypeRow key={t.id} type={t} selected={t.id === value} disabled={disabled} onSelect={() => onChange(t.id)} />
            ))}
          </div>
        </div>
      ) : null}

      {selected ? (
        <div className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-2.5 py-1.5">
          <p className="min-w-0 truncate text-body-sm text-ink">
            {selected.name}
            <span className="text-ink-3"> · {selected.category}</span>
          </p>
          <button
            type="button"
            onClick={() => onChange('')}
            disabled={disabled}
            className="shrink-0 text-micro text-ink-3 underline decoration-dotted hover:text-ink-2"
          >
            Clear
          </button>
        </div>
      ) : (
        <p className="text-micro text-ink-3">
          A task needs a catalog type before it can be submitted for approval — this can be set now or from the task
          later.
        </p>
      )}
    </div>
  );
}

function TypeRow({
  type,
  selected,
  disabled,
  onSelect,
}: {
  type: PickableTaskType;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const placeholder = isPlaceholderPricing(type);
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex items-start justify-between gap-3 border-b border-hairline px-3 py-2 text-left last:border-0 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60',
        selected ? 'bg-[#E8F0FE]' : undefined
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-body-sm text-ink">
          {type.name} <span className="text-micro text-ink-3">· {type.category}</span>
        </span>
        {type.guideline_note ? (
          <span className={cn('mt-0.5 block text-micro', placeholder ? 'text-pending' : 'text-ink-3')}>
            {stripPricingPrefix(type.guideline_note)}
          </span>
        ) : null}
      </span>
      <span className={cn('num shrink-0 text-num-sm', placeholder ? 'text-pending' : 'text-ink')}>
        {type.default_points ?? '—'}
      </span>
    </button>
  );
}
