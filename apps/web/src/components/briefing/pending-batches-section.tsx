/**
 * LRA Global Ops :: pending edit batches — the founder's/admin's decision surface
 *
 * Chan: "then approve by admin or founder showing what changed like
 * before and after". This is that screen, on the briefing itself, because
 * the record being changed is the briefing's record — an approver should
 * be able to read the proposed change next to the week it belongs to
 * rather than in a separate queue.
 *
 * Approve applies the whole batch (`ops.decide_edit_batch` is
 * all-or-nothing — the per-row apply trigger does the work, so there is
 * exactly one apply path and it is the proven one). Reject needs a
 * written reason of at least 10 characters, the same as every other
 * refusal in this app. Who asked, when, and their reason are always on
 * the card.
 *
 * Everyone in ops may READ a pending batch — the same "everyone is in the
 * loop" rule the single-request table already uses, and the reason the
 * requesting GM sees their own submitted batch here rather than having to
 * take it on trust. Only a founder or admin who is not read-only and did
 * not raise it gets the controls, and everybody else gets the sentence
 * saying why (`batchDecisionRefusal`, the tested mirror of the policy).
 */
import * as React from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ReasonTextarea } from '@/components/ui/reason-textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { EditBatchCard, type BatchDiffRow } from '@/components/tasks/edit-request-diff';
import { api, ApiClientError } from '@/lib/api';
import { useResource } from '@/lib/use-resource';
import { buildFieldDiffs, type DiffResolvers } from '@/lib/task-edit-requests';
import {
  SUGGESTION_FIELD_LABEL,
  batchDecisionRefusal,
  normalizeBatch,
  statusUnavailableReason,
  type SuggestionField,
  type TaskEditBatch,
  type TaskEditBatchItem,
} from '@/lib/edit-suggestions';
import type { Actor } from '@/lib/task-permissions';
import type { BriefingTask } from './task-definition-row';

/**
 * Said in one place because it is said twice — on the banner and on the
 * disabled Approve — and the two must not drift.
 */
const BLOCKED_BATCH_SENTENCE =
  'One of these tasks can no longer take a change, and a batch applies all-or-nothing — the database refuses ' +
  'the whole thing. It cannot be approved until whoever raised it withdraws it and re-raises the rest; ' +
  'rejecting it with a reason does the same job from this side.';

