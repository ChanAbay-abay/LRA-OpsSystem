/**
 * LRA Global Ops :: bulk edit suggestions — the local draft, as pure functions
 *
 * Chan, 2026-09-10: "GM can send a request to edit (should be done by
 * bulk like an edit feature on google docs), then approve by admin or
 * founder showing what changed like before and after".
 *
 * The Google Docs analogy is the specification, and the load-bearing part
 * of it is that **nothing is written until you submit**. So a GM's whole
 * session of edits lives here, in a plain value, until one POST sends the
 * batch. A design that PATCHed as you typed would destroy the property
 * Lane A's `ops.decide_edit_batch` exists to give: one decision applies
 * the whole batch or none of it.
 *
 * Everything in this file is pure so it can be unit-tested without a
 * browser — the same reason `lib/task-edit-requests.ts` and
 * `lib/board-groups.ts` are shaped this way. The component layer
 * (`components/briefing/**`) holds the draft in `useState` and calls
 * these; it never mutates the draft itself.
 *
 * Two things this module deliberately does NOT do:
 *
 * 1. It does not re-derive the definition lock. `task-permissions.ts`'s
 *    `definitionLockRefusal` already mirrors
 *    `ops.enforce_task_transition`'s guard 2b and is tested against it;
 *    a second copy is precisely the defect class PLAN.md §11.1 and §12.6
 *    are about.
 * 2. It does not decide staleness by guessing. A suggestion records the
 *    value it was made AGAINST (`original`), so "this field changed under
 *    you since you proposed it" is a comparison, not an inference.
 */

import type { EditRequestFieldKey, EditRequestStatus, FieldDiff, TaskEditRequest } from './task-edit-requests';
import type { Actor } from './task-permissions';

/** The five fields `ops.task_edit_requests` can carry, reused rather than re-listed. */
export type SuggestionField = EditRequestFieldKey;

/** A definition value as it travels: text, an id, or null (a deliberate clear). */
export type SuggestionValue = string | null;

export interface FieldSuggestion {
  /** What the suggester wants the field to become. */
  value: SuggestionValue;
  /**
   * What the field held when the suggestion was made. Kept so the UI can
   * show what a suggestion would REPLACE (Chan's "before and after") with
   * the original still legible, and so a field that moved underneath the
   * draft can be reported instead of silently overwriting someone else.
   */
  original: SuggestionValue;
}

export type TaskSuggestions = Partial<Record<SuggestionField, FieldSuggestion>>;

/** taskId -> the fields suggested on it. Local state only; never persisted server-side. */
export type SuggestionState = Record<string, TaskSuggestions>;

export const EMPTY_SUGGESTIONS: SuggestionState = {};

/** Order matches `task-edit-requests.ts`'s FIELD_META and the request dialog. */
export const SUGGESTION_FIELDS: SuggestionField[] = [
  'title',
  'description',
  'task_type_id',
  'owner_user_id',
  'client_ref',
];

export const SUGGESTION_FIELD_LABEL: Record<SuggestionField, string> = {
  title: 'Title',
  description: 'Description',
  task_type_id: 'Catalog type',
  owner_user_id: 'Owner',
  client_ref: 'Client reference',
};

/**
 * The column names the API takes (`POST /api/task-edit-batches`'s
 * `items[].changes`), which are camelCase there and snake_case on the
 * row. Written once, here, so the mapping cannot drift between the
 * submit call and the diff renderer.
 */
const API_FIELD_NAME: Record<SuggestionField, string> = {
  title: 'title',
  description: 'description',
  task_type_id: 'taskTypeId',
  owner_user_id: 'ownerUserId',
  client_ref: 'clientRef',
};

/** The minimum a task has to tell us to be suggestible against. */
export interface SuggestibleTask {
  id: string;
  title: string;
  description: string | null;
  task_type_id: string | null;
  owner_user_id: string;
  client_ref: string | null;
  status: string;
}

/**
 * Empty string and null are the same intent on every one of these fields
 * ("clear it"), and the inputs produce `''` where the row holds `null`.
 * Normalising once here is what stops "I focused the description and
 * tabbed out" from counting as a suggestion.
 */
function norm(v: SuggestionValue | undefined): string {
  return v == null ? '' : v.trim();
}

export function currentValue(task: SuggestibleTask, field: SuggestionField): SuggestionValue {
  switch (field) {
    case 'title':
      return task.title;
    case 'description':
      return task.description;
    case 'task_type_id':
      return task.task_type_id;
    case 'owner_user_id':
      return task.owner_user_id;
    case 'client_ref':
      return task.client_ref;
  }
}

