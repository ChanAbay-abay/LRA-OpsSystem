/**
 * LRA Global Ops :: "This week's committed work" — the editable Monday record
 *
 * Chan, 2026-09-10: "make sure for the monday briefing one the admin and
 * founder be able to edit stuff. GM can send a request to edit (should be
 * done by bulk like an edit feature on google docs), then approve by
 * admin or founder showing what changed like before and after".
 *
 * PLAN.md §10.1 is the constraint this screen has to respect: the lock is
 * on a task's *definition*, never on its progress, and the record of what
 * was promised on Monday is precisely the thing this system exists to
 * make un-rewritable. So the only two ways to change it are the two Chan
 * named — a founder/admin editing directly, and a GM's proposal that
 * someone else decides — and this section is where both live.
 *
 * "Like an edit feature on google docs" is a specification, and each
 * thing it implies is a real behaviour here:
 *
 *   a mode you turn ON .................. the "Suggest edits" toggle
 *   nothing written until you submit .... the draft is local state only
 *                                         (lib/edit-suggestions.ts)
 *   many edits held at once ............. keyed by task, any number
 *   each change marked, original legible  per-field pending rail + "was …"
 *   a running count ..................... the bar, live
 *   discard one, or all ................. per field, per task, and all
 *   ONE submit for the batch ............ SubmitSuggestionsDialog, one POST
 *   leaving warns, never silently loses   useLeaveGuard + a session mirror
 */
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquarePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TaskEditRequestDialog } from '@/components/tasks/task-edit-request-dialog';
import { cn } from '@/lib/utils';
import {
  discardAll,
  discardField,
  discardTask,
  proposeChange,
  suggestedTaskCount,
  suggestionCount,
  suggestionRefusal,
  type SuggestionField,
  type SuggestionResolvers,
} from '@/lib/edit-suggestions';
import { definitionLockRefusal, type Actor } from '@/lib/task-permissions';
import { SubmitSuggestionsDialog } from './submit-suggestions-dialog';
import { TaskDefinitionRow, type BriefingMember, type BriefingTask, type BriefingTaskType } from './task-definition-row';
import { useLeaveGuard, useSuggestionDraft } from './use-suggestion-draft';

