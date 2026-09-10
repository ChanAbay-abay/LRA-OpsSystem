/**
 * LRA Global Ops :: the task detail modal and its satellite dialogs
 *
 * Moved out of `routes/board.tsx` on 2026-09-10, unchanged in behaviour,
 * because Chan asked for a second consumer: "now page tasks should be
 * interactable" — every task on Now opens this exact modal rather than
 * a second, thinner one. The board still owns its own drag ladder,
 * cards and columns; this file owns the one place where notes, blocks,
 * resolve, submit/take-back, edit requests and the definition lock
 * live.
 *
 * Nothing here writes a status the board could not: moving a task goes
 * through the same `POST /api/tasks/:id/status` and the same
 * `moveRefusal` mirror the board's drop uses. Adding a second, subtly
 * different move surface is exactly how two paths drift.
 */
import * as React from 'react';
import { Ban, Lock, Pencil, RotateCcw, XOctagon } from 'lucide-react';
import { toast } from 'sonner';
import { TaskEditRequestDialog } from '@/components/tasks/task-edit-request-dialog';
import { EditRequestCard } from '@/components/tasks/edit-request-diff';
import { ReasonTextarea } from '@/components/ui/reason-textarea';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { ErrorPanel, UnreachablePanel } from '@/components/ui/resource-state';
import { useResource, type ResourceStatus } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { taskStatusLabel, taskStatusTransition } from '@/lib/labels';
import { fmtDateTime, fmtTime } from '@/lib/dates';
import { Hint } from '@/components/ui/hint';
import {
  COLUMN_STATUS,
  blockResolveRefusal,
  definitionLockRefusal,
  moveRefusal,
  noteRefusal,
  type Actor,
  type BoardColumn,
  type MovableTask,
} from '@/lib/task-permissions';
import {
  blockRelation,
  blockRelationLabel,
  blockSubmitRefusal,
  initials,
  statusTone,
  type BlockDraft,
  type Note,
  type Task,
  type TaskBlock,
} from '@/lib/task-types';
import { buildFieldDiffs, type DiffResolvers, type TaskEditRequest } from '@/lib/task-edit-requests';

/**
 * One chip geometry for the whole detail header.
 *
 * The row used to mix `text-micro` (line-height 1.30) with `text-num-xs`
 * (1.20) and one chip carried a 12px icon, so four chips sitting on the
 * same line rendered at three different heights with their text off a
 * shared baseline. Height is fixed here and the type is set `leading-none`
 * so the line-height token can never drive the box again; tone is the
 * only thing a caller varies.
 */
