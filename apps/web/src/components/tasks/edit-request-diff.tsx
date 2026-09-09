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
 */
import * as React from 'react';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EditRequestStatus, FieldDiff, TaskEditRequest } from '@/lib/task-edit-requests';

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
