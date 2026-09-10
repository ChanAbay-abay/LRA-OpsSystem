/**
 * LRA Global Ops :: "Submit suggestions" — one review, one reason, one POST
 *
 * The single submit at the end of a Google-Docs-style suggestion session.
 * Everything the GM changed across the whole screen is reviewed here, in
 * the same before -> after renderer the approver will read it in
 * (`EditRequestDiffList`) — deliberately, so nobody discovers at approval
 * time that the diff says something other than what they thought they
 * typed.
 *
 * One reason covers the batch (`ops.task_edit_batches.reason`, ≥10 chars,
 * the same accountability minimum every other reason field in this app
 * carries — DESIGN.md §5.2). One `POST /api/task-edit-batches` creates
 * the batch and its children in a single call, which is what makes
 * `ops.decide_edit_batch`'s all-or-nothing approval possible: a batch
 * assembled by N separate POSTs could be half-created before the first
 * failure, and a half-created batch is the "side effect half-happened
 * behind a 200" defect this project has hit three times (PLAN.md §12.7).
 */
import * as React from 'react';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ReasonTextarea, REASON_MIN_LENGTH } from '@/components/ui/reason-textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EditRequestDiffList } from '@/components/tasks/edit-request-diff';
import { api, ApiClientError } from '@/lib/api';
import {
  buildSuggestionDiffs,
  staleFields,
  suggestionCount,
  suggestionProblems,
  toBatchItems,
  unavailableReason,
  SUGGESTION_FIELD_LABEL,
  type SuggestionResolvers,
  type SuggestionState,
} from '@/lib/edit-suggestions';
import type { BriefingTask } from './task-definition-row';

export function SubmitSuggestionsDialog({
  draft,
  tasksById,
  resolve,
  onClose,
  onSubmitted,
}: {
  draft: SuggestionState;
  tasksById: Map<string, BriefingTask>;
  resolve: SuggestionResolvers;
  onClose: () => void;
  /** Called after the batch is created, so the caller can clear the draft and reload. */
  onSubmitted: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const entries = Object.entries(draft);
  const total = suggestionCount(draft);

  // A task that went cleared/cancelled or left the week while the draft
  // was open cannot take an edit request at all
  // (`ops.enforce_task_edit_request_insert` refuses it), and because the
  // whole batch is created in one call its presence would fail the lot.
  // Named here, with the offending row, instead of letting the POST come
  // back with one refusal for five tasks.
  const dead = entries
    .map(([taskId]) => ({ taskId, reason: unavailableReason(tasksById.get(taskId)) }))
    .filter((x) => x.reason !== null);

  // A title or an owner proposed empty would be refused by
  // `changesSchema` for the WHOLE batch — named here, before the round
  // trip, instead of arriving as one 400 over five good suggestions.
  const problems = suggestionProblems(draft);

  const canSubmit =
    reason.trim().length >= REASON_MIN_LENGTH &&
    total > 0 &&
    dead.length === 0 &&
    problems.length === 0 &&
    !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/task-edit-batches', {
        reason: reason.trim(),
        items: toBatchItems(draft),
      });
      toast.success(
        `${total} ${total === 1 ? 'suggestion' : 'suggestions'} sent — a founder or admin decides the whole batch.`
      );
      onSubmitted();
    } catch (err) {
      // The server's own sentence, verbatim (PRD §6.1 / DESIGN §8) —
      // never a swallowed generic.
      setError(err instanceof ApiClientError ? err.message : 'Could not send these suggestions');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      {/* `md:`-gated so the mobile sheet in `ui/dialog.tsx` is not overridden.
          Unconditional width/height/overflow here is what kept this one dialog
          a centred box at 375px while every other became full-bleed. */}
      <DialogContent className="md:max-h-[85vh] md:w-[min(680px,94vw)] md:max-w-none md:overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="pr-6">
            Submit {total} {total === 1 ? 'suggestion' : 'suggestions'} on {entries.length}{' '}
            {entries.length === 1 ? 'task' : 'tasks'}
          </DialogTitle>
        </DialogHeader>

        <p className="text-body text-ink-2">
          Nothing has changed yet. These go to a founder or admin as{' '}
          <strong className="text-ink">one request</strong> — they approve or reject the whole batch, and only
          then does anything move.
        </p>

        <div className="flex flex-col gap-3">
          {entries.map(([taskId, forTask]) => {
            const task = tasksById.get(taskId);
            const missing = unavailableReason(task);
            const stale = task ? staleFields(forTask, task) : [];
            return (
              <div key={taskId} className="rounded-lg border border-hairline bg-surface-2 p-3">
                <p className="mb-2 text-body font-medium text-ink">{task?.title ?? 'This task is gone'}</p>
                <EditRequestDiffList diffs={buildSuggestionDiffs(forTask, resolve)} />
                {missing ? (
                  <p className="mt-2 flex items-start gap-1.5 text-body-sm text-danger">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {missing} Discard these suggestions to submit the rest.
                  </p>
                ) : null}
                {problems
                  .filter((pr) => pr.taskId === taskId)
                  .map((pr) => (
                    <p key={pr.field} className="mt-2 flex items-start gap-1.5 text-body-sm text-danger">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {pr.message}
                    </p>
                  ))}
                {stale.length > 0 ? (
                  <p className="mt-2 flex items-start gap-1.5 text-body-sm text-pending">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {stale.map((f) => SUGGESTION_FIELD_LABEL[f]).join(', ')} changed on the task after you
                    suggested — the "before" the approver sees is the task's value now, not the one you edited
                    against.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="batch-reason">Reason for the whole batch</Label>
          <ReasonTextarea
            id="batch-reason"
            value={reason}
            onChange={setReason}
            placeholder="e.g. Points were set before we knew the container count"
          />
        </div>

        {error ? (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Keep editing
          </Button>
          <Button loading={submitting} disabled={!canSubmit} onClick={submit}>
            Send {total} {total === 1 ? 'suggestion' : 'suggestions'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
