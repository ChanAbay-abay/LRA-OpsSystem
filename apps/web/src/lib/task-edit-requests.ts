/**
 * LRA Global Ops :: task edit requests — shared types + pure diff helpers
 *
 * A GM's (or founder's/admin's) proposed change to a locked, committed
 * task's definition (PLAN.md §10 /
 * `supabase/migrations/20260910140000_ops_task_edit_requests.sql`). The
 * request carries the exact proposed change as data; approving it (the
 * clearing founder only) applies that change atomically inside the same
 * DB trigger that records the decision.
 *
 * This module owns the one thing the request dialog (raising a request)
 * and the approver's queue / a requester's own history (deciding or
 * reading one) all need in common: the row shape, and turning
 * `before_values` / `after_values` / `proposed_*` into a field-by-field
 * diff a person can actually read — never a bare JSON blob. "Approving
 * something you cannot see the shape of is the failure this whole flow
 * exists to prevent" (Chan's brief) is the reason this exists as pure,
 * unit-testable functions rather than being inlined into a component.
 */

export type EditRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

/** Mirrors `ops.task_edit_requests` (20260910140000) column-for-column. */
export interface TaskEditRequest {
  id: string;
  task_id: string;
  requested_by: string;
  requested_at: string;
  reason: string;
  change_title: boolean;
  proposed_title: string | null;
  change_description: boolean;
  proposed_description: string | null;
  change_task_type_id: boolean;
  proposed_task_type_id: string | null;
  change_owner_user_id: boolean;
  proposed_owner_user_id: string | null;
  change_client_ref: boolean;
  proposed_client_ref: string | null;
  status: EditRequestStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  before_values: Record<string, unknown> | null;
  after_values: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  /** Joined server-side by `GET /api/task-edit-requests` (routes/task-edit-requests.ts). */
  requestedByName?: string | null;
}

export type EditRequestFieldKey = 'title' | 'description' | 'task_type_id' | 'owner_user_id' | 'client_ref';

export interface FieldDiff {
  key: EditRequestFieldKey;
  label: string;
  before: string;
  after: string;
}

interface FieldMeta {
  key: EditRequestFieldKey;
  flag: keyof TaskEditRequest;
  proposed: keyof TaskEditRequest;
  label: string;
}

// Order matches the migration's column order and the create dialog's field order.
const FIELD_META: FieldMeta[] = [
  { key: 'title', flag: 'change_title', proposed: 'proposed_title', label: 'Title' },
  { key: 'description', flag: 'change_description', proposed: 'proposed_description', label: 'Description' },
  { key: 'task_type_id', flag: 'change_task_type_id', proposed: 'proposed_task_type_id', label: 'Catalog type' },
  { key: 'owner_user_id', flag: 'change_owner_user_id', proposed: 'proposed_owner_user_id', label: 'Owner' },
  { key: 'client_ref', flag: 'change_client_ref', proposed: 'proposed_client_ref', label: 'Client reference' },
];

export interface DiffResolvers {
  taskTypeName: (id: string) => string;
  memberName: (id: string) => string;
}

const EMPTY = '—';

function formatValue(key: EditRequestFieldKey, raw: unknown, resolve: DiffResolvers): string {
  if (raw === null || raw === undefined || raw === '') return EMPTY;
  if (key === 'task_type_id') return resolve.taskTypeName(String(raw));
  if (key === 'owner_user_id') return resolve.memberName(String(raw));
  return String(raw);
}

/**
 * One row per field actually proposed — driven by the `change_*` flags,
 * never a bare null check on `proposed_*` (the migration header's exact
 * reason: a proposed value of `null`, e.g. clearing a description, is a
 * real, intentional part of the change, not an absence to skip).
 *
 * `after` reads from `after_values` once the request has been decided
 * (the value actually applied, stamped atomically at approval) and falls
 * back to `proposed_*` while still pending, since `after_values` is null
 * until then.
 */
export function buildFieldDiffs(req: TaskEditRequest, resolve: DiffResolvers): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const meta of FIELD_META) {
    if (!req[meta.flag]) continue;
    const before = req.before_values ? req.before_values[meta.key] : undefined;
    const after =
      req.after_values && meta.key in req.after_values ? req.after_values[meta.key] : req[meta.proposed];
    diffs.push({
      key: meta.key,
      label: meta.label,
      before: formatValue(meta.key, before, resolve),
      after: formatValue(meta.key, after, resolve),
    });
  }
  return diffs;
}

/** True once every field this request proposes has a decided (or still-pending-but-known) after value. Used only to sanity-check a diff isn't silently empty. */
export function hasProposedFields(req: TaskEditRequest): boolean {
  return FIELD_META.some((m) => Boolean(req[m.flag]));
}
