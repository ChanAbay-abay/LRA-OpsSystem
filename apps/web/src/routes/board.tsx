/**
 * LRA Global Ops :: /board — the Trello-style board
 *
 * PRD.md §6.1 / DESIGN.md §7.3. `@dnd-kit/core` drives the drag; every
 * drop calls the SAME `POST /api/tasks/:id/status` endpoint a button
 * click would (PLAN.md §3's "one transition endpoint" rule) — this
 * screen has no privileged path, so an illegal drop fails with the
 * database's own message and the card returns to where it started.
 *
 * Keyboard path and screen-reader announcements are DESIGN.md §7.3's
 * hard requirement, not polish: the founder may run the board from a
 * keyboard on a shared display. `KeyboardSensor` + a custom
 * `announcements` set (Space picks up, arrows move, Space drops, Esc
 * cancels) implements exactly that.
 *
 * "This week" is rendered read-only in this phase: it reflects
 * `is_committed`, and the commitment lock/briefing flow that actually
 * sets that flag is Phase 6, deliberately not built yet (blocked on the
 * founder pricing the catalog). Dropping into Blocked opens the
 * required block dialog before anything commits, per DESIGN.md §7.3.
 *
 * The board stays at Chan's decided seven columns (2026-09-09) — no
 * eighth `pending_cancellation` column. A task flagged for cancellation
 * instead stays rendered in the column its `pre_cancellation_status`
 * resolves to (the API does that placement) with a distinct "awaiting
 * decision" treatment reusing DESIGN.md's `--pending` semantic, and it
 * is not draggable — the trigger would refuse every transition off
 * `pending_cancellation` except the clearing founder's own decision, so
 * a drag that silently snapped back would be a lie. `useDraggable`'s own
 * `disabled` option is used rather than a hand-rolled guard, which also
 * gets `aria-disabled` and the removal of pointer/keyboard activation
 * for free. The banner (`flaggedForCancellation`, from the API's
 * separate `flagged` list) remains the founder's action surface;
 * placement in-column is the visibility fix.
 */
