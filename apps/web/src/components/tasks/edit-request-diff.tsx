/**
 * LRA Global Ops :: task edit request — the diff card
 *
 * One rendering of "what a request proposes", shared by the requester's
 * own history (the task detail dialog — Task 4: "the GM should be able
 * to see what happened to their request") and the clearing founder's
 * decision queue (Task 3: "a diff, not a summary — approving something
 * you cannot see the shape of is the failure this whole flow exists to
 * prevent"). `actions` is the only thing that differs between call sites;
 * the diff itself, the status, and the reason are read identically by
 * both, on purpose — a requester should see exactly what the approver saw.
 *
 * 2026-09-10, bulk edits: `EditBatchCard` at the bottom of this file is
 * the same idea one level up — a whole batch of proposed changes decided
 * as one act (Chan: "should be done by bulk like an edit feature on
 * google docs, then approve by admin or founder showing what changed like
 * before and after"). It renders through `EditRequestDiffList` too, and so
 * does a GM's not-yet-submitted draft on the briefing screen
 * (`lib/edit-suggestions.ts`'s `buildSuggestionDiffs` emits the same
 * `FieldDiff[]`). Three surfaces, one before/after renderer — extending
 * this file rather than writing a second one is the whole point.
 */
import * as React from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EditRequestStatus, FieldDiff, TaskEditRequest } from '@/lib/task-edit-requests';
import type { TaskEditBatch } from '@/lib/edit-suggestions';

const STATUS_TONE: Record<EditRequestStatus, string> = {
  pending: 'border-pending-border bg-pending-wash text-pending',
  approved: 'border-cleared-border bg-cleared-wash text-cleared',
  rejected: 'border-danger-border bg-danger-wash text-danger',
  withdrawn: 'border-hairline bg-surface-2 text-ink-3',
};