export function CommittedWorkSection({
  weekId,
  weekState,
  actor,
  tasks,
  types,
  members,
  resolve,
  onChanged,
}: {
  weekId: string | undefined;
  weekState: string | null | undefined;
  actor: Actor | null;
  /** This week's committed tasks, definition fields and all. */
  tasks: BriefingTask[];
  types: BriefingTaskType[];
  members: BriefingMember[];
  resolve: SuggestionResolvers;
  onChanged: () => void;
}) {
  const { draft, update, clear, restored, dirty } = useSuggestionDraft(weekId);
  // Mode is derived, not synced: a draft that exists (including one
  // restored from this tab's session) IS suggestion mode, and `modeOn`
  // only records turning it on with nothing suggested yet. Deriving keeps
  // the two from ever disagreeing.
  const [modeOn, setModeOn] = React.useState(false);
  const [reviewing, setReviewing] = React.useState(false);
  const [directTask, setDirectTask] = React.useState<BriefingTask | null>(null);
  const [leavingTo, setLeavingTo] = React.useState<string | null>(null);
  const navigate = useNavigate();

  const suggesting = modeOn || dirty;

  useLeaveGuard(dirty, (href) => setLeavingTo(href));

  const maySuggest = suggestionRefusal(actor);
  const isOversight =
    actor?.authority === 'gm' || actor?.authority === 'founder' || actor?.authority === 'admin';

  /**
   * Why this person cannot edit this task's definition outright, or null.
   * `definitionLockRefusal` is the tested mirror of
   * `ops.enforce_task_transition`'s guard 2b and is NOT reimplemented
   * here — the only thing added is the trigger's own statement 0, which
   * refuses a read-only account before any guard is evaluated and is
   * therefore the honest sentence to show ERC/DCA rather than the lock's
   * "ask the GM to raise a task edit request".
   */
  function directRefusalFor(task: BriefingTask): string | null {
    if (!actor) return 'You are not signed in.';
    if (actor.readOnly) return 'Your account is read-only.';
    const lock = definitionLockRefusal({ is_committed: task.is_committed }, weekState, actor);
    // The trigger's own sentence ends "ask the GM to raise a task edit
    // request", which is nonsense when the GM is the person reading it.
    // Same refusal, different instruction: point them at the control they
    // actually have. Everyone else keeps the database's wording.
    if (lock && maySuggest === null) {
      return 'This task\u2019s definition is locked for the week. Use \u201cSuggest edits\u201d to propose a change for a founder or admin to approve.';
    }
    return lock;
  }

  // The toggle only appears for someone the *database* would refuse a
  // direct edit and accept a suggestion from — in practice the GM, once
  // the week has left planning. A founder or admin never sees it because
  // they can simply edit; offering them a proposal flow to themselves
  // would be a control with no purpose.
  const lockedForMe = tasks.some((t) => directRefusalFor(t) !== null);
  const showSuggestToggle = maySuggest === null && lockedForMe;

  const count = suggestionCount(draft);
  const taskCount = suggestedTaskCount(draft);
  const tasksById = React.useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  function propose(task: BriefingTask, field: SuggestionField, value: string | null) {
    update(proposeChange(draft, task, field, value));
  }

  const ordered = React.useMemo(
    () =>
      [...tasks].sort((a, b) => {
        const an = members.find((m) => m.userId === a.owner_user_id)?.name ?? '';
        const bn = members.find((m) => m.userId === b.owner_user_id)?.name ?? '';
        return an.localeCompare(bn) || a.title.localeCompare(b.title);
      }),
    [tasks, members]
  );

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-title-lg text-ink">This week's committed work</h2>
        {showSuggestToggle ? (
          suggesting ? (
            <Button variant="secondary" onClick={() => (dirty ? setReviewing(true) : setModeOn(false))}>
              {dirty ? 'Review and submit' : 'Leave suggestion mode'}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setModeOn(true)} aria-pressed={false}>
              <MessageSquarePlus className="size-4" aria-hidden />
              Suggest edits
            </Button>
          )
        ) : null}
      </div>

      {!isOversight ? (
        <p className="mb-3 text-body text-ink-3">
          This is the record set at the briefing. Only a GM, founder or admin can change what it says; your
          progress on these tasks is never locked.
        </p>
      ) : null}

      {suggesting ? (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-pending-border bg-pending-wash px-4 py-3">
          <span className="text-body text-ink">
            <strong className="font-semibold">Suggesting edits.</strong> Nothing is written until you submit.
          </span>
          <span
            className={cn('num text-num-sm', count > 0 ? 'text-pending' : 'text-ink-3')}
            aria-live="polite"
          >
            {count} {count === 1 ? 'suggestion' : 'suggestions'}
            {taskCount > 0 ? ` on ${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}` : ''}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {count > 0 ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => update(discardAll())}>
                  <X className="size-3.5" aria-hidden />
                  Discard all
                </Button>
                <Button size="sm" onClick={() => setReviewing(true)}>
                  Review and submit
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setModeOn(false)}>
                Done
              </Button>
            )}
          </div>
          {restored ? (
            <p className="basis-full text-body-sm text-ink-2">
              These suggestions were still open from earlier in this tab — nothing was submitted.
            </p>
          ) : null}
        </div>
      ) : null}

      {ordered.length === 0 ? (
        <p className="rounded-xl border border-hairline bg-surface px-4 py-3 text-body text-ink-3">
          Nothing is committed to this week yet. Commit work below and it appears here.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
          {ordered.map((task) => (
            <TaskDefinitionRow
              key={task.id}
              task={task}
              types={types}
              members={members}
              suggestions={draft[task.id]}
              suggesting={suggesting}
              onPropose={propose}
              onDiscardField={(taskId, field) => update(discardField(draft, taskId, field))}
              onDiscardTask={(taskId) => update(discardTask(draft, taskId))}
              showDirectEdit={Boolean(isOversight)}
              directEditRefusal={directRefusalFor(task)}
              onDirectEdit={setDirectTask}
            />
          ))}
        </div>
      )}

      {reviewing ? (
        <SubmitSuggestionsDialog
          draft={draft}
          tasksById={tasksById}
          resolve={resolve}
          onClose={() => setReviewing(false)}
          onSubmitted={() => {
            setReviewing(false);
            setModeOn(false);
            clear();
            onChanged();
          }}
        />
      ) : null}

      {directTask ? (
        <TaskEditRequestDialog
          task={{
            id: directTask.id,
            title: directTask.title,
            description: directTask.description,
            task_type_id: directTask.task_type_id,
            owner_user_id: directTask.owner_user_id,
            client_ref: directTask.client_ref,
          }}
          direct
          onClose={() => setDirectTask(null)}
          onCreated={() => {
            // No toast here: the dialog raises its own on success, and
            // two toasts for one act reads like it happened twice.
            onChanged();
          }}
        />
      ) : null}

      {leavingTo ? (
        <LeaveWithDraftDialog
          count={count}
          onStay={() => setLeavingTo(null)}
          onLeave={() => {
            const href = leavingTo;
            setLeavingTo(null);
            // Deliberately does NOT clear the draft: the suggestions stay
            // in this tab's session, so coming back finds them. A warning
            // is for attention, not a shredder.
            navigate(href);
          }}
        />
      ) : null}
    </section>
  );
}

function LeaveWithDraftDialog({
  count,
  onStay,
  onLeave,
}: {
  count: number;
  onStay: () => void;
  onLeave: () => void;
}) {
  return (
    <Dialog open onOpenChange={(v) => !v && onStay()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            You have {count} unsubmitted {count === 1 ? 'suggestion' : 'suggestions'}
          </DialogTitle>
        </DialogHeader>
        <p className="text-body text-ink-2">
          Nothing has been sent yet. Leaving now does not submit them — they stay in this tab until you submit
          or discard them, but nobody else can see them.
        </p>
        <DialogFooter>
          <Button variant="secondary" onClick={onStay}>
            Stay and submit
          </Button>
          <Button variant="destructive" onClick={onLeave}>
            Leave anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