import * as React from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Announcements,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { Ban, CheckCircle2, MessageSquare, Pencil, RotateCcw, XOctagon } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/app-shell';
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
import { ResourceView, SkeletonCards } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Task {
  id: string;
  title: string;
  status: string;
  catalog_points: number | null;
  points_override: number | null;
  points_awarded: number | null;
  is_recurring: boolean;
  carry_over_count: number;
  last_activity_at: string;
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

type Board = Record<'backlog' | 'this_week' | 'in_progress' | 'blocked' | 'submitted' | 'verified' | 'cleared', Task[]> & {
  // Not a column — the same flagged tasks that also sit in their real
  // column above, kept as a flat list so the banner doesn't have to scan
  // all seven columns to build itself.
  flagged: Task[];
};

const COLUMNS: { id: keyof Board; label: string; droppable: boolean }[] = [
  { id: 'backlog', label: 'Backlog', droppable: true },
  { id: 'this_week', label: 'This week', droppable: false },
  { id: 'in_progress', label: 'In progress', droppable: true },
  { id: 'blocked', label: 'Blocked', droppable: true },
  { id: 'submitted', label: 'Submitted', droppable: true },
  { id: 'verified', label: 'Verified', droppable: true },
  { id: 'cleared', label: 'Cleared', droppable: true },
];

// Who the task is now waiting on once it lands in a given column, for
// the keyboard drop announcement (DESIGN.md:663-664, defect #4). Only
// the two approval columns have a waiting party; everything else is
// either self-owned (backlog/in progress), a final state (cleared), or
// announced separately (blocked opens its own dialog before any move
// commits).
const NEXT_ACTOR: Partial<Record<keyof Board, string>> = {
  submitted: 'GM',
  verified: 'Founder',
};

// Columns that map directly to a task_status. `blocked` maps to nothing
// (it is derived from ops.task_blocks) and `this_week` maps to nothing
// yet (Phase 6). Dropping on either of those two is handled specially.
const COLUMN_STATUS: Partial<Record<keyof Board, string>> = {
  backlog: 'todo',
  in_progress: 'in_progress',
  submitted: 'submitted',
  verified: 'verified',
  cleared: 'cleared',
};

function pointsChip(t: Task) {
  const value = t.points_override ?? t.catalog_points;
  const cleared = t.status === 'cleared';
  const pending = t.status === 'submitted' || t.status === 'verified';
  return (
    <span
      className={cn(
        'num text-num-md inline-flex items-center gap-1',
        cleared && 'text-ink',
        pending && 'text-pending border-b border-dashed border-current',
        !cleared && !pending && 'text-ink-2'
      )}
    >
      {t.points_override != null ? (
        <span title={`Overridden: ${t.points_override}`}>
          <Pencil className="size-3" aria-hidden />
        </span>
      ) : null}
      {value ?? '—'}
    </span>
  );
}

function TaskCard({
  task,
  dragging,
  onFlagCancellation,
  onOpenNotes,
}: {
  task: Task;
  dragging?: boolean;
  onFlagCancellation?: (task: Task) => void;
  onOpenNotes?: (task: Task) => void;
}) {
  const pendingCancellation = task.status === 'pending_cancellation';
  // `disabled` strips dnd-kit's pointer/keyboard activators for us
  // (listeners come back `undefined`) and sets `aria-disabled` on its
  // own `attributes` object — the same mechanism DESIGN.md §7.3 asks
  // for, not a hand-rolled `onPointerDown` guard that could drift out of
  // sync with the real reason (the trigger refuses every transition off
  // `pending_cancellation` except the clearing founder's decision).
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: task.id,
    data: task,
    disabled: pendingCancellation,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${dragging ? 1.02 : 1})` }
    : undefined;
  const describedById = `pending-cancellation-${task.id}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      aria-roledescription={pendingCancellation ? 'task awaiting a cancellation decision' : 'draggable task card'}
      aria-describedby={pendingCancellation ? describedById : undefined}
      aria-label={
        pendingCancellation
          ? `${task.title}, flagged for cancellation, not draggable. Waiting on the clearing founder's decision.`
          : `${task.title}, ${task.points_override ?? task.catalog_points ?? 'unpriced'} points, owned by ${task.ownerName ?? 'unknown'}`
      }
      className={cn(
        'group relative flex flex-col gap-2 rounded-lg border p-3 text-left',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        pendingCancellation
          ? 'cursor-not-allowed border-dashed border-pending-border bg-pending-wash/70'
          : 'border-hairline bg-surface hover:border-[#CBD2E0]',
        dragging && 'shadow-drag opacity-90',
        !pendingCancellation && task.openBlockCount > 0 && 'bg-[repeating-linear-gradient(45deg,#EEF1F5,#EEF1F5_4px,#E4E9F0_4px,#E4E9F0_8px)]'
      )}
    >
      {pendingCancellation ? (
        <>
          {/* Screen-reader-only: the "why" behind aria-disabled, per DESIGN.md §7.3's requirement that the non-draggable state be explained, not just asserted. */}
          <span id={describedById} className="sr-only">
            This task cannot be dragged while a cancellation decision is pending with the clearing founder.
          </span>
          <span
            className="inline-flex w-fit items-center gap-1 rounded-xs border border-pending-border bg-white/70 px-1.5 py-0.5 text-micro text-pending"
            title={task.cancellation_reason ?? undefined}
          >
            <XOctagon className="size-3" aria-hidden />
            Awaiting cancellation decision
          </span>
        </>
      ) : null}
      {onFlagCancellation ? (
        <button
          type="button"
          title="Flag for cancellation"
          aria-label={`Flag "${task.title}" for cancellation`}
          // A pointerdown inside a dnd-kit draggable starts a drag after
          // the 6px activation distance -- stopping propagation here
          // keeps this button clickable without ever arming a drag.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onFlagCancellation(task);
          }}
          className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-sm text-ink-3 opacity-0 transition-opacity hover:bg-surface-2 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        >
          <XOctagon className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <span className="text-eyebrow text-ink-3">{task.ownerPosition ?? '—'}</span>
      <p className="line-clamp-2 text-strong text-ink">{task.title}</p>
      <div className="flex items-center justify-between">
        <div className="flex size-5 items-center justify-center rounded-full bg-navy-800 text-micro text-white">
          {(task.ownerName ?? '?').slice(0, 2).toUpperCase()}
        </div>
        <div className="flex items-center gap-3">
          {task.carry_over_count > 0 ? (
            <span className={cn('num text-num-xs flex items-center gap-1', task.carry_over_count >= 3 ? 'text-danger' : 'text-ink-3')}>
              <RotateCcw className="size-3" aria-hidden /> {task.carry_over_count}w
            </span>
          ) : null}
          {task.openBlockCount > 0 ? (
            <span className="num text-num-xs flex items-center gap-1 text-blocked">
              <Ban className="size-3" aria-hidden /> {task.openBlockCount}
            </span>
          ) : null}
          {onOpenNotes ? (
            <button
              type="button"
              title={`${task.noteCount} worklog note(s) — click to view or add`}
              aria-label={`Worklog for "${task.title}", ${task.noteCount} notes`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenNotes(task);
              }}
              className={cn(
                'num text-num-xs flex items-center gap-1 rounded-sm px-0.5 hover:bg-surface-2',
                task.noteCount > 0 ? 'text-ink-3' : 'text-hairline-strong opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
              )}
            >
              <MessageSquare className="size-3" aria-hidden /> {task.noteCount > 0 ? task.noteCount : ''}
            </button>
          ) : null}
          {pointsChip(task)}
        </div>
      </div>
    </div>
  );
}

