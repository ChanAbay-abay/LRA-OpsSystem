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
import { Ban, CheckCircle2, Pencil, RotateCcw } from 'lucide-react';
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
  ownerName: string | null;
  ownerPosition: string | null;
}

type Board = Record<
  'backlog' | 'this_week' | 'in_progress' | 'blocked' | 'submitted' | 'verified' | 'cleared',
  Task[]
>;

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

function TaskCard({ task, dragging }: { task: Task; dragging?: boolean }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: task.id, data: task });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${dragging ? 1.02 : 1})` }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      aria-roledescription="draggable task card"
      aria-label={`${task.title}, ${task.points_override ?? task.catalog_points ?? 'unpriced'} points, owned by ${task.ownerName ?? 'unknown'}`}
      className={cn(
        'relative flex flex-col gap-2 rounded-lg border border-hairline bg-surface p-3 text-left',
        'hover:border-[#CBD2E0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        dragging && 'shadow-drag opacity-90',
        task.openBlockCount > 0 && 'bg-[repeating-linear-gradient(45deg,#EEF1F5,#EEF1F5_4px,#E4E9F0_4px,#E4E9F0_8px)]'
      )}
    >
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
          {pointsChip(task)}
        </div>
      </div>
    </div>
  );
}

function Column({ id, label, droppable, tasks }: { id: keyof Board; label: string; droppable: boolean; tasks: Task[] }) {
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
          <TaskCard key={t.id} task={t} />
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
  const [board, setBoard] = React.useState<Board | null>(null);
  const [activeTask, setActiveTask] = React.useState<Task | null>(null);
  const [blockTarget, setBlockTarget] = React.useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnKeyboardCoordinateGetter })
  );

  const load = React.useCallback(() => {
    api.get<Board>('/api/tasks/board').then(setBoard).catch(() => toast.error('Could not load the board'));
  }, []);

  React.useEffect(() => load(), [load]);

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
        <p className="text-body-sm text-ink-3">Loading…</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Board" description="Drag to move. Every drop goes through the same check a button click would." />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex snap-x snap-proximity gap-3 overflow-x-auto pb-4">
          {COLUMNS.map((c) => (
            <Column key={c.id} id={c.id} label={c.label} droppable={c.droppable} tasks={board[c.id]} />
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
    </div>
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