export function PendingBatchesSection({
  actor,
  tasksById,
  resolve,
  onDecided,
}: {
  actor: Actor | null;
  tasksById: Map<string, BriefingTask>;
  resolve: DiffResolvers;
  /** The tasks on this screen changed — reload them. */
  onDecided: () => void;
}) {
  const resource = useResource(
    (signal) => api.get<unknown[]>('/api/task-edit-batches?status=pending', { signal }),
    []
  );
  const [rejecting, setRejecting] = React.useState<TaskEditBatch | null>(null);
  const [withdrawing, setWithdrawing] = React.useState<TaskEditBatch | null>(null);
  const [working, setWorking] = React.useState<string | null>(null);

  async function approve(batch: TaskEditBatch) {
    setWorking(batch.id);
    try {
      // An explicit empty object, not a bodyless POST: `lib/api.ts` only
      // sends `Content-Type: application/json` when there IS a body, but
      // this route has nothing to say and an empty object is the honest
      // way to say it (PLAN.md §11.1's content-type defect).
      await api.post(`/api/task-edit-batches/${batch.id}/approve`, {});
      toast.success('Every change in that batch is applied.');
      resource.reload();
      onDecided();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not approve this batch');
    } finally {
      setWorking(null);
    }
  }

  async function withdraw(batch: TaskEditBatch) {
    setWorking(batch.id);
    try {
      await api.post(`/api/task-edit-batches/${batch.id}/withdraw`, {});
      toast.success('Withdrawn. Nothing changed — you can suggest again.');
      setWithdrawing(null);
      resource.reload();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not withdraw this batch');
    } finally {
      setWorking(null);
    }
  }

  return (
    <section>
      <h2 className="mb-3 text-title-lg text-ink">Suggested edits — waiting on a decision</h2>
      <ResourceView resource={resource} skeleton={<SkeletonRows rows={2} height={80} />}>
        {(raw) => {
          const batches = (raw ?? []).map(normalizeBatch).filter((b): b is TaskEditBatch => b !== null);
          if (batches.length === 0) {
            return (
              <p className="rounded-xl border border-hairline bg-surface px-4 py-3 text-body text-ink-3">
                <CheckCircle2 className="mr-1.5 inline size-4" aria-hidden />
                Nothing waiting. Suggested edits to this week's committed work appear here.
              </p>
            );
          }
          return (
            <div className="overflow-hidden rounded-xl border border-pending-border bg-surface">
              {batches.map((batch) => {
                const refusal = batchDecisionRefusal(
                  { requested_by: batch.requested_by, status: batch.status, itemCount: batch.itemCount },
                  actor
                );
                const rows = batch.items.map((item) => toRow(item, tasksById, resolve));
                // The server's own answer, not a client re-derivation:
                // `hasUnapplicableItem` is computed from the task rows the
                // API can see, which is a superset of this screen's list.
                const anyDead = batch.hasUnapplicableItem || rows.some((r) => r.blockedReason);
                return (
                  <EditBatchCard
                    key={batch.id}
                    batch={batch}
                    rows={rows}
                    note={
                      refusal ? (
                        <p className="rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-body-sm text-ink-3">
                          {refusal}
                        </p>
                      ) : anyDead ? (
                        <p className="rounded-lg border border-danger-border bg-danger-wash px-3 py-2 text-body-sm text-danger">
                          {BLOCKED_BATCH_SENTENCE}
                        </p>
                      ) : null
                    }
                    actions={
                      <div className="flex flex-wrap items-center gap-2">
                        {refusal === null ? (
                          <>
                            {/*
                              A batch carrying an unapplicable item is
                              refused WHOLESALE by ops.decide_edit_batch,
                              and the API tells us so before the click
                              (`hasUnapplicableItem`). So Approve is
                              disabled with that reason rather than
                              offered and then refused — this is the
                              server's own answer, not a client-side
                              guess at a policy, which is the only case
                              where a pre-emptive refusal is honest.
                            */}
                            <Button
                              variant="clear"
                              size="sm"
                              loading={working === batch.id}
                              disabled={anyDead}
                              title={anyDead ? BLOCKED_BATCH_SENTENCE : undefined}
                              onClick={() => approve(batch)}
                            >
                              <CheckCircle2 className="size-3.5" aria-hidden />
                              Approve all {rows.reduce((n, r) => n + r.diffs.length, 0)} changes
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={working === batch.id}
                              onClick={() => setRejecting(batch)}
                            >
                              Reject
                            </Button>
                          </>
                        ) : null}
                        {/*
                          The requester's own way out. A batch's items
                          cannot be withdrawn one at a time — all-or-
                          nothing cuts both ways — so without this a
                          submitted suggestion is a dead end for the
                          person who raised it, and a blocked batch could
                          never be cleared without an approver rejecting
                          it.
                        */}
                        {actor && batch.requested_by === actor.id && batch.status === 'pending' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={working === batch.id}
                            onClick={() => setWithdrawing(batch)}
                          >
                            <Undo2 className="size-3.5" aria-hidden />
                            Withdraw
                          </Button>
                        ) : null}
                      </div>
                    }
                  />
                );
              })}
            </div>
          );
        }}
      </ResourceView>

      {withdrawing ? (
        <Dialog open onOpenChange={(v) => !v && setWithdrawing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Withdraw these suggested edits?</DialogTitle>
            </DialogHeader>
            <p className="text-body text-ink-2">
              Nothing has been applied, and nothing will be. The batch stops waiting on a decision and you can
              suggest again — including with the unapplicable tasks left out.
            </p>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setWithdrawing(null)}>
                Keep it waiting
              </Button>
              <Button
                variant="destructive"
                loading={working === withdrawing.id}
                onClick={() => withdraw(withdrawing)}
              >
                Withdraw the batch
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {rejecting ? (
        <RejectBatchDialog
          batch={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => {
            setRejecting(null);
            resource.reload();
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * One child request as a diff row. `buildFieldDiffs` is the same function
 * the single-request queue and a requester's own history use — the child
 * IS an `ops.task_edit_requests` row, so nothing about the diff changes
 * just because it arrived inside a batch.
 */
function toRow(
  item: TaskEditBatchItem,
  tasksById: Map<string, BriefingTask>,
  resolve: DiffResolvers
): BatchDiffRow {
  // The title and the task's status come from the API's own join
  // (`AssembledItem`), not from this screen's list: a batch can carry a
  // task that is not on this week's committed list at all, and the server
  // is the only side that can see it. `tasksById` is used for exactly one
  // thing below — comparing the snapshot against the task's CURRENT
  // definition, which needs the full row and is therefore only possible
  // for a task this screen already loaded.
  const task = tasksById.get(item.task_id);
  const diffs = buildFieldDiffs(item, resolve);
  // "Before" on the card is the value snapshotted when the request was
  // raised (`before_values`, server-side, never client-supplied). If the
  // task has moved since, say so — the approver is about to overwrite
  // something they were not shown.
  const moved = task
    ? diffs
        .filter((d) => {
          const snapshot = item.before_values?.[d.key];
          const now = currentOf(task, d.key as SuggestionField);
          return String(snapshot ?? '') !== String(now ?? '');
        })
        .map((d) => SUGGESTION_FIELD_LABEL[d.key as SuggestionField])
    : [];
  return {
    requestId: item.id,
    taskTitle: item.taskTitle ?? task?.title ?? 'This task is no longer visible',
    diffs,
    blockedReason: statusUnavailableReason(item.taskStatus ?? task?.status ?? null),
    staleNote:
      moved.length > 0
        ? `${moved.join(', ')} changed on the task after this was suggested — approving replaces the task's current value, not the one shown as "before".`
        : null,
  };
}

function currentOf(task: BriefingTask, field: SuggestionField): string | null {
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
    default:
      return null;
  }
}

function RejectBatchDialog({
  batch,
  onClose,
  onDone,
}: {
  batch: TaskEditBatch;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/task-edit-batches/${batch.id}/reject`, { reason: reason.trim() });
      toast.success('Batch rejected. Nothing changed.');
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not reject this batch');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject these suggested edits?</DialogTitle>
        </DialogHeader>
        <p className="text-body text-ink-2">
          Every task in this batch stays exactly as it is. {batch.requestedByName ?? 'The requester'} sees this
          reason.
        </p>
        <ReasonTextarea value={reason} onChange={setReason} placeholder="Why isn't this batch happening?" />
        {error ? (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={submitting}
            disabled={reason.trim().length < 10}
            onClick={submit}
          >
            Reject the batch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