function Column({
  id,
  label,
  droppable,
  tasks,
  onFlagCancellation,
  onOpenNotes,
}: {
  id: keyof Board;
  label: string;
  droppable: boolean;
  tasks: Task[];
  onFlagCancellation?: (task: Task) => void;
  onOpenNotes: (task: Task) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });
  const total = tasks.reduce((sum, t) => sum + (t.points_override ?? t.catalog_points ?? 0), 0);

  return (
    <div className="flex w-[288px] shrink-0 snap-start flex-col gap-2 rounded-xl bg-surface-2 p-2">
      <div className="flex items-center justify-between px-2 pb-1 pt-1">
        <div className="flex items-center gap-1.5 text-eyebrow text-ink-2">
          {id === 'blocked' ? <Ban className="size-3 text-blocked" aria-hidden /> : null}
          {id === 'cleared' ? <CheckCircle2 className="size-3 text-cleared" aria-hidden /> : null}
          {label}
          <span className="num text-num-xs rounded bg-surface-3 px-1.5 py-0.5 text-ink-3">{tasks.length}</span>
        </div>
        <span className="num text-num-sm text-ink-3">{total}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-[80px] flex-1 flex-col gap-2 rounded-lg p-0.5 transition-[background-color,box-shadow]',
          isOver && droppable && 'bg-[#F2F7FF] shadow-[inset_0_0_0_1px_#9CC2F7]',
          isOver && !droppable && 'shadow-[inset_0_0_0_1px_#CBD2E0]'
        )}
      >
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            onFlagCancellation={
              onFlagCancellation && !['cleared', 'cancelled', 'pending_cancellation'].includes(t.status)
                ? onFlagCancellation
                : undefined
            }
            onOpenNotes={onOpenNotes}
          />
        ))}
        {!tasks.length ? <p className="p-2 text-body-sm text-ink-3">Nothing here.</p> : null}
      </div>
    </div>
  );
}

// One column (288px) + its gap (12px), per DESIGN.md's column geometry
// in §7.3. dnd-kit's default keyboard coordinate getter moves the
// virtual pointer in small fixed pixel steps, which measured out at
// 15-18 ArrowRight presses to cross one column (defect #3) — defeating
// DESIGN.md:665's "hard requirement" that the board be operable from a
// keyboard on the shared display. One press now covers exactly one
// column, landing the pointer over the next column's droppable rect so
// `closestCenter` picks it up immediately.
const COLUMN_STEP = 300;
const ROW_STEP = 50;

const columnKeyboardCoordinateGetter: KeyboardCoordinateGetter = (event, { currentCoordinates }) => {
  switch (event.code) {
    case 'ArrowRight':
      return { ...currentCoordinates, x: currentCoordinates.x + COLUMN_STEP };
    case 'ArrowLeft':
      return { ...currentCoordinates, x: currentCoordinates.x - COLUMN_STEP };
    case 'ArrowDown':
      return { ...currentCoordinates, y: currentCoordinates.y + ROW_STEP };
    case 'ArrowUp':
      return { ...currentCoordinates, y: currentCoordinates.y - ROW_STEP };
    default:
      return undefined;
  }
};

