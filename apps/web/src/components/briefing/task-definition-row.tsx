/**
 * LRA Global Ops :: one committed task's definition, on the briefing screen
 *
 * The Monday record, row by row: what was promised, and — for the people
 * allowed to — the surface for changing it. Two personas, two very
 * different acts, deliberately not blurred into one control:
 *
 * - **Founder / admin edit directly.** Chan: "make sure for the monday
 *   briefing one the admin and founder be able to edit stuff." They
 *   already may on the database's terms (`ops.enforce_task_transition`'s
 *   guard 2b exempts `core.is_founder()`), and the board's task modal
 *   already offered it — the briefing, the screen this record actually
 *   lives on, did not. The control here opens the SAME
 *   `TaskEditRequestDialog` in `direct` mode the board uses, so there is
 *   one direct-edit form in the app and it keeps behaving identically.
 *
 * - **A GM suggests.** In suggestion mode this row's fields become
 *   editable and every change is held in local state (see
 *   `lib/edit-suggestions.ts`) — nothing is written until the whole batch
 *   is submitted. A field carrying a suggestion is marked, and the value
 *   it would replace stays legible underneath it, because "a suggestion
 *   shows what it would replace" is the part of the Google Docs analogy
 *   that does the work.
 *
 * Nobody's permission is re-derived here. The refusal sentences arrive as
 * props from `task-permissions.ts`'s `definitionLockRefusal` and
 * `edit-suggestions.ts`'s `suggestionRefusal`, which are the tested
 * mirrors of the policies (PLAN.md §11.1's lesson: a client-side
 * permission mirror that was never diffed against its policy is a second
 * opinion, not a mirror).
 */
import * as React from 'react';
import { Pencil, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  SUGGESTION_FIELDS,
  SUGGESTION_FIELD_LABEL,
  currentValue,
  staleFields,
  type SuggestibleTask,
  type SuggestionField,
  type TaskSuggestions,
} from '@/lib/edit-suggestions';

/** `ops.tasks`, as `GET /api/tasks?weekId=…&committed=true` returns it. */
export interface BriefingTask extends SuggestibleTask {
  catalog_points: number | null;
  points_override: number | null;
  committed_points: number | null;
  is_committed: boolean;
}

export interface BriefingTaskType {
  id: string;
  name: string;
  default_points: number | null;
  is_active: boolean;
}

export interface BriefingMember {
  userId: string;
  name: string | null;
  email: string | null;
  position: string;
  /** `core.users.read_only`. Optional: a payload without it must never exclude a real teammate. */
  readOnly?: boolean;
}

