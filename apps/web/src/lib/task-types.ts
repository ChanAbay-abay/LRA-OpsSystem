/**
 * LRA Global Ops :: the shared task / block vocabulary
 *
 * These shapes and the words used to describe them used to live inside
 * `routes/board.tsx`, because the board was the only screen that had
 * the whole task row. Now (`routes/now.tsx`) opens the same detail
 * modal (Chan, 2026-09-10: "now page tasks should be interactable"), so
 * a second real consumer exists and the definitions move here — one
 * copy, imported by both routes and by
 * `components/tasks/task-detail-dialog.tsx`.
 *
 * Nothing in this file decides anything. Permission mirrors live in
 * `lib/task-permissions.ts` and the database is still the only
 * enforcement; this is types plus how a task is spoken about.
 */

/**
 * A full task row as `GET /api/tasks/board`'s columns and
 * `GET /api/tasks/:id` both return it: every `ops.tasks` column plus the
 * four enrichments (`ownerName`, `ownerPosition`, `openBlockCount`,
 * `noteCount`). The two endpoints are byte-identical in shape on
 * purpose — that is what lets a slim list screen open the full modal.
 */
export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  owner_user_id: string;
  week_id: string;
  task_type_id: string | null;
  client_ref: string | null;
  catalog_points: number | null;
  points_override: number | null;
  points_override_reason: string | null;
  points_awarded: number | null;
  is_recurring: boolean;
  is_committed: boolean;
  committed_points: number | null;
  carry_over_count: number;
  rejected_reason: string | null;
  created_at: string;
  last_activity_at: string;
  cleared_at: string | null;
  openBlockCount: number;
  noteCount: number;
  ownerName: string | null;
  ownerPosition: string | null;
  // Present once a cancellation has been flagged (PLAN.md's cancellation
  // ladder). `pre_cancellation_status` is what places the card back in
  // its real column while `status` itself reads `pending_cancellation`.
  pre_cancellation_status: string | null;
  cancellation_reason: string | null;
  cancellation_requested_at: string | null;
}

export interface Note {
  id: string;
  body: string;
  created_at: string;
  authorName: string | null;
}

/**
 * One `ops.task_blocks` row as `GET /api/tasks/:id/blocks` returns it —
 * `select('*')` spread, plus three resolved display names.
 *
 * `created_by` and `blocking_user_id` were always in the payload and
 * were simply not declared here. They are declared now because they are
 * the two identities `blockResolveRefusal` (lib/task-permissions.ts)
 * decides on — Chan, 2026-09-10: "users cant unblock a task". A block's
 * resolve authority is a statement about WHO raised it and WHO it names,
 * so the UI cannot be honest about that button without these fields.
 */
export interface TaskBlock {
  id: string;
  target: string;
  reason: string;
  created_at: string;
  resolved_at: string | null;
  created_by: string;
  blocking_user_id: string | null;
  /**
   * The task named by a `task`-target block. Declared 2026-09-10 with
   * the block dialog's target picker: it was always in the payload
   * (`select('*')`), but until the picker existed no UI path could
   * write it, so nothing read it either.
   */
  blocking_task_id: string | null;
  blocking_external: string | null;
  /**
   * Whatever the block names, already resolved server-side — the
   * person's display name, the blocking task's title, or the free-text
   * outside party (`blockDisplayName`, apps/api/src/routes/tasks.ts).
   * `null` is a real absence, never a placeholder.
   */
  blockingName: string | null;
  createdByName: string | null;
  resolvedByName: string | null;
}

/**
 * `STATUS_LABEL` used to live here (DESIGN.md §17.1's move table) — it
 * is `taskStatusLabel` in `lib/labels.ts` now, the one file in the web
 * app allowed to hold a display string for a database enum. Import it
 * from there directly; this file is types and tone, not words.
 */

/** Which DESIGN.md §2.3 semantic hue a status belongs to. One hue per meaning. */
export function statusTone(status: string): 'neutral' | 'pending' | 'cleared' | 'danger' {
  if (status === 'cleared') return 'cleared';
  if (status === 'submitted' || status === 'verified') return 'pending';
  if (status === 'rejected' || status === 'cancelled' || status === 'pending_cancellation') return 'danger';
  return 'neutral';
}

/** Avatar initials — DESIGN.md §5.4's 20px avatar, on the card and in the modal. */
export function initials(name: string | null) {
  return (name ?? '?').slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------
// Block relationships — moved to `lib/labels.ts` (DESIGN.md §17.1's
// move table: "wording unchanged"), re-exported here so every existing
// `import { blockRelation, blockRelationLabel } from '@/lib/task-types'`
// keeps working without a call-site change in this pass.
// ---------------------------------------------------------------------

export {
  blockRelation,
  blockRelationLabel,
  type BlockRelation,
  type BlockParties,
  type BlockTarget,
} from './labels';

// ---------------------------------------------------------------------
// Declaring a block — what makes a draft sendable
// ---------------------------------------------------------------------

/** What the block dialog has collected so far. */
export interface BlockDraft {
  target: 'task' | 'person' | 'external';
  /** The chosen roster member, or '' while nothing is chosen. */
  blockingUserId: string;
  /** The chosen blocking task, or '' while nothing is chosen. */
  blockingTaskId: string;
  /** The free-text outside party. */
  blockingExternal: string;
  reason: string;
}

/** DESIGN.md §5.2 and `blockSchema` (apps/api/src/routes/tasks.ts) both fix this at 10. */
export const BLOCK_REASON_MIN = 10;

/**
 * Why this block cannot be declared yet, in one sentence — or `null`
 * when it can.
 *
 * A faithful mirror of `POST /api/tasks/:id/blocks`, in the order that
 * route checks: `blockSchema`'s `reason.min(10)` first, then the one
 * required field for the chosen target (`chk_ops_task_blocks_one_target`
 * is the database's own version of that last rule). Written as a mirror
 * for the same reason `lib/task-permissions.ts` is — the API and the
 * check constraint remain the only enforcement; this exists so the
 * dialog never fires a request it already knows will 400, and so the
 * person is told which field is missing instead of being handed a
 * disabled button with no explanation.
 *
 * Added 2026-09-10 with the target picker. Before it, choosing "someone
 * on the team" left the submit button enabled and the request came back
 * 400, because the dialog could only ever send an `external` block.
 */
export function blockSubmitRefusal(draft: BlockDraft): string | null {
  if (draft.reason.trim().length < BLOCK_REASON_MIN) {
    return `Write a reason of at least ${BLOCK_REASON_MIN} characters — a block goes on the record.`;
  }
  if (draft.target === 'person' && !draft.blockingUserId) {
    return 'Choose the person this work is waiting on.';
  }
  if (draft.target === 'task' && !draft.blockingTaskId) {
    return 'Choose the task this work is waiting on.';
  }
  if (draft.target === 'external' && !draft.blockingExternal.trim()) {
    return 'Name the outside party this work is waiting on.';
  }
  return null;
}