/**
 * Record (or update, or cancel) one field suggestion on one task.
 *
 * Typing the original value back in is NOT a suggestion — it removes the
 * one that was there, and removes the task from the draft when that was
 * its last field. Google Docs does the same thing: a suggestion that
 * changes nothing does not exist.
 */
export function proposeChange(
  state: SuggestionState,
  task: SuggestibleTask,
  field: SuggestionField,
  next: SuggestionValue
): SuggestionState {
  const original = currentValue(task, field);
  const existing = state[task.id];

  if (norm(next) === norm(original)) {
    if (!existing || !(field in existing)) return state;
    return discardField(state, task.id, field);
  }

  const forTask: TaskSuggestions = {
    ...existing,
    // `original` is pinned to what the task holds NOW, on every keystroke,
    // rather than to the first edit: while the draft is live the value on
    // screen IS the current value, and re-pinning is what makes a genuine
    // outside change (§ staleFields) detectable instead of frozen out.
    [field]: { value: next, original },
  };
  return { ...state, [task.id]: forTask };
}

export function discardField(state: SuggestionState, taskId: string, field: SuggestionField): SuggestionState {
  const forTask = state[taskId];
  if (!forTask || !(field in forTask)) return state;
  const rest: TaskSuggestions = { ...forTask };
  delete rest[field];
  if (Object.keys(rest).length === 0) return discardTask(state, taskId);
  return { ...state, [taskId]: rest };
}

export function discardTask(state: SuggestionState, taskId: string): SuggestionState {
  if (!(taskId in state)) return state;
  const next = { ...state };
  delete next[taskId];
  return next;
}

export function discardAll(): SuggestionState {
  return EMPTY_SUGGESTIONS;
}

/** Field-level count — the running number the mode bar shows. */
export function suggestionCount(state: SuggestionState): number {
  return Object.values(state).reduce((n, forTask) => n + Object.keys(forTask).length, 0);
}

/** Task-level count, so the bar can say "4 suggestions on 2 tasks". */
export function suggestedTaskCount(state: SuggestionState): number {
  return Object.keys(state).length;
}

export function hasSuggestions(state: SuggestionState): boolean {
  return suggestedTaskCount(state) > 0;
}

export interface BatchItem {
  taskId: string;
  changes: Record<string, SuggestionValue>;
}

/**
 * The batch body for `POST /api/task-edit-batches` — one item per task,
 * one key per suggested field. A field suggested as empty is sent as
 * `null`, not omitted: on this table, presence is what proposes a change
 * and `null` is a legitimate proposed value (clearing a description),
 * which is why the migration's snapshot merges one-key objects instead of
 * calling `jsonb_strip_nulls`.
 */
export function toBatchItems(state: SuggestionState): BatchItem[] {
  return Object.entries(state).map(([taskId, forTask]) => {
    const changes: Record<string, SuggestionValue> = {};
    for (const field of SUGGESTION_FIELDS) {
      const s = forTask[field];
      if (!s) continue;
      changes[API_FIELD_NAME[field]] = norm(s.value) === '' ? null : s.value;
    }
    return { taskId, changes };
  });
}

/**
 * Fields that may not be proposed empty, and the sentence to say when
 * they are.
 *
 * Diffed against `routes/task-edit-batches.ts`'s `changesSchema`, which
 * is the schema that would refuse the batch: `title: z.string().min(1)`
 * and `ownerUserId: z.string().uuid()` are NOT nullable there, while
 * description, taskTypeId and clientRef are. A task must have a title and
 * an owner — "clear the title" is not a change anyone can make, and a
 * suggestion buffer that let someone build one would send a batch the API
 * rejects wholesale, after they had typed five other suggestions.
 */
const REQUIRED_FIELDS: Partial<Record<SuggestionField, string>> = {
  title: 'A task has to keep a title — type one, or discard this suggestion.',
  owner_user_id: 'A task has to keep an owner — choose one, or discard this suggestion.',
};

export interface SuggestionProblem {
  taskId: string;
  field: SuggestionField;
  message: string;
}

/** Every reason this draft cannot be submitted as it stands. Empty when it can. */
export function suggestionProblems(state: SuggestionState): SuggestionProblem[] {
  const problems: SuggestionProblem[] = [];
  for (const [taskId, forTask] of Object.entries(state)) {
    for (const field of SUGGESTION_FIELDS) {
      const s = forTask[field];
      const message = REQUIRED_FIELDS[field];
      if (!s || !message) continue;
      if (norm(s.value) === '') problems.push({ taskId, field, message });
    }
  }
  return problems;
}

export interface SuggestionResolvers {
  taskTypeName: (id: string) => string;
  memberName: (id: string) => string;
}