export function BoardPage() {
  // The initial load goes through `useResource` so a dead API renders
  // the shared unreachable/error states instead of an infinite
  // "Loading…" (the exact defect Chan reproduced). Once the first load
  // succeeds, `board` becomes the local, optimistically-mutated copy
  // that drag-and-drop already depended on -- re-running the resource
  // loader on every move would flash the whole board back to skeletons
  // mid-drag, so post-move refreshes go through `silentRefresh` instead
  // and only fall back to a toast if they fail.
  const { me } = useAuth();
  const isOversight = me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin';
  const boardResource = useResource((signal) => api.get<Board>('/api/tasks/board', { signal }), []);
  const [board, setBoard] = React.useState<Board | null>(null);
  const [activeTask, setActiveTask] = React.useState<Task | null>(null);
  const [blockTarget, setBlockTarget] = React.useState<Task | null>(null);
  const [cancelTarget, setCancelTarget] = React.useState<Task | null>(null);
  const [notesTarget, setNotesTarget] = React.useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnKeyboardCoordinateGetter })
  );

  React.useEffect(() => {
    if (boardResource.status === 'ready' && boardResource.data) setBoard(boardResource.data);
  }, [boardResource.status, boardResource.data]);

  const load = React.useCallback(() => {
    api
      .get<Board>('/api/tasks/board')
      .then(setBoard)
      .catch(() => toast.error('Could not refresh the board'));
  }, []);

  const findColumn = (taskId: string): keyof Board | null => {
    if (!board) return null;
    for (const c of COLUMNS) if (board[c.id].some((t) => t.id === taskId)) return c.id;
    return null;
  };

  const announcements: Announcements = {
    onDragStart({ active }) {
      const t = active.data.current as Task | undefined;
      const from = findColumn(String(active.id));
      const fromLabel = COLUMNS.find((c) => c.id === from)?.label ?? 'the board';
      return `Picked up "${t?.title ?? 'task'}", ${t?.points_override ?? t?.catalog_points ?? 'unpriced'} points, from ${fromLabel}.`;
    },
    onDragOver({ over }) {
      if (!over) return 'No column under the cursor.';
      const label = COLUMNS.find((c) => c.id === over.id)?.label ?? String(over.id);
      return `Moving over ${label}.`;
    },
    onDragEnd({ over }) {
      if (!over) return 'Move cancelled, returned to its column.';
      const colId = over.id as keyof Board;
      const label = COLUMNS.find((c) => c.id === colId)?.label ?? String(over.id);
      const waitingOn = NEXT_ACTOR[colId];
      return `Moved to ${label}.${waitingOn ? ` Waiting on ${waitingOn}.` : ''}`;
    },
    onDragCancel({ active }) {
      const from = findColumn(String(active.id));
      const fromLabel = COLUMNS.find((c) => c.id === from)?.label ?? 'its column';
      return `Move cancelled, returned to ${fromLabel}.`;
    },
  };

  function handleDragStart(e: DragStartEvent) {
    setActiveTask((e.active.data.current as Task) ?? null);
  }

  async function moveTask(task: Task, to: keyof Board) {
    if (to === 'blocked') {
      setBlockTarget(task);
      return;
    }
    const status = COLUMN_STATUS[to];
    if (!status || status === task.status) return;

    // Optimistic move, per DESIGN.md §7.3 -- reverts on the server's own message.
    setBoard((b) => {
      if (!b) return b;
      const from = findColumn(task.id);
      if (!from) return b;
      const next: Board = { ...b, [from]: b[from].filter((t) => t.id !== task.id), [to]: [...b[to], { ...task, status }] };
      return next;
    });

    try {
      await api.post(`/api/tasks/${task.id}/status`, { to: status });
      load();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : 'The move was refused';
      toast.error(message);
      load();
    }
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveTask(null);
    const { active, over } = e;
    if (!over) return;
    const task = active.data.current as Task;
    void moveTask(task, over.id as keyof Board);
  }

  if (!board) {
    return (
      <div>
        <PageHeader title="Board" description="Drag to move. Every drop goes through the same check a button click would." />
        <ResourceView
          resource={boardResource}
          skeleton={
            <div className="flex gap-3 overflow-x-auto pb-4">
              {COLUMNS.map((c) => (
                <div key={c.id} className="w-[288px] shrink-0 rounded-xl bg-surface-2 p-2">
                  <SkeletonCards />
                </div>
              ))}
            </div>
          }
        >
          {() => null}
        </ResourceView>
      </div>
    );
  }

  const flaggedForCancellation = board.flagged ?? [];

  return (
    <div>
      <PageHeader title="Board" description="Drag to move. Every drop goes through the same check a button click would." />

      {flaggedForCancellation.length ? (
        <div className="mb-4 rounded-lg border border-danger-border bg-danger-wash px-4 py-3">
          <p className="mb-2 text-body-sm font-semibold text-ink">
            {flaggedForCancellation.length} flagged for cancellation — waiting on the clearing founder
          </p>
          <ul className="flex flex-col gap-1">
            {flaggedForCancellation.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 text-body-sm text-ink-2">
                <span className="truncate">
                  {t.title} <span className="text-ink-3">— {t.ownerName ?? 'unknown'}</span>
                </span>
                <a href="/queue" className="shrink-0 text-label text-brand-700 underline">
                  Decide in Approvals
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex snap-x snap-proximity gap-3 overflow-x-auto pb-4">
          {COLUMNS.map((c) => (
            <Column
              key={c.id}
              id={c.id}
              label={c.label}
              droppable={c.droppable}
              tasks={board[c.id]}
              onFlagCancellation={isOversight ? setCancelTarget : undefined}
              onOpenNotes={setNotesTarget}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }}>
          {activeTask ? <TaskCard task={activeTask} dragging /> : null}
        </DragOverlay>
      </DndContext>

      {blockTarget ? (
        <BlockDialog
          task={blockTarget}
          onClose={() => setBlockTarget(null)}
          onDone={() => {
            setBlockTarget(null);
            load();
          }}
        />
      ) : null}

      {cancelTarget ? (
        <FlagCancellationDialog
          task={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onDone={() => {
            setCancelTarget(null);
            load();
          }}
        />
      ) : null}

      {notesTarget ? (
        <TaskNotesDialog
          task={notesTarget}
          onClose={() => setNotesTarget(null)}
          onNoteAdded={load}
        />
      ) : null}
    </div>
  );
}

// The running worklog Chan asked for -- a task's narration, distinct
// from its `description`. Append-only server-side; this dialog only
// ever lists and posts, never edits or deletes a note.
function TaskNotesDialog({ task, onClose, onNoteAdded }: { task: Task; onClose: () => void; onNoteAdded: () => void }) {
  interface Note {
    id: string;
    body: string;
    created_at: string;
    authorName: string | null;
  }
  const [notes, setNotes] = React.useState<Note[] | null>(null);
  const [body, setBody] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const closed = task.status === 'cleared' || task.status === 'cancelled';

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
        {closed ? (
          <p className="text-body-sm text-ink-3">This task is closed — no new notes can be added.</p>
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
          {!closed ? (
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
function FlagCancellationDialog({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
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

function BlockDialog({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = React.useState<'task' | 'person' | 'external'>('external');
  const [external, setExternal] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/tasks/${task.id}/blocks`, {
        target,
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
          <Select value={target} onValueChange={(v) => setTarget(v as typeof target)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="external">An outside party (BOC, carrier, client…)</SelectItem>
              <SelectItem value="person">Someone on the team</SelectItem>
              <SelectItem value="task">Another task</SelectItem>
            </SelectContent>
          </Select>
          {target === 'external' ? (
            <input
              className="h-[34px] rounded-md border border-[#CBD2E0] px-[10px] text-body"
              placeholder="Who? e.g. Bureau of Customs"
              value={external}
              onChange={(e) => setExternal(e.target.value)}
            />
          ) : (
            <p className="text-body-sm text-ink-3">
              Picking who or which task is blocking this needs the roster/task picker — not built in this pass. Use "outside
              party" for now, or block from the task detail view once that lands.
            </p>
          )}
          <ReasonTextarea value={reason} onChange={setReason} placeholder="Why is this blocked?" />
          {error ? <p className="text-label text-danger">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={submitting}
            disabled={reason.trim().length < 10 || (target === 'external' && !external.trim())}
          >
            Declare block
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