const STATUS_LABEL: Record<EditRequestStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export function EditRequestStatusChip({ status }: { status: EditRequestStatus }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center whitespace-nowrap rounded-xs border px-2',
        'text-micro font-medium leading-none',
        STATUS_TONE[status]
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Before -> after, one row per proposed field. Never collapses to a summary sentence. */
export function EditRequestDiffList({ diffs }: { diffs: FieldDiff[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {diffs.map((d) => (
        <div key={d.key} className="flex flex-wrap items-start gap-2 text-body-sm">
          <span className="w-[104px] shrink-0 pt-0.5 text-eyebrow text-ink-3">{d.label}</span>
          {/*
            Reproduced defect, fixed here: a single-line `truncate` on a
            title long enough that only its TAIL differs (the common
            case — "…#HIST-302" -> "…#HIST-302 (RENAMED)") elided the one
            part of the string that was actually the point, so before and
            after read as identical at a glance. This is the exact
            failure Task 3's brief warns against ("approving something
            you cannot see the shape of"), so these wrap instead of
            eliding — a diff card has the vertical room a table row
            doesn't.
          */}
          <span className="min-w-0 max-w-[300px] whitespace-pre-wrap break-words rounded bg-danger-wash px-1.5 py-0.5 text-ink-2 line-through decoration-danger/60">
            {d.before}
          </span>
          <ArrowRight className="mt-1 size-3.5 shrink-0 text-ink-3" aria-hidden />
          <span className="min-w-0 max-w-[300px] whitespace-pre-wrap break-words rounded bg-cleared-wash px-1.5 py-0.5 text-ink">
            {d.after}
          </span>
        </div>
      ))}
    </div>
  );
}

export function EditRequestCard({
  request,
  diffs,
  taskTitle,
  actions,
}: {
  request: TaskEditRequest;
  diffs: FieldDiff[];
  /** Shown when this card is rendered outside the context of its own task (the approver's queue spans many tasks). */
  taskTitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-hairline px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {taskTitle ? <span className="min-w-0 truncate text-body font-medium text-ink">{taskTitle}</span> : null}
          <EditRequestStatusChip status={request.status} />
        </div>
        <span className="shrink-0 text-micro text-ink-3">
          {request.requestedByName ?? 'unknown'} · {new Date(request.requested_at).toLocaleString()}
        </span>
      </div>

      <EditRequestDiffList diffs={diffs} />

      <p className="text-body-sm text-ink-2">
        <span className="text-eyebrow text-ink-3">Reason </span>
        {request.reason}
      </p>

      {request.status !== 'pending' && request.decision_reason ? (
        <p className="text-body-sm text-ink-2">
          <span className="text-eyebrow text-ink-3">Decision reason </span>
          {request.decision_reason}
        </p>
      ) : null}

      {actions}
    </div>
  );
}

// ---------------------------------------------------------------------
// Bulk: a whole batch of proposed changes, decided as one thing
// ---------------------------------------------------------------------

/**
 * One task's worth of a batch, prepared by the caller. The rows are
 * computed outside this component (routes/briefing.tsx owns the catalog
 * and roster lookups the diff needs) so this file stays a renderer —
 * exactly why `EditRequestCard` above takes `diffs` rather than a
 * request and a pile of resolvers.
 */
export interface BatchDiffRow {
  requestId: string;
  taskTitle: React.ReactNode;
  diffs: FieldDiff[];
  /**
   * Why this row can no longer be applied (its task was cleared or
   * cancelled underneath the batch, or has left the week). Rendered, never
   * hidden: an approver deciding a batch has to know one of its items is
   * dead, because `ops.decide_edit_batch` is all-or-nothing and will
   * refuse the lot.
   */
  blockedReason?: string | null;
  /** Fields whose current value moved since the batch was raised. */
  staleNote?: string | null;
}

/**
 * Chan: "then approve by admin or founder showing what changed like
 * before and after". A batch is many tasks and many fields decided in
 * one act, so it renders as one card carrying the provenance (who asked,
 * when, and their one reason) over a before -> after list per task —
 * reusing `EditRequestDiffList`, the same renderer a single request and a
 * GM's unsubmitted draft both go through. There is exactly one
 * before/after renderer in this app and this is it.
 */
export function EditBatchCard({
  batch,
  rows,
  actions,
  note,
}: {
  batch: TaskEditBatch;
  rows: BatchDiffRow[];
  actions?: React.ReactNode;
  /** A refusal sentence for someone who may read this batch but not decide it. */
  note?: React.ReactNode;
}) {
  const fieldCount = rows.reduce((n, r) => n + r.diffs.length, 0);
  return (
    <div className="flex flex-col gap-3 border-b border-hairline px-4 py-4 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-body font-medium text-ink">
            {fieldCount} {fieldCount === 1 ? 'change' : 'changes'} across {rows.length}{' '}
            {rows.length === 1 ? 'task' : 'tasks'}
          </span>
          <EditRequestStatusChip status={batch.status} />
        </div>
        <span className="shrink-0 text-body-sm text-ink-3">
          {batch.requestedByName ?? 'unknown'} ·{' '}
          {batch.requested_at ? new Date(batch.requested_at).toLocaleString() : 'unknown time'}
        </span>
      </div>

      <p className="max-w-prose text-body text-ink-2">
        <span className="text-eyebrow text-ink-3">Reason </span>
        {batch.reason}
      </p>

      {rows.length === 0 ? (
        // A batch with nothing in it is not an empty card. Lane A refuses
        // to create one; if one ever renders, say so rather than offering
        // an Approve button over blank space.
        <p className="rounded-lg border border-danger-border bg-danger-wash px-3 py-2 text-body text-danger">
          This batch carries no readable changes. Don't decide it — tell whoever raised it.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <div key={row.requestId} className="rounded-lg border border-hairline bg-surface-2 p-3">
              <p className="mb-2 min-w-0 truncate text-body font-medium text-ink">{row.taskTitle}</p>
              <EditRequestDiffList diffs={row.diffs} />
              {row.blockedReason ? (
                <p className="mt-2 flex items-start gap-1.5 text-body-sm text-danger">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {row.blockedReason}
                </p>
              ) : null}
              {row.staleNote ? (
                <p className="mt-2 flex items-start gap-1.5 text-body-sm text-pending">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {row.staleNote}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {batch.status !== 'pending' && batch.decision_reason ? (
        <p className="text-body text-ink-2">
          <span className="text-eyebrow text-ink-3">Decision reason </span>
          {batch.decision_reason}
        </p>
      ) : null}

      {note}
      {actions}
    </div>
  );
}