function Chip({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: 'neutral' | 'pending' | 'cleared' | 'danger' | 'info';
  className?: string;
  children: React.ReactNode;
}) {
  const tones = {
    neutral: 'border-hairline bg-surface-2 text-ink-2',
    pending: 'border-pending-border bg-pending-wash text-pending',
    cleared: 'border-cleared-border bg-cleared-wash text-cleared',
    danger: 'border-danger-border bg-danger-wash text-danger',
    info: 'border-info-border bg-info-wash text-info',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-xs border px-2',
        'text-micro font-medium leading-none',
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  return <Chip tone={statusTone(status)}>{taskStatusLabel(status)}</Chip>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-eyebrow text-ink-3">{label}</p>
      <div className="mt-0.5 text-body-sm text-ink">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------
// History — GET /api/tasks/:id/history. Chan: "each task should have
// updates on when it was created, etc so when they open a task, it
// shows when a task was made."
//
// Every timestamp here is data that already existed (`ops.tasks.
// created_at`/`first_in_progress_at`, `ops.point_ledger`'s transition
// rows, `core.audit_logs`' admin-correction rows) — this section adds
// no new column and no new write path, only a read and a render.
// ---------------------------------------------------------------------

interface HistoryLedgerRow {
  id: string;
  from_status: string;
  to_status: string;
  state: string;
  points: number;
  created_at: string;
  actor_id: string | null;
  actorName: string | null;
  reason: string | null;
}

interface HistoryAuditRow {
  id: string;
  action: string;
  created_at: string;
  actor_id: string | null;
  actorName: string | null;
  actor_email: string | null;
}

interface TaskHistory {
  ledger: HistoryLedgerRow[];
  auditLogs: HistoryAuditRow[];
}

interface TimelineEntry {
  key: string;
  at: string;
  label: string;
  actorName?: string | null;
  reason?: string | null;
}

/**
 * The two admin-audit actions this task can carry
 * (`20260910240000_ops_admin_corrections.sql`,
 * `20260910170000_audit_direct_edits_and_closed_week_guard.sql`), spoken
 * in a sentence rather than the raw `module.entity.verb` action string
 * `/admin/audit` renders as-is. Not moved to `lib/labels.ts`: that file
 * models database ENUMs (§17), and an audit `action` is a free-text
 * column, not one — an unrecognised value still renders as itself,
 * never blank, same rule as `labels.ts`'s own fallback.
 */
function auditActionLabel(action: string): string {
  switch (action) {
    case 'ops.task.admin_corrected':
      return 'Corrected by an admin';
    case 'ops.task.definition_edited_directly':
      return 'Definition edited directly';
    default:
      return action;
  }
}

/**
 * Created → started → every ledger transition → every admin correction,
 * oldest first. `first_in_progress_at` is only added when it exists — a
 * task nobody has picked up yet has no "Started" line, which is itself
 * the honest state rather than a guessed one.
 */
function buildTimeline(task: Task, history: TaskHistory | null): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ key: 'created', at: task.created_at, label: 'Created' }];
  if (task.first_in_progress_at) {
    entries.push({ key: 'started', at: task.first_in_progress_at, label: 'Started' });
  }
  for (const row of history?.ledger ?? []) {
    entries.push({
      key: `ledger-${row.id}`,
      at: row.created_at,
      label: taskStatusTransition(row.from_status, row.to_status),
      actorName: row.actorName,
      reason: row.reason,
    });
  }
  for (const row of history?.auditLogs ?? []) {
    entries.push({
      key: `audit-${row.id}`,
      at: row.created_at,
      label: auditActionLabel(row.action),
      actorName: row.actorName ?? row.actor_email,
    });
  }
  return entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function HistorySection({ task }: { task: Task }) {
  const [history, setHistory] = React.useState<TaskHistory | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(() => {
    api
      .get<TaskHistory>(`/api/tasks/${task.id}/history`)
      .then((data) => {
        setHistory(data);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [task.id]);

  React.useEffect(() => load(), [load]);

  const entries = React.useMemo(() => buildTimeline(task, history), [task, history]);

  return (
    <div>
      <p className="mb-1 text-eyebrow text-ink-3">History</p>
      {failed ? (
        <ErrorPanel message="This task's history could not be loaded." onRetry={load} />
      ) : (
        <ul
          className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-lg border border-hairline bg-surface-2 p-3"
          aria-busy={history == null}
        >
          {entries.map((e) => (
            <li key={e.key} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-body-sm text-ink">
                  {e.label}
                  {e.actorName ? <span className="text-ink-3"> — {e.actorName}</span> : null}
                </p>
                {e.reason ? <p className="break-words text-micro text-ink-3">{e.reason}</p> : null}
              </div>
              <Hint text={fmtDateTime(e.at)}>
                <span className="num shrink-0 text-num-xs text-ink-3">{fmtTime(e.at)}</span>
              </Hint>
            </li>
          ))}
          {/* Ledger/audit rows are still loading (Created/Started already
              render from the task itself, never blank) — two skeleton
              bars at the row's own geometry, DESIGN.md §8. */}
          {history == null ? (
            <>
              <div className="skeleton-pulse h-3 w-3/5 rounded-xs bg-surface-3" aria-hidden />
              <div className="skeleton-pulse h-3 w-2/5 rounded-xs bg-surface-3" style={{ animationDelay: '80ms' }} aria-hidden />
            </>
          ) : null}
        </ul>
      )}
    </div>
  );
}

/**
 * Chan's ask: "each task has a modal card that opens bigger when you
 * click it showing more detail of the actual task and the notes history
 * etc." One dialog, three things in it — what the task IS (the fields
 * the card has no room for), why it is stuck (its blocks, with the
 * resolve action for whoever is allowed to resolve them), and what has
 * been said about it (the append-only worklog, newest work at the
 * bottom, with the composer under it).
 *
 * Nothing here writes a status: moving a task stays on the board and in
 * Approvals, where the ladder is already enforced end to end. Adding a
 * second, subtly different move surface is exactly how two paths drift.
 */
export function TaskDetailDialog({
  task,
  weekState,
  onClose,
  onChanged,
  onFlagCancellation,
  onDeclareBlock,
}: {
  task: Task;
  /** The task's own week's `state` (`ops.weeks.state`) — null when the week isn't in the recent set `BoardPage` fetched. */
  weekState?: string | null;
  onClose: () => void;
  onChanged: () => void;
  onFlagCancellation?: (task: Task) => void;
  onDeclareBlock: (task: Task) => void;
}) {
  const { me } = useAuth();
  const [notes, setNotes] = React.useState<Note[] | null>(null);
  const [blocks, setBlocks] = React.useState<TaskBlock[] | null>(null);
  const [body, setBody] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [moving, setMoving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const closed = task.status === 'cleared' || task.status === 'cancelled';
  const readOnly = me?.readOnly ?? false;
  // Why this person cannot add a worklog note, or null if they can —
  // the mirror of `ops.enforce_task_note_insert`, which gates on the
  // task's owner or oversight and not merely on closed/read-only.
  const noteBlocked = noteRefusal(task, me as Actor | null);
  // Resolve authority is decided per BLOCK, not per task — see
  // `blockResolveRefusal` in lib/task-permissions.ts. This used to be
  // one task-level `isOversight || owner` flag, which is the defect
  // Chan reported ("users cant unblock a task"): it offered the button
  // to people the database refused and hid it from the person who
  // raised the block, whom the database allows.

  const loadNotes = React.useCallback(() => {
    api
      .get<Note[]>(`/api/tasks/${task.id}/notes`)
      .then(setNotes)
      .catch(() => toast.error('Could not load the worklog'));
  }, [task.id]);

  const loadBlocks = React.useCallback(() => {
    api
      .get<TaskBlock[]>(`/api/tasks/${task.id}/blocks`)
      .then(setBlocks)
      .catch(() => setBlocks([]));
  }, [task.id]);

  React.useEffect(() => {
    loadNotes();
    loadBlocks();
  }, [loadNotes, loadBlocks]);

  async function addNote() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/tasks/${task.id}/notes`, { body });
      setBody('');
      loadNotes();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not add the note');
    } finally {
      setSubmitting(false);
    }
  }

  async function resolveBlock(blockId: string) {
    try {
      await api.post(`/api/blocks/${blockId}/resolve`);
      loadBlocks();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not resolve the block');
    }
  }

  const points = task.points_awarded ?? task.points_override ?? task.catalog_points;
  const openBlocks = (blocks ?? []).filter((b) => !b.resolved_at);

  // Chan, 2026-09-09: "there should be a button on the task modal to
  // submit for approval, and vice versa if it's been submitted they can
  // take it back."
  //
  // This is the same `POST /api/tasks/:id/status` the board's drop
  // calls, gated by the same `moveRefusal` mirror the columns are dimmed
  // with — not a second ladder. `openBlockCount` is taken from the
  // blocks this dialog just loaded rather than the board's snapshot, so
  // resolving a block in the panel above immediately unlocks Submit
  // without a board refresh.
  const movable: MovableTask = {
    status: task.status,
    owner_user_id: task.owner_user_id,
    ownerPosition: task.ownerPosition,
    task_type_id: task.task_type_id,
    openBlockCount: blocks == null ? task.openBlockCount : openBlocks.length,
  };
  const actor: Actor | null = me
    ? { id: me.id, authority: me.authority, isClearingFounder: me.isClearingFounder, readOnly: me.readOnly }
    : null;

  // PLAN.md §10.1 — the definition lock. `lockRefusal` is the trigger's
  // own sentence (task-permissions.ts's `definitionLockRefusal`, a
  // faithful mirror of `ops.enforce_task_transition` guard 2b); reused
  // verbatim here instead of writing a second vocabulary for the same
  // refusal. `null` means the definition is still open to a direct edit.
  const lockRefusal = definitionLockRefusal(task, weekState, actor);
  const isGm = me?.authority === 'gm';
  // Chan: "once the meeting is concluded, those todos should be set and
  // not editable by the staff. Only admin and founder." The trigger's
  // own exemption already lets a founder/admin through guard 2b, which
  // is exactly why `lockRefusal` above is `null` for them even on a
  // locked task -- but that also meant the "Definition locked" banner
  // (and the only button that ever opened an edit surface) never
  // rendered for the one persona who is actually allowed to use it
  // (2026-09-10 regression, defect #3). This mirrors the same "would
  // this be locked for someone without the exemption" condition
  // `definitionLockRefusal` checks, without the actor branch, purely to
  // decide whether to surface the direct-edit affordance -- it grants
  // nothing; `PATCH /api/tasks/:id` is still enforced by the same
  // trigger regardless of what this renders.
  const lockedForOthers = task.is_committed && weekState != null && weekState !== 'planning';
  const isFounderOrAdmin = me?.authority === 'founder' || me?.authority === 'admin';
  const [requestingChange, setRequestingChange] = React.useState(false);
  const [editingDirect, setEditingDirect] = React.useState(false);
  const [editRequests, setEditRequests] = React.useState<TaskEditRequest[] | null>(null);
  const [lookupTypes, setLookupTypes] = React.useState<{ id: string; name: string }[]>([]);
  const [lookupMembers, setLookupMembers] = React.useState<{ userId: string; name: string | null; email: string | null }[]>([]);

  const loadEditRequests = React.useCallback(() => {
    api
      .get<TaskEditRequest[]>(`/api/task-edit-requests?taskId=${task.id}`)
      .then(setEditRequests)
      .catch(() => setEditRequests([]));
  }, [task.id]);

  // Every ops member can read this task's edit-request history (the same
  // "everyone is in the loop" RLS the migration's SELECT policy grants) —
  // Task 4's "close the loop" for the requester happens simply by this
  // section existing and always reflecting the real status, not by a
  // separate notification surface.
  React.useEffect(() => {
    loadEditRequests();
  }, [loadEditRequests]);

  // Name/type lookups for the diff renderer, fetched only once a request
  // actually exists to show (or the requester is about to raise one) —
  // no point paying for two extra requests on the common case of a task
  // with no edit-request history at all.
  React.useEffect(() => {
    if (!requestingChange && !editRequests?.length) return;
    let cancelled = false;
    Promise.all([
      api.get<{ id: string; name: string }[]>('/api/catalog'),
      api.get<{ userId: string; name: string | null; email: string | null }[]>('/api/members'),
    ])
      .then(([types, members]) => {
        if (cancelled) return;
        setLookupTypes(types);
        setLookupMembers(members);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [requestingChange, editRequests?.length]);

  const diffResolve: DiffResolvers = {
    taskTypeName: (id) => lookupTypes.find((t) => t.id === id)?.name ?? 'Unknown type',
    memberName: (id) => lookupMembers.find((m) => m.userId === id)?.name ?? lookupMembers.find((m) => m.userId === id)?.email ?? 'Unknown',
  };

  const statusAction: { to: BoardColumn; label: string; hint: string; variant?: 'primary' | 'secondary' } | null =
    task.status === 'todo' || task.status === 'in_progress'
      ? {
          to: 'submitted',
          label: 'Submit for approval',
          hint: 'Sends this to the GM to verify. Points are awarded once the founder clears it.',
        }
      : task.status === 'submitted'
        ? {
            to: 'in_progress',
            label: 'Take it back',
            hint: 'Pulls this out of the GM’s queue and back into In progress. Nothing is lost.',
            variant: 'secondary',
          }
        : task.status === 'rejected'
          ? {
              to: 'backlog',
              label: 'Rework it',
              hint: 'Returns this to Backlog so it can be reworked and submitted again.',
              variant: 'secondary',
            }
          : null;
  const statusRefusal = statusAction ? moveRefusal(movable, statusAction.to, actor) : null;

  async function moveStatus(to: BoardColumn) {
    const status = COLUMN_STATUS[to];
    if (!status) return;
    setMoving(true);
    try {
      await api.post(`/api/tasks/${task.id}/status`, { to: status });
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'The move was refused');
    } finally {
      setMoving(false);
    }
  }

  return (
    <>
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      {/*
        Chan, 2026-09-10 (PLAN.md §10 #3): "once the modal is tall
        enough, it should just make the comment section scrollable
        before it makes the modal scrollable." The dialog itself no
        longer scrolls (`overflow-hidden`, capped at 85vh) — it grows
        with content up to that cap, and everything above the worklog
        (identity, status, action row, fields, blocks) stays in normal
        flow and always visible. Only the worklog list gets its own
        `overflow-y-auto` region, sized by `flex-1 min-h-0` to take
        whatever room is left once the fixed pieces above and below it
        (composer, footer) have claimed theirs. `min-h-0` is load-bearing
        here — without it a flex child never shrinks below its content's
        natural height, and the "own scroll region" never kicks in.
      */}
      <DialogContent className="flex max-h-[85vh] w-[min(680px,92vw)] max-w-none flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="pr-6">{task.title}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
        <div className="flex shrink-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={task.status} />
          {task.is_committed ? <Chip tone="info">Committed this week</Chip> : null}
          {task.is_recurring ? <Chip>Recurring</Chip> : null}
          {task.carry_over_count > 0 ? (
            <Chip tone={task.carry_over_count >= 3 ? 'danger' : 'neutral'}>
              <RotateCcw className="size-3 shrink-0" aria-hidden />
              Carried {task.carry_over_count}w
            </Chip>
          ) : null}
          {/*
            "Blocked" alone did not say which side of the block the
            reader is on. If any open block names THEM as the blocker,
            the chip says so — this is the header's one-glance version
            of the same distinction the block panel below spells out.
          */}
          {openBlocks.length > 0 ? (
            <Chip tone="danger">
              <Ban className="size-3 shrink-0" aria-hidden />
              {openBlocks.some((b) => b.blocking_user_id === me?.id) ? 'Blocked — on you' : 'Blocked'}
            </Chip>
          ) : null}
          {lockRefusal ? (
            <Chip>
              <Lock className="size-3 shrink-0" aria-hidden />
              Definition locked
            </Chip>
          ) : null}
        </div>

        {/*
          Task 1 (PLAN.md §10.1): this is a normal state of the week, not
          an error — same banner geometry as the statusAction row below
          it, not the danger-toned refusal treatment. The message is the
          trigger's own sentence (`definitionLockRefusal`), so it never
          drifts from what the database will actually say if someone
          tries anyway. Progress (status/notes/blocks) is never affected
          by this and nothing here implies it is — the statusAction row
          right below stays fully live.
        */}
        {lockRefusal ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-surface-2 px-3 py-2.5">
            <p className="flex max-w-[400px] items-start gap-1.5 text-body-sm text-ink-2">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
              {lockRefusal}
            </p>
            {isGm && !readOnly ? (
              <Button variant="secondary" size="sm" onClick={() => setRequestingChange(true)}>
                Request a change
              </Button>
            ) : null}
          </div>
        ) : lockedForOthers && isFounderOrAdmin && !readOnly ? (
          // The founder/admin bypass in words: this task's definition
          // WOULD be locked for anyone else, but the database already
          // lets this caller through -- so the direct edit path is
          // offered instead of the GM's request banner, never both.
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-surface-2 px-3 py-2.5">
            <p className="flex max-w-[400px] items-start gap-1.5 text-body-sm text-ink-2">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
              This task's definition is locked for the week for everyone but a founder or admin — that's you.
            </p>
            <Button variant="secondary" size="sm" onClick={() => setEditingDirect(true)}>
              <Pencil className="size-3.5" aria-hidden />
              Edit directly
            </Button>
          </div>
        ) : null}

        {statusAction ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-surface-2 px-3 py-2.5">
            <p className="max-w-[380px] text-body-sm text-ink-2">
              {statusRefusal ?? statusAction.hint}
            </p>
            <Button
              variant={statusAction.variant === 'secondary' ? 'secondary' : 'primary'}
              loading={moving}
              disabled={statusRefusal != null}
              title={statusRefusal ?? undefined}
              onClick={() => moveStatus(statusAction.to)}
            >
              {statusAction.label}
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 rounded-lg border border-hairline bg-surface-2 p-3 sm:grid-cols-4">
          <Field label="Owner">
            <span className="flex items-center gap-1.5">
              <span className="flex size-5 items-center justify-center rounded-full bg-navy-800 text-micro text-white">
                {initials(task.ownerName)}
              </span>
              {task.ownerName ?? 'Unknown'}
            </span>
          </Field>
          <Field label="Position">{task.ownerPosition ?? '—'}</Field>
          <Field label={task.points_awarded != null ? 'Points awarded' : 'Points'}>
            <span className="num text-num-md">{points ?? '—'}</span>
            {task.points_override != null ? <span className="ml-1 text-micro text-ink-3">overridden</span> : null}
          </Field>
          <Field label="Client ref">{task.client_ref || '—'}</Field>
        </div>

        {task.points_override_reason ? (
          <p className="text-body-sm text-ink-2">
            <span className="text-eyebrow text-ink-3">Override reason </span>
            {task.points_override_reason}
          </p>
        ) : null}

        <div>
          <p className="mb-1 text-eyebrow text-ink-3">Description</p>
          {task.description ? (
            <p className="whitespace-pre-wrap break-words text-body-sm text-ink">{task.description}</p>
          ) : (
            <p className="text-body-sm text-ink-3">No description was written for this task.</p>
          )}
        </div>

        {task.rejected_reason ? (
          <div className="rounded-lg border border-danger-border bg-danger-wash px-3 py-2">
            <p className="text-eyebrow text-danger">Returned</p>
            <p className="text-body-sm text-ink-2">{task.rejected_reason}</p>
          </div>
        ) : null}

        {task.status === 'pending_cancellation' ? (
          <div className="rounded-lg border border-pending-border bg-pending-wash px-3 py-2">
            <p className="text-eyebrow text-pending">Flagged for cancellation</p>
            <p className="text-body-sm text-ink-2">{task.cancellation_reason ?? '—'}</p>
            <p className="mt-1 text-micro text-ink-3">Waiting on the clearing founder’s decision.</p>
          </div>
        ) : null}

        <div>
          <p className="mb-1 text-eyebrow text-ink-3">Blocks</p>
          {blocks == null ? (
            <p className="text-body-sm text-ink-3">Loading…</p>
          ) : blocks.length === 0 ? (
            <p className="text-body-sm text-ink-3">Never blocked.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {blocks.map((b) => {
                // Chan, 2026-09-10: "i want it to be more clear which
                // tasks you're blocking and which tasks you're not."
                // Every block row now leads with the relationship — the
                // fact that decides who has to act — instead of leading
                // with the blocker's name, which read identically
                // whether you were the one waiting or the one being
                // waited on.
                const relation = blockRelation(b, me?.id);
                const refusal = b.resolved_at ? null : blockResolveRefusal(b, task, actor);
                return (
                  <li
                    key={b.id}
                    className={cn(
                      'flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-body-sm',
                      b.resolved_at ? 'border-hairline bg-surface-2 text-ink-3' : 'border-blocked-border bg-blocked-wash'
                    )}
                  >
                    <div className="min-w-0">
                      <p className={cn('font-semibold', b.resolved_at ? 'text-ink-3' : 'text-ink')}>
                        {b.resolved_at
                          ? `Was waiting on ${b.blockingName ?? (b.target === 'task' ? 'another task' : 'someone else')}`
                          : blockRelationLabel(relation, b.blockingName, b.target)}
                      </p>
                      <p className={cn('break-words', b.resolved_at ? 'text-ink-3' : 'text-ink-2')}>{b.reason}</p>
                      <p className="text-micro text-ink-3">
                        raised by {b.createdByName ?? 'unknown'} · {new Date(b.created_at).toLocaleString()}
                        {b.resolved_at ? ` · resolved by ${b.resolvedByName ?? 'unknown'}` : ''}
                      </p>
                      {/*
                        The refusal is printed, not hidden behind a
                        tooltip: a `disabled` button takes no pointer
                        events, so a `title` on it would never appear.
                        Never hidden silently, never offered to someone
                        the database will refuse.
                      */}
                      {refusal ? <p className="mt-0.5 text-micro text-ink-3">{refusal}</p> : null}
                    </div>
                    {!b.resolved_at ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={refusal != null}
                        onClick={() => resolveBlock(b.id)}
                      >
                        Resolve
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <HistorySection task={task} />

        </div>

        {/*
          The one scroll region past this point. `min-h-[96px]` keeps a
          few rows visible even in a short dialog rather than collapsing
          to nothing; `flex-1 min-h-0` lets it claim whatever height the
          fixed pieces above and below (composer, footer) leave over, up
          to the dialog's own 85vh cap. `overflow-x-auto` on the list
          itself is the "wide content still gets its own overflow-x"
          rule — a note's own text always wraps (`break-words`), but this
          is the backstop for anything that doesn't (a long unbroken
          token, a pasted table).

          Task 4's change-request history (closing the loop — "the GM
          should be able to see what happened to their request") shares
          THIS scroll region rather than sitting in the fixed area above
          with the chips/fields/blocks. Reproduced defect it fixes: a
          first attempt put it in the fixed area, which grew past the
          dialog's 85vh cap on a task with real history and the
          flexbox algorithm silently clipped the overflow from the
          bottom — hiding not just this section but the ENTIRE worklog
          panel below it, with no scrollbar to hint anything was
          missing (confirmed present in the DOM via `innerText`,
          invisible on screen). Both this list and the worklog are
          unbounded, append-only histories, so sharing the one scroll
          region Chan's own design already carves out is the correct
          fix, not a second one.
        */}
        <div className="flex min-h-[96px] flex-1 flex-col overflow-hidden">
          <p className="mb-1 shrink-0 text-eyebrow text-ink-3">Worklog</p>
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto overflow-x-auto rounded-lg border border-hairline bg-surface p-3">
            {editRequests && editRequests.length > 0 ? (
              <div className="-mx-3 -mt-3 mb-1 border-b border-hairline pb-3">
                <p className="px-3 pt-3 text-eyebrow text-ink-3">Change requests</p>
                <div className="mt-1">
                  {editRequests.map((r) => (
                    <EditRequestCard key={r.id} request={r} diffs={buildFieldDiffs(r, diffResolve)} />
                  ))}
                </div>
              </div>
            ) : null}
            {!notes ? (
              <p className="text-body-sm text-ink-3">Loading…</p>
            ) : notes.length === 0 ? (
              <p className="text-body-sm text-ink-3">No notes yet. The worklog is how a task narrates itself.</p>
            ) : (
              notes.map((n) => (
                <div key={n.id} className="border-b border-hairline pb-2 last:border-0 last:pb-0">
                  <p className="whitespace-pre-wrap break-words text-body-sm text-ink">{n.body}</p>
                  <p className="num text-num-xs text-ink-3">
                    {n.authorName ?? 'unknown'} · {new Date(n.created_at).toLocaleString()}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
        </div>

        {/* One mirror, not three ad-hoc checks. This used to test `closed`
            and `readOnly` and stop there, which left the trigger's real
            gate — `ops.enforce_task_note_insert` restricts a note to the
            task's OWNER or oversight — with no client-side counterpart at
            all. Any ops member could open a peer's task, write a note, and
            have it refused only on send. `noteRefusal` covers all three
            cases in the trigger's own order. */}
        {noteBlocked ? (
          <p className="shrink-0 text-body-sm text-ink-3">{noteBlocked}</p>
        ) : (
          <div className="flex shrink-0 flex-col gap-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, 4000))}
              placeholder="What did you do? What's next?"
              aria-label="Add a worklog note"
              className="min-h-[70px] w-full rounded-md border border-hairline-strong bg-white px-[10px] py-2 text-body text-ink placeholder:text-ink-3 focus-visible:border-brand-600 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-100"
            />
            {error ? <p className="text-label text-danger">{error}</p> : null}
          </div>
        )}

        <DialogFooter className="shrink-0 flex-wrap">
          {!closed && task.status !== 'pending_cancellation' && openBlocks.length === 0 ? (
            <Button
              variant="secondary"
              disabled={readOnly}
              title={readOnly ? 'Your account is read-only.' : undefined}
              onClick={() => {
                onClose();
                onDeclareBlock(task);
              }}
            >
              <Ban className="size-3.5" aria-hidden />
              Declare a block
            </Button>
          ) : null}
          {onFlagCancellation && !closed && task.status !== 'pending_cancellation' ? (
            <Button
              variant="secondary"
              // Its sibling "Declare a block" above has carried this guard
              // all along; this button was simply missed. A read-only
              // account flagging a cancellation is refused by
              // `core.is_read_only()` before any other check.
              disabled={readOnly}
              title={readOnly ? 'Your account is read-only.' : undefined}
              onClick={() => {
                onClose();
                onFlagCancellation(task);
              }}
            >
              <XOctagon className="size-3.5" aria-hidden />
              Flag for cancellation
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {!noteBlocked ? (
            <Button loading={submitting} disabled={!body.trim()} onClick={addNote}>
              Add note
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {requestingChange ? (
      <TaskEditRequestDialog
        task={task}
        onClose={() => setRequestingChange(false)}
        onCreated={loadEditRequests}
      />
    ) : null}

    {editingDirect ? (
      <TaskEditRequestDialog
        task={task}
        direct
        onClose={() => setEditingDirect(false)}
        onCreated={() => {
          loadEditRequests();
          loadNotes();
          onChanged();
        }}
      />
    ) : null}
    </>
  );
}

// The running worklog Chan asked for -- a task's narration, distinct
// from its `description`. Append-only server-side; this dialog only
// ever lists and posts, never edits or deletes a note. Reached from the
// card's note-count button, which is the "jump straight to the
// conversation" path; the full detail dialog above contains the same
// worklog in its wider context.
export function TaskNotesDialog({ task, onClose, onNoteAdded }: { task: Task; onClose: () => void; onNoteAdded: () => void }) {
  const { me } = useAuth();
  const [notes, setNotes] = React.useState<Note[] | null>(null);
  const [body, setBody] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const noteBlocked = noteRefusal(task, me as Actor | null);

  const load = React.useCallback(() => {
    api
      .get<Note[]>(`/api/tasks/${task.id}/notes`)
      .then(setNotes)
      .catch(() => toast.error('Could not load the worklog'));
  }, [task.id]);
  React.useEffect(() => load(), [load]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/tasks/${task.id}/notes`, { body });
      setBody('');
      load();
      onNoteAdded();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not add the note');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Worklog — "{task.title}"</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[320px] flex-col gap-3 overflow-y-auto">
          {!notes ? (
            <p className="text-body-sm text-ink-3">Loading…</p>
          ) : notes.length === 0 ? (
            <p className="text-body-sm text-ink-3">No notes yet.</p>
          ) : (
            notes.map((n) => (
              <div key={n.id} className="border-b border-hairline pb-2 last:border-0">
                <p className="whitespace-pre-wrap break-words text-body-sm text-ink">{n.body}</p>
                <p className="text-num-xs num text-ink-3">
                  {n.authorName ?? 'unknown'} · {new Date(n.created_at).toLocaleString()}
                </p>
              </div>
            ))
          )}
        </div>
        {/* Same single mirror as TaskDetailDialog above — this dialog posts
            to the same endpoint and must not answer the question differently. */}
        {noteBlocked ? (
          <p className="text-body-sm text-ink-3">{noteBlocked}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, 4000))}
              placeholder="What did you do? What's next?"
              className="min-h-[70px] w-full rounded-md border border-hairline-strong bg-white px-[10px] py-2 text-body text-ink placeholder:text-ink-3 focus-visible:outline-none focus-visible:border-brand-600 focus-visible:ring-[3px] focus-visible:ring-brand-100"
            />
            {error ? <p className="text-label text-danger">{error}</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {!noteBlocked ? (
            <Button loading={submitting} disabled={!body.trim()} onClick={submit}>
              Add note
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// GM or founder flags a task for cancellation; the clearing founder
// approves or refuses from /queue (PLAN.md's "one transition endpoint"
// rule: this posts the same `POST /:id/status` every other move does,
// just targeting `pending_cancellation`).
export function FlagCancellationDialog({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/tasks/${task.id}/status`, { to: 'pending_cancellation', reason });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not flag this task');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Flag "{task.title}" for cancellation</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <p className="text-body-sm text-ink-3">
            The clearing founder will approve or refuse this. Nothing is cancelled yet, and no points are ever awarded on a
            cancelled task.
          </p>
          <ReasonTextarea value={reason} onChange={setReason} placeholder="Why should this be cancelled?" />
          {error ? <p className="text-label text-danger">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" loading={submitting} disabled={reason.trim().length < 10} onClick={submit}>
            Flag for cancellation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One ops roster member, as `GET /api/members` returns them. */
interface RosterMember {
  userId: string;
  name: string | null;
  email: string | null;
  position?: string | null;
  /**
   * `core.users.read_only` (ERC, DCA -- the two other brokerages'
   * principals). Optional because older payloads did not carry it, and a
   * missing value must never accidentally exclude a real teammate.
   */
  readOnly?: boolean;
}

/**
 * A picker's honest states, in the geometry of the `Select` it stands in
 * for.
 *
 * This exists because of the failure mode this project keeps finding: a
 * list-backed control whose fetch failed renders as an EMPTY dropdown,
 * which reads as "there is nobody to pick" — a lie with the same
 * appearance as the truth. So a picker inside this dialog never renders
 * its trigger until the list is actually back: loading is a skeleton at
 * the trigger's own height (DESIGN.md §8 — geometry, never a spinner),
 * a failure is the panel-level danger band with the server's verbatim
 * message and a Retry, and a genuinely empty roster/week says so in
 * words.
 */
function PickerSlot({
  status,
  message,
  isEmpty,
  emptyCopy,
  onRetry,
  children,
}: {
  status: ResourceStatus;
  message: string | null;
  isEmpty: boolean;
  emptyCopy: string;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (status === 'loading') {
    return <div className="skeleton-pulse h-9 w-full rounded-md bg-surface-2" aria-hidden />;
  }
  if (status === 'unreachable' || status === 'error') {
    return (
      <div className="flex items-start justify-between gap-3 rounded-md border border-danger-border bg-danger-wash px-3 py-2">
        <p className="text-body-sm text-danger">{message ?? 'This list could not be loaded.'}</p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (isEmpty) {
    return <p className="text-body-sm text-ink-3">{emptyCopy}</p>;
  }
  return <>{children}</>;
}

/**
 * Declaring a block — all three targets `ops.task_blocks` accepts.
 *
 * Chan, 2026-09-10: "i want it to be more clear which tasks you're
 * blocking and which tasks you're not." The accountability half of that
 * ask runs entirely on `blocking_user_id`, and until this picker existed
 * NO path in the app could write that column: this dialog offered the
 * three targets in its dropdown but only ever sent `external`, with a
 * note where the picker should have been. So people were being charged a
 * reliability modifier (`hoursBlockedByThem`, −1 per 8 hours, capped at
 * −10) fed by a field no user could set, and Now's "work you are holding
 * up" section could only ever show seeded data.
 *
 * The three targets, and why each list is scoped the way it is:
 *
 *  - **person** — the ops roster, minus the caller and minus this task's
 *    OWNER. The caller because naming yourself as the blocker of your own
 *    declaration is noise; the owner because "this task is waiting on
 *    the person whose task it is" is not a block, it is just unfinished
 *    work — and recording it as one would charge the owner the blocking
 *    modifier for holding up their own task while `/api/now` filed it
 *    under "waiting on you" rather than under anybody's debt.
 *  - **task** — the open tasks of the blocked task's own week, minus
 *    itself. A week is the unit this whole app plans in, and it is the
 *    largest set a person can pick from in one dropdown without a search
 *    UI there is no brief for. Cleared and cancelled tasks are dropped:
 *    finished work blocks nothing. The owner's name rides on every
 *    option because "blocked by whose task" is the operative fact.
 *  - **external** — the free-text outside party, unchanged.
 *
 * Both lists load when the dialog opens rather than when a target is
 * chosen. `useResource` is the app's one loading contract and cannot be
 * fired conditionally; hand-rolling a lazy fetch would mean re-deriving
 * loading/unreachable/error/empty by hand, which is exactly what that
 * hook exists to stop. Two small reads on a deliberately-opened modal is
 * the cheaper trade, and it also means switching target shows the list
 * immediately instead of flashing a skeleton.
 *
 * A task cannot block itself and cannot close a cycle — both are refused
 * by `ops.reject_block_cycle` (20260909090200) and surfaced here
 * verbatim. Excluding this task from the list below is politeness about
 * an option that would always fail, not the enforcement.
 */
export function BlockDialog({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const { me } = useAuth();
  const [target, setTarget] = React.useState<BlockDraft['target']>('external');
  const [external, setExternal] = React.useState('');
  const [blockingUserId, setBlockingUserId] = React.useState('');
  const [blockingTaskId, setBlockingTaskId] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const roster = useResource((signal) => api.get<RosterMember[]>('/api/members', { signal }), []);
  const weekTasks = useResource(
    (signal) => api.get<Task[]>(`/api/tasks?weekId=${task.week_id}`, { signal }),
    [task.week_id]
  );

  // Excluded from the person picker, in order: the caller (you are not
  // waiting on yourself), the task's owner (a block naming the owner of
  // its own task is unfinished work, and it would charge them the
  // blocking-others modifier for holding up their own task), and
  // READ-ONLY accounts.
  //
  // The read-only exclusion is the substantive one. A read-only founder
  // (ERC, DCA) cannot own, submit, clear or resolve anything, so naming
  // one as your blocker asks for something they are structurally unable
  // to give -- and it would still charge them a reliability point every
  // 8 hours the block stays open. The scoreboard applies the identical
  // reasoning to its rail (PLAN.md §11.4 #1).
  const people = React.useMemo(
    () =>
      (roster.data ?? [])
        .filter(
          (m) => m.userId && m.userId !== me?.id && m.userId !== task.owner_user_id && !m.readOnly
        )
        .sort((a, b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? '')),
    [roster.data, me?.id, task.owner_user_id]
  );

  const candidateTasks = React.useMemo(
    () =>
      (weekTasks.data ?? [])
        .filter((t) => t.id !== task.id && t.status !== 'cleared' && t.status !== 'cancelled')
        // By owner first, so the dropdown reads as "whose work am I
        // waiting on" -- the same grouping the board's columns use.
        .sort(
          (a, b) =>
            (a.ownerName ?? '').localeCompare(b.ownerName ?? '') || a.title.localeCompare(b.title)
        ),
    [weekTasks.data, task.id]
  );

  // A selection that is no longer in its list (the roster reloaded, the
  // task was cleared under us) is treated as no selection at all, rather
  // than being kept in state and posted as a stale id. Derived rather
  // than cleared in an effect, so there is no window where the two
  // disagree.
  const personValue = people.some((p) => p.userId === blockingUserId) ? blockingUserId : '';
  const taskValue = candidateTasks.some((t) => t.id === blockingTaskId) ? blockingTaskId : '';
  const chosenPerson = people.find((p) => p.userId === personValue);

  const refusal = blockSubmitRefusal({
    target,
    blockingUserId: personValue,
    blockingTaskId: taskValue,
    blockingExternal: external,
    reason,
  });

  async function submit() {
    if (refusal) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/tasks/${task.id}/blocks`, {
        target,
        blockingUserId: target === 'person' ? personValue : undefined,
        blockingTaskId: target === 'task' ? taskValue : undefined,
        blockingExternal: target === 'external' ? external : undefined,
        reason,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not declare the block');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>What is blocking "{task.title}"?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="block-target">What is it waiting on?</Label>
            <Select value={target} onValueChange={(v) => setTarget(v as BlockDraft['target'])}>
              <SelectTrigger id="block-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="external">An outside party (BOC, carrier, client…)</SelectItem>
                <SelectItem value="person">Someone on the team</SelectItem>
                <SelectItem value="task">Another task</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {target === 'external' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="block-external">Who?</Label>
              <input
                id="block-external"
                className="h-[34px] rounded-md border border-[#CBD2E0] px-[10px] text-body"
                placeholder="e.g. Bureau of Customs"
                value={external}
                onChange={(e) => setExternal(e.target.value)}
              />
            </div>
          ) : null}

          {target === 'person' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="block-person">Who is it waiting on?</Label>
              <PickerSlot
                status={roster.status}
                message={roster.message}
                isEmpty={people.length === 0}
                emptyCopy={
                  task.owner_user_id === me?.id
                    ? 'No one else is on the ops roster, so there is nobody to name.'
                    : 'No one else on the ops roster can be named — only you and this task’s owner are on it.'
                }
                onRetry={roster.reload}
              >
                <Select value={personValue} onValueChange={setBlockingUserId}>
                  <SelectTrigger id="block-person">
                    <SelectValue placeholder="Choose a person" />
                  </SelectTrigger>
                  <SelectContent>
                    {people.map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.name ?? m.email ?? m.userId}
                        {m.position ? ` · ${m.position}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </PickerSlot>
              {/*
                The consequence, said where the decision is made rather
                than only later on the named person's own Now screen.
                One sentence, not a warning banner: naming someone is a
                normal and necessary thing to do, and the number is the
                real one (`packages/ops-scoring` reliability modifier:
                -1 per 8 hours blocked, capped at -10).
              */}
              <p className="text-body-sm text-ink-2">
                {chosenPerson
                  ? `${chosenPerson.name ?? chosenPerson.email ?? 'They'} will see this on their Now screen as work they are holding up, and every 8 hours it stays open costs them a reliability point (up to 10).`
                  : 'Whoever you name will see this on their Now screen as work they are holding up, and every 8 hours it stays open costs them a reliability point (up to 10).'}
              </p>
            </div>
          ) : null}

          {target === 'task' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="block-task">
                Which task? <span className="text-micro text-ink-3">— this week’s open work</span>
              </Label>
              <PickerSlot
                status={weekTasks.status}
                message={weekTasks.message}
                isEmpty={candidateTasks.length === 0}
                emptyCopy="No other open tasks in this week — there is nothing to point at."
                onRetry={weekTasks.reload}
              >
                <Select value={taskValue} onValueChange={setBlockingTaskId}>
                  <SelectTrigger id="block-task">
                    <SelectValue placeholder="Choose a task" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidateTasks.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.title} · {t.ownerName ?? 'unknown owner'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </PickerSlot>
              <p className="text-body-sm text-ink-2">
                This stays blocked until that task’s own block is resolved — nobody’s reliability is charged for a
                task-to-task block.
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="block-reason">
              Why is it blocked? <span className="text-micro text-ink-3">Required</span>
            </Label>
            <ReasonTextarea id="block-reason" value={reason} onChange={setReason} placeholder="Why is this blocked?" />
          </div>

          {error ? <p className="text-label text-danger">{error}</p> : null}

          {/*
            Why the button is dead, printed above it rather than hidden
            in a `title`: a disabled button takes no pointer events, so a
            tooltip on it would never appear -- the same reason the block
            panel prints its Resolve refusal. `aria-live` because this
            sentence changes as the form is filled in and a disabled
            button cannot be focused to announce it.
          */}
          {refusal ? (
            <p className="text-micro text-ink-3" aria-live="polite">
              {refusal}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting} disabled={refusal != null}>
            Declare block
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------
// Opening the same modal from a slim list (Now)
// ---------------------------------------------------------------------

/**
 * Chan, 2026-09-10: "now page tasks should be interactable."
 *
 * `GET /api/now` deliberately returns a slim row — id, title, status,
 * owner, points, ages — because four sections of full task rows on a
 * screen that polls every 20s is a lot of payload for data most of
 * which is never read. So opening a card here fetches the one full row
 * from `GET /api/tasks/:id` (byte-identical in shape to a board card)
 * and hands it to the SAME `TaskDetailDialog` the board opens. There is
 * no second, thinner detail view to drift.
 *
 * This component also hosts the two satellite dialogs the detail modal
 * hands off to (declare a block, flag a cancellation), which on the
 * board live at page level because its cards can trigger them directly.
 * Now has no such second trigger, so they are owned here instead of
 * being re-plumbed through the route.
 */
export function TaskDetailById({
  taskId,
  fallbackTitle,
  weekStateById,
  canFlagCancellation = false,
  onClose,
  onChanged,
}: {
  taskId: string;
  /** What the list row already knew, so the loading dialog carries the real task's name rather than a placeholder. */
  fallbackTitle: string;
  /** `ops.weeks.state` by week id — the definition lock's other half. Sourced by the route from one `/api/weeks` read, never per card. */
  weekStateById: Map<string, string>;
  canFlagCancellation?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const resource = useResource((signal) => api.get<Task>(`/api/tasks/${taskId}`, { signal }), [taskId]);
  // Local copy, seeded from the resource: a change made inside the
  // modal (submit, take back, resolve a block) has to be re-read
  // without dropping the modal back to its loading skeleton, exactly
  // the reason `routes/board.tsx` keeps `board` separate from
  // `boardResource`.
  const [task, setTask] = React.useState<Task | null>(null);
  const [detailClosed, setDetailClosed] = React.useState(false);
  const [satellite, setSatellite] = React.useState<'block' | 'cancel' | null>(null);

  React.useEffect(() => {
    if (resource.status === 'ready' && resource.data) setTask(resource.data);
  }, [resource.status, resource.data]);

  const refresh = React.useCallback(() => {
    api
      .get<Task>(`/api/tasks/${taskId}`)
      .then(setTask)
      .catch(() => {
        // The list behind this modal is about to be refreshed anyway
        // (`onChanged`), and the write itself already succeeded — a
        // failed re-read is not worth a second error on top.
      });
    onChanged();
  }, [taskId, onChanged]);

  // The detail modal's own "Declare a block" / "Flag for cancellation"
  // buttons close the detail and open a satellite in the same event, so
  // "the detail was closed" cannot by itself mean "the caller is done
  // here". Both state updates land in the same batch, so by the time
  // this effect runs the satellite (if any) is already set.
  React.useEffect(() => {
    if (detailClosed && satellite === null) onClose();
  }, [detailClosed, satellite, onClose]);

  if (detailClosed && satellite === null) return null;

  if (satellite === 'block' && task) {
    return (
      <BlockDialog
        task={task}
        onClose={() => setSatellite(null)}
        onDone={() => {
          setSatellite(null);
          refresh();
        }}
      />
    );
  }

  if (satellite === 'cancel' && task) {
    return (
      <FlagCancellationDialog
        task={task}
        onClose={() => setSatellite(null)}
        onDone={() => {
          setSatellite(null);
          refresh();
        }}
      />
    );
  }

  if (task) {
    return (
      <TaskDetailDialog
        task={task}
        weekState={weekStateById.get(task.week_id) ?? null}
        onClose={() => setDetailClosed(true)}
        onChanged={refresh}
        onFlagCancellation={canFlagCancellation ? () => setSatellite('cancel') : undefined}
        onDeclareBlock={() => setSatellite('block')}
      />
    );
  }

  // Loading / unreachable / error, all inside the dialog the click
  // opened — DESIGN.md §8: a skeleton with the real layout's geometry,
  // never a spinner, and the server's own message verbatim on failure.
  // A row RLS will not return comes back 404 NOT_FOUND, so "this task
  // is no longer visible to you" is said by the API, not invented here.
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[min(680px,92vw)] max-w-none">
        <DialogHeader>
          <DialogTitle className="pr-6">{fallbackTitle}</DialogTitle>
        </DialogHeader>
        {resource.status === 'unreachable' ? (
          <UnreachablePanel message={resource.message ?? ''} onRetry={resource.reload} />
        ) : resource.status === 'error' ? (
          <ErrorPanel message={resource.message ?? 'This task could not be opened.'} onRetry={resource.reload} />
        ) : (
          <div className="flex flex-col gap-4" aria-hidden>
            <div className="flex gap-2">
              <div className="skeleton-pulse h-[22px] w-24 rounded-xs bg-surface-2" />
              <div className="skeleton-pulse h-[22px] w-28 rounded-xs bg-surface-2" style={{ animationDelay: '80ms' }} />
            </div>
            <div className="skeleton-pulse h-[68px] w-full rounded-lg bg-surface-2" style={{ animationDelay: '120ms' }} />
            <div className="skeleton-pulse h-3 w-4/5 rounded-xs bg-surface-2" style={{ animationDelay: '160ms' }} />
            <div className="skeleton-pulse h-3 w-3/5 rounded-xs bg-surface-2" style={{ animationDelay: '200ms' }} />
            <div className="skeleton-pulse h-[120px] w-full rounded-lg bg-surface-2" style={{ animationDelay: '240ms' }} />
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