const EMPTY_LABEL = '—';

function format(field: SuggestionField, raw: SuggestionValue, resolve: SuggestionResolvers): string {
  if (raw == null || raw.trim() === '') return EMPTY_LABEL;
  if (field === 'task_type_id') return resolve.taskTypeName(raw);
  if (field === 'owner_user_id') return resolve.memberName(raw);
  return raw;
}

/**
 * A local draft rendered in the SAME `FieldDiff` shape a real
 * `ops.task_edit_requests` row produces, so
 * `components/tasks/edit-request-diff.tsx`'s `EditRequestDiffList`
 * renders a not-yet-submitted suggestion and an approver's pending
 * request with one component. Chan asked for before/after; there is
 * exactly one before/after renderer in this app and this is how a draft
 * gets into it.
 */
export function buildSuggestionDiffs(
  forTask: TaskSuggestions,
  resolve: SuggestionResolvers
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const field of SUGGESTION_FIELDS) {
    const s = forTask[field];
    if (!s) continue;
    diffs.push({
      key: field,
      label: SUGGESTION_FIELD_LABEL[field],
      before: format(field, s.original, resolve),
      after: format(field, s.value, resolve),
    });
  }
  return diffs;
}

/**
 * Fields whose value moved under the draft — someone else edited the task
 * while these suggestions were being written. Not an error: the batch is
 * still submittable, and the server re-snapshots `before_values` itself
 * at insert (never trusting the client's idea of "before"). It is
 * reported so nobody proposes to replace a sentence they never read.
 */
export function staleFields(forTask: TaskSuggestions, task: SuggestibleTask): SuggestionField[] {
  return SUGGESTION_FIELDS.filter((field) => {
    const s = forTask[field];
    if (!s) return false;
    return norm(s.original) !== norm(currentValue(task, field));
  });
}

/**
 * Why a task in the draft can no longer take this suggestion at all, or
 * null. Mirrors `ops.enforce_task_edit_request_insert`'s own refusal
 * ("this task is closed (%) and cannot take an edit request") plus the
 * case that refusal cannot express: the task is not in the payload any
 * more, because it was cancelled out of the week or deleted while the
 * draft was open.
 */
export function unavailableReason(task: SuggestibleTask | undefined): string | null {
  if (!task) return 'This task is no longer in this week — it was moved or removed while you were editing.';
  return statusUnavailableReason(task.status);
}

/**
 * The same refusal for a batch item, whose task status the API reports
 * directly (`items[].taskStatus`). Read from the server rather than
 * looked up client-side on purpose: a batch can carry a task that is not
 * on this screen's list at all — a different week, or one uncommitted
 * since — and the server is the one that can see it.
 */
export function statusUnavailableReason(status: string | null | undefined): string | null {
  if (status == null) {
    return 'This task is no longer visible — it was removed after the suggestion was made.';
  }
  if (status === 'cleared' || status === 'cancelled') {
    return `This task is ${status} and can no longer take an edit request.`;
  }
  return null;
}

// ---------------------------------------------------------------------
// Who may raise a batch, and who may decide one
// ---------------------------------------------------------------------

/**
 * `null` when this person may raise an edit suggestion at all; otherwise
 * why not.
 *
 * A faithful mirror of `ops.enforce_task_edit_request_insert`
 * (20260910140000:564-580) in the trigger's own order: `core.is_read_only()`
 * first, then `core.is_oversight()` — which is `authority in
 * ('gm','founder','admin')`. Deliberately NOT widened or narrowed: a GM
 * is the persona Chan named, and a founder/admin who prefers to batch
 * suggestions rather than edit directly is allowed by the same policy, so
 * the UI does not invent a restriction the database does not have.
 */
export function suggestionRefusal(actor: Actor | null): string | null {
  if (!actor) return 'You are not signed in.';
  if (actor.readOnly) return 'Your account is read-only.';
  if (actor.authority === 'gm' || actor.authority === 'founder' || actor.authority === 'admin') return null;
  return 'Only a GM, founder or admin can suggest changes to a locked task.';
}

export interface DecidableBatch {
  requested_by: string;
  status: EditRequestStatus;
  itemCount: number;
}