export function TaskDefinitionRow({
  task,
  types,
  members,
  suggestions,
  suggesting,
  onPropose,
  onDiscardField,
  onDiscardTask,
  showDirectEdit,
  directEditRefusal,
  onDirectEdit,
}: {
  task: BriefingTask;
  types: BriefingTaskType[];
  members: BriefingMember[];
  suggestions: TaskSuggestions | undefined;
  /** True when the screen is in suggestion mode AND this person may suggest. */
  suggesting: boolean;
  onPropose: (task: BriefingTask, field: SuggestionField, value: string | null) => void;
  onDiscardField: (taskId: string, field: SuggestionField) => void;
  onDiscardTask: (taskId: string) => void;
  /**
   * False for staff and anyone else for whom editing the Monday record is
   * not a thing they could ever do — the control is absent, not disabled.
   * `task-permissions.ts`'s rule: absence for a whole meaningless
   * surface, a reason for a control inside a screen they legitimately
   * read.
   */
  showDirectEdit: boolean;
  /** null when this person may edit the definition outright; otherwise why not. */
  directEditRefusal: string | null;
  onDirectEdit: (task: BriefingTask) => void;
}) {
  const suggested = suggestions ?? {};
  const suggestedCount = Object.keys(suggested).length;
  // A task that already carries suggestions opens itself, so a restored
  // draft is never invisible behind a collapsed row. Derived rather than
  // synced in an effect: the default IS "open when it has suggestions",
  // and `manual` only records a deliberate override of that default.
  const [manual, setManual] = React.useState<boolean | null>(null);
  const open = manual ?? suggestedCount > 0;

  const stale = suggestedCount > 0 ? staleFields(suggested, task) : [];
  const typeName = types.find((t) => t.id === task.task_type_id)?.name ?? null;
  const ownerName = memberLabel(members, task.owner_user_id);
  const points = task.committed_points ?? task.points_override ?? task.catalog_points;

  return (
    <div
      className={cn(
        'border-b border-hairline px-4 py-3 last:border-0',
        suggestedCount > 0 && 'bg-pending-wash'
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-eyebrow text-ink-3">{typeName ?? 'No catalog type'}</p>
          <p className="text-body font-medium text-ink">{task.title}</p>
          <p className="text-body-sm text-ink-3">
            {ownerName}
            {task.client_ref ? ` · ${task.client_ref}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className={cn('num text-num-md', points == null ? 'text-ink-3' : 'text-ink-2')}>
            {points == null ? '—' : points}
          </span>
          {suggesting ? (
            <Button variant="secondary" size="sm" onClick={() => setManual(!open)} aria-expanded={open}>
              {open ? 'Hide fields' : suggestedCount > 0 ? 'Show suggestions' : 'Suggest a change'}
            </Button>
          ) : !showDirectEdit ? null : directEditRefusal === null ? (
            <Button variant="secondary" size="sm" onClick={() => onDirectEdit(task)}>
              <Pencil className="size-3.5" aria-hidden />
              Edit
            </Button>
          ) : (
            // Visible-but-refused, with the reason: this is a screen a
            // read-only founder legitimately reads, so the control states
            // why rather than vanishing (task-permissions.ts's rule).
            <Button variant="secondary" size="sm" disabled title={directEditRefusal}>
              <Pencil className="size-3.5" aria-hidden />
              Edit
            </Button>
          )}
        </div>
      </div>

      {suggestedCount > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="text-body-sm text-pending">
            {suggestedCount} unsubmitted {suggestedCount === 1 ? 'suggestion' : 'suggestions'} on this task
          </span>
          <button
            type="button"
            className="text-body-sm text-ink-3 underline"
            onClick={() => onDiscardTask(task.id)}
          >
            Discard all on this task
          </button>
          {stale.length > 0 ? (
            <span className="text-body-sm text-danger">
              {stale.map((f) => SUGGESTION_FIELD_LABEL[f]).join(', ')} changed on the task after you suggested
              — check the "was" value before submitting.
            </span>
          ) : null}
        </div>
      ) : null}

      {suggesting && open ? (
        <div className="mt-3 flex flex-col gap-3 rounded-lg border border-hairline bg-surface p-3">
          {SUGGESTION_FIELDS.map((field) => (
            <SuggestionFieldRow
              key={field}
              field={field}
              task={task}
              types={types}
              members={members}
              suggestion={suggested[field]}
              isStale={stale.includes(field)}
              onPropose={onPropose}
              onDiscard={onDiscardField}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function memberLabel(members: BriefingMember[], userId: string): string {
  const m = members.find((x) => x.userId === userId);
  return m?.name ?? m?.email ?? 'Unknown owner';
}

/**
 * One field. The input holds the suggested value when there is one and
 * the task's real value otherwise, so the row always shows what the field
 * WOULD say — and when a suggestion exists, the value it replaces is
 * printed under it, struck through, in the same before/after grammar
 * `EditRequestDiffList` uses on the approver's side.
 */
function SuggestionFieldRow({
  field,
  task,
  types,
  members,
  suggestion,
  isStale,
  onPropose,
  onDiscard,
}: {
  field: SuggestionField;
  task: BriefingTask;
  types: BriefingTaskType[];
  members: BriefingMember[];
  suggestion: { value: string | null; original: string | null } | undefined;
  isStale: boolean;
  onPropose: (task: BriefingTask, field: SuggestionField, value: string | null) => void;
  onDiscard: (taskId: string, field: SuggestionField) => void;
}) {
  const live = currentValue(task, field);
  const shown = suggestion ? suggestion.value : live;
  const marked = Boolean(suggestion);
  const inputId = `sugg-${task.id}-${field}`;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-eyebrow text-ink-3">
          {SUGGESTION_FIELD_LABEL[field]}
        </label>
        {marked ? (
          <button
            type="button"
            className="flex items-center gap-1 text-body-sm text-ink-3 underline"
            onClick={() => onDiscard(task.id, field)}
          >
            <Undo2 className="size-3.5" aria-hidden />
            Discard
          </button>
        ) : null}
      </div>

      <div
        className={cn(
          // The suggestion mark: a 3px rail in the pending colour, the
          // same "this value is not settled yet" signal DESIGN.md §6.1
          // gives every unsettled figure in the app.
          marked && 'border-l-[3px] border-pending pl-2'
        )}
      >
        {field === 'task_type_id' ? (
          <Select
            value={shown ?? ''}
            onValueChange={(v) => onPropose(task, field, v || null)}
          >
            <SelectTrigger id={inputId}>
              <SelectValue placeholder="No catalog type" />
            </SelectTrigger>
            <SelectContent>
              {types
                .filter((t) => t.is_active || t.id === live)
                .map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} — {t.default_points ?? '—'} pts
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : field === 'owner_user_id' ? (
          <Select value={shown ?? ''} onValueChange={(v) => onPropose(task, field, v || null)}>
            <SelectTrigger id={inputId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {members
                // A read-only account can never own, submit or clear a
                // task, so it is never a legal reassignment target —
                // the same rule as the three other person pickers
                // (PLAN.md §11.4 #5).
                .filter((m) => m.userId && (!m.readOnly || m.userId === live))
                .map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.name ?? m.email ?? m.userId}
                    {m.position ? ` · ${m.position}` : ''}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        ) : field === 'description' ? (
          <textarea
            id={inputId}
            value={shown ?? ''}
            onChange={(e) => onPropose(task, field, e.target.value)}
            placeholder="Leave blank to suggest clearing the description"
            className="min-h-[70px] w-full rounded-md border border-hairline-strong bg-surface px-[10px] py-2 text-body text-ink placeholder:text-ink-3 focus-visible:border-brand-600 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-100"
          />
        ) : (
          <Input
            id={inputId}
            value={shown ?? ''}
            onChange={(e) => onPropose(task, field, e.target.value)}
            placeholder={field === 'client_ref' ? 'Leave blank to suggest clearing it' : undefined}
          />
        )}

        {marked ? (
          <p className={cn('mt-1 text-body-sm', isStale ? 'text-danger' : 'text-ink-3')}>
            <span className="text-eyebrow">was </span>
            <span className="line-through decoration-danger/60">
              {displayValue(field, isStale ? live : (suggestion?.original ?? null), types, members)}
            </span>
            {isStale ? ' — changed on the task since you suggested this' : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function displayValue(
  field: SuggestionField,
  raw: string | null,
  types: BriefingTaskType[],
  members: BriefingMember[]
): string {
  if (raw == null || raw.trim() === '') return '—';
  if (field === 'task_type_id') return types.find((t) => t.id === raw)?.name ?? 'Unknown type';
  if (field === 'owner_user_id') return memberLabel(members, raw);
  return raw;
}