/**
 * `null` when this person may approve or reject THIS batch; otherwise why
 * not, in a sentence meant to be read next to the disabled control.
 *
 * Mirrors Lane A's `ops.decide_edit_batch` and the widened
 * `ops.enforce_task_edit_request_transition`, branch for branch and in
 * the same order (CONTRACT-BULK-EDITS.md §A.3/§A.4):
 *
 *   `core.is_read_only()`      -> refused first, wrapping everything
 *   `core.is_founder()`        -> authority in ('founder','admin'), verified
 *                                against core.is_founder()'s body in
 *                                20260908120100_core_identity.sql:149
 *   already decided            -> refuse a second decision
 *   requester = caller         -> the self-approval guard, preserved
 *   empty batch                -> refuse
 *
 * Note what this is NOT: `core.is_clearing_founder()`. Chan's words were
 * "approve by admin or founder", which is `core.is_founder()`, and the
 * contract records that this supersedes 20260910140000's clearing-founder
 * decision on his instruction. The read-only wrapper is what keeps ERC
 * and DCA — who hold `founder` authority and may change nothing — out of
 * it; that is the exact defect class this repo swept on 2026-09-10, so
 * `readOnly` is checked before authority is ever consulted, the same
 * placement `moveRefusal` and `blockResolveRefusal` use.
 */
export function batchDecisionRefusal(batch: DecidableBatch, actor: Actor | null): string | null {
  if (!actor) return 'You are not signed in.';
  if (actor.readOnly) return 'Your account is read-only.';
  if (actor.authority !== 'founder' && actor.authority !== 'admin') {
    return 'Only a founder or admin can decide an edit request.';
  }
  if (batch.status !== 'pending') {
    return `This batch has already been ${batch.status}.`;
  }
  if (batch.requested_by === actor.id) {
    return 'You raised this — the other founder or admin has to decide it.';
  }
  if (batch.itemCount === 0) {
    return 'This batch has no changes in it.';
  }
  return null;
}

// ---------------------------------------------------------------------
// The API's batch shape
// ---------------------------------------------------------------------

/**
 * A child row of a batch: exactly an `ops.task_edit_requests` row, plus
 * the two things the API joins on so the approval screen needs no second
 * fetch per item (`routes/task-edit-batches.ts`'s `AssembledItem`).
 */
export interface TaskEditBatchItem extends TaskEditRequest {
  batch_id?: string | null;
  taskTitle?: string | null;
  taskStatus?: string | null;
}

/** `ops.task_edit_batches` + its children, as `GET /api/task-edit-batches` returns them. */
export interface TaskEditBatch {
  id: string;
  requested_by: string;
  requested_at: string;
  reason: string;
  status: EditRequestStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  requestedByName?: string | null;
  decidedByName?: string | null;
  /** Server-computed, so the count on the card is the count the decision applies to. */
  itemCount: number;
  taskCount: number;
  /**
   * The API's own answer to "can this batch still be applied at all" —
   * true when any item's task went cleared/cancelled or out of sight. It
   * matters before the click: `ops.decide_edit_batch` is all-or-nothing
   * and refuses the whole batch, so an approver must be told first.
   */
  hasUnapplicableItem: boolean;
  items: TaskEditBatchItem[];
}

/**
 * One narrow gate on the API's payload, checked against
 * `routes/task-edit-batches.ts`'s `AssembledBatch` once Lane A landed it.
 *
 * It exists for one reason: a batch whose children did not arrive must
 * render its "no readable changes" state, NOT an empty card with an
 * Approve button on it. Approving something you cannot see the shape of
 * is the failure this whole flow exists to prevent, and an absent
 * `items` array is the one way that can still happen.
 */
export function normalizeBatch(raw: unknown): TaskEditBatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const items = Array.isArray(r.items) ? (r.items as TaskEditBatchItem[]) : [];
  return {
    id: r.id,
    requested_by: typeof r.requested_by === 'string' ? r.requested_by : '',
    requested_at: typeof r.requested_at === 'string' ? r.requested_at : '',
    reason: typeof r.reason === 'string' ? r.reason : '',
    status: (r.status as EditRequestStatus) ?? 'pending',
    decided_by: (r.decided_by as string | null) ?? null,
    decided_at: (r.decided_at as string | null) ?? null,
    decision_reason: (r.decision_reason as string | null) ?? null,
    requestedByName: (r.requestedByName as string | null | undefined) ?? null,
    decidedByName: (r.decidedByName as string | null | undefined) ?? null,
    // The server's counts, when it sent them; otherwise counted from what
    // actually arrived, never asserted from nothing.
    itemCount: typeof r.itemCount === 'number' ? r.itemCount : items.length,
    taskCount:
      typeof r.taskCount === 'number' ? r.taskCount : new Set(items.map((i) => i.task_id)).size,
    hasUnapplicableItem:
      typeof r.hasUnapplicableItem === 'boolean'
        ? r.hasUnapplicableItem
        : items.some((i) => statusUnavailableReason(i.taskStatus) !== null),
    items,
  };
}
