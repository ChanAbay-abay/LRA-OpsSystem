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
 * cancels) implements exactly that. Enter opens a card's detail view.
 *
 * "This week" is rendered read-only in this phase: it reflects
 * `is_committed`, and the commitment lock/briefing flow that actually
 * sets that flag lives on /briefing. Dropping into Blocked opens the
 * required block dialog before anything commits, per DESIGN.md §7.3.
 *
 * The board stays at Chan's decided seven columns (2026-09-09) — no
 * eighth `pending_cancellation` column. A task flagged for cancellation
 * instead stays rendered in the column its `pre_cancellation_status`
 * resolves to (the API does that placement) with a distinct "awaiting
 * decision" treatment reusing DESIGN.md's `--pending` semantic, and it
 * is not draggable.
 *
 * A `rejected` task follows the same principle: no eighth column, it
 * renders in Backlog with a "Returned" chip and its rejection reason on
 * the card. It used to map to no column at all, so work the GM or
 * founder sent back disappeared from its owner's board while still
 * counting against them (Chan, 2026-09-09: "make sure that returned
 * tasks can be seen on the list"). Every status a live task can hold now
 * resolves to a visible column — that is the invariant to preserve when
 * a status is next added.
 *
 * Three things Chan asked for on 2026-09-09, all of them about the
 * board telling the truth to the person in front of it:
 *
 *  1. The "flagged for cancellation" banner is an ACTION surface for
 *     the people who decide cancellations. Sales and Broker cannot
 *     decide one, so for them it is a to-do list they can't act on —
 *     and the flagged card is already visible in its own column with
 *     its own "awaiting decision" chip. Oversight only.
 *  2. Illegal drops are refused BEFORE the card moves, not after:
 *     `lib/task-permissions.ts` mirrors the DB ladder, columns this
 *     person can't reach are dimmed and undroppable for the duration
 *     of a drag, and a card they can't move anywhere isn't draggable.
 *     The server is still the enforcement; this is only honesty about
 *     what it will accept.
 *  3. Owner filtering, with the signed-in person's own tasks sorted to
 *     the top of every column and everyone else's below a divider.
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
import {
  Ban,
  CheckCircle2,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Undo2,
  Users,
  X,
  XOctagon,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/app-shell';
import { CreateTaskDialog } from '@/components/tasks/create-task-dialog';
import {
  TaskCardContextMenu,
  TaskCardMenuButton,
  buildTaskMenuItems,
  type TaskMenuHandlers,
} from '@/components/tasks/task-card-menu';
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
import { ResourceView, SkeletonBoard } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  COLUMN_LABEL,
  COLUMN_STATUS,
  definitionLockRefusal,
  dragRefusal,
  moveRefusal,
  type Actor,
  type BoardColumn,
  type MovableTask,
} from '@/lib/task-permissions';
import { buildFieldDiffs, type DiffResolvers, type TaskEditRequest } from '@/lib/task-edit-requests';

interface Task {
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

type Board = Record<BoardColumn, Task[]> & {
  // Not a column — the same flagged tasks that also sit in their real
  // column above, kept as a flat list so the banner doesn't have to scan
  // all seven columns to build itself.
  flagged: Task[];
};

const COLUMNS: { id: BoardColumn; droppable: boolean }[] = [
  { id: 'backlog', droppable: true },
  { id: 'this_week', droppable: false },
  { id: 'in_progress', droppable: true },
  { id: 'blocked', droppable: true },
  { id: 'submitted', droppable: true },
  { id: 'verified', droppable: true },
  { id: 'cleared', droppable: true },
];

const COLUMN_IDS = COLUMNS.map((c) => c.id);

// Who the task is now waiting on once it lands in a given column, for
// the keyboard drop announcement (DESIGN.md:663-664, defect #4). Only
// the two approval columns have a waiting party; everything else is
// either self-owned (backlog/in progress), a final state (cleared), or
// announced separately (blocked opens its own dialog before any move
// commits).
const NEXT_ACTOR: Partial<Record<BoardColumn, string>> = {
  submitted: 'GM',
  verified: 'Founder',
};

const OWNER_FILTER_KEY = 'lra.board.ownerFilter';

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

function initials(name: string | null) {
  return (name ?? '?').slice(0, 2).toUpperCase();
}

function TaskCard({
  task,
  dragging,
  draggable = true,
  pinnedReason,
  definitionLocked,
  actor,
  menuHandlers,
  onFlagCancellation,
  onOpenNotes,
  onOpenDetail,
}: {
  task: Task;
  dragging?: boolean;
  /** False when the permission mirror says no column would accept this card. */
  draggable?: boolean;
  /** Why not, for the tooltip and the screen-reader description. */
  pinnedReason?: string | null;
  /** True once this task is committed and its week has left `planning` (PLAN.md §10.1) — title/description/type/owner/client ref are frozen for everyone but a founder/admin. Progress (status/notes/blocks) is untouched; this is purely a face-value indicator, the modal is where it's explained. */
  definitionLocked?: boolean;
  /** Present on every real render; omitted only for the DragOverlay copy, which has no menu of its own. */
  actor?: Actor | null;
  menuHandlers?: TaskMenuHandlers<Task>;
  onFlagCancellation?: (task: Task) => void;
  onOpenNotes?: (task: Task) => void;
  onOpenDetail?: (task: Task) => void;
}) {
  const pendingCancellation = task.status === 'pending_cancellation';
  const returned = task.status === 'rejected';
  const locked = pendingCancellation || !draggable;
  // `disabled` strips dnd-kit's pointer/keyboard activators for us
  // (listeners come back `undefined`) and sets `aria-disabled` on its
  // own `attributes` object — the same mechanism DESIGN.md §7.3 asks
  // for, not a hand-rolled `onPointerDown` guard that could drift out of
  // sync with the real reason.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: task,
    disabled: locked,
  });
  // `transform` is deliberately NOT read. The card that follows the
  // pointer is the <DragOverlay> copy (`dragging`), and translating the
  // source card as well produced two moving cards plus a scroll jump:
  // a translated child still occupies its original box for layout but
  // extends the scroll container's scrollable area, so the browser
  // scrolled to keep the pointer's target in view. The source stays put
  // and dims; the overlay does the moving.
  const describedById = `locked-${task.id}`;
  const lockedReason = pendingCancellation
    ? 'This task cannot be dragged while a cancellation decision is pending with the clearing founder.'
    : pinnedReason;

  // The one place this card's menu items are decided — right-click and
  // the 3-dot button below both render this exact list, in this order.
  const menuItems = menuHandlers ? buildTaskMenuItems(task, actor ?? null, menuHandlers) : [];

  const card = (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail?.(task)}
      onKeyDown={(e) => {
        // Space is dnd-kit's pick-up key; Enter is ours, so the two
        // keyboard paths (move a card / read a card) never collide.
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpenDetail?.(task);
        }
      }}
      aria-roledescription={
        pendingCancellation ? 'task awaiting a cancellation decision' : locked ? 'task card' : 'draggable task card'
      }
      aria-describedby={locked && lockedReason ? describedById : undefined}
      title={locked && lockedReason ? lockedReason : undefined}
      aria-label={
        pendingCancellation
          ? `${task.title}, flagged for cancellation, not draggable. Waiting on the clearing founder's decision.`
          : returned
            ? `${task.title}, returned for rework${task.rejected_reason ? `: ${task.rejected_reason}` : ''}. Owned by ${task.ownerName ?? 'unknown'}. Enter to open.`
            : `${task.title}, ${task.points_override ?? task.catalog_points ?? 'unpriced'} points, owned by ${task.ownerName ?? 'unknown'}. Enter to open.`
      }
      className={cn(
        'group relative flex cursor-pointer flex-col gap-2 rounded-lg border p-3 text-left',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        pendingCancellation
          ? 'border-dashed border-pending-border bg-pending-wash/70'
          : returned
            ? 'border-danger-border bg-danger-wash/40 hover:border-danger'
            : 'border-hairline bg-surface hover:border-[#CBD2E0]',
        // `dragging` is the DragOverlay copy — the one under the
        // pointer. `isDragging` is the source it was lifted from, which
        // stays in place as a dimmed slot so the column keeps its shape.
        dragging && 'shadow-drag scale-[1.02] cursor-grabbing',
        isDragging && !dragging && 'opacity-40',
        !pendingCancellation && task.openBlockCount > 0 && 'bg-[repeating-linear-gradient(45deg,#EEF1F5,#EEF1F5_4px,#E4E9F0_4px,#E4E9F0_8px)]'
      )}
    >
      {locked && lockedReason ? (
        <span id={describedById} className="sr-only">
          {lockedReason}
        </span>
      ) : null}
      {pendingCancellation ? (
        <span
          className="inline-flex w-fit items-center gap-1 rounded-xs border border-pending-border bg-white/70 px-1.5 py-0.5 text-micro text-pending"
          title={task.cancellation_reason ?? undefined}
        >
          <XOctagon className="size-3" aria-hidden />
          Awaiting cancellation decision
        </span>
      ) : null}
      {/*
        A returned task sits in Backlog alongside work nobody has touched
        yet, so it has to say why it is there. The reason is shown on the
        card rather than hidden behind the modal: "it came back" and "what
        was wrong with it" are the same fact, and splitting them across
        two surfaces is how a rejection gets ignored.
      */}
      {returned ? (
        <span className="flex w-fit flex-col gap-0.5">
          <span className="inline-flex w-fit items-center gap-1 rounded-xs border border-danger-border bg-white/70 px-1.5 py-0.5 text-micro text-danger">
            <Undo2 className="size-3" aria-hidden />
            Returned
          </span>
          {task.rejected_reason ? (
            <span className="line-clamp-2 text-micro text-ink-2" title={task.rejected_reason}>
              {task.rejected_reason}
            </span>
          ) : null}
        </span>
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
        <div
          className="flex size-5 items-center justify-center rounded-full bg-navy-800 text-micro text-white"
          title={task.ownerName ?? undefined}
        >
          {initials(task.ownerName)}
        </div>
        <div className="flex items-center gap-3">
          {definitionLocked ? (
            <span
              className="flex items-center text-ink-3"
              title="This task's definition is locked for the week — status, notes and blocks are still open."
            >
              <Lock className="size-3" aria-hidden />
            </span>
          ) : null}
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
          {menuHandlers ? <TaskCardMenuButton items={menuItems} taskTitle={task.title} /> : null}
        </div>
      </div>
    </div>
  );

  // Right-click is the second trigger for the exact same menu the 3-dot
  // button opens (Chan's ask). Skipped for the DragOverlay copy, which
  // has no `menuHandlers` and isn't a real, interactive card.
  return menuHandlers ? <TaskCardContextMenu items={menuItems}>{card}</TaskCardContextMenu> : card;
}

function Column({
  id,
  droppable,
  tasks,
  meId,
  actor,
  weekStateById,
  isDragging,
  dropRefusal,
  menuHandlers,
  onFlagCancellation,
  onOpenNotes,
  onOpenDetail,
}: {
  id: BoardColumn;
  droppable: boolean;
  tasks: Task[];
  meId: string | undefined;
  actor: Actor | null;
  /** This task's week's `state` — the definition lock's other half, see `definitionLockRefusal`. */
  weekStateById: Map<string, string>;
  /** A drag is in flight somewhere on the board. */
  isDragging: boolean;
  /** Null when the dragged card may land here; otherwise why it may not. */
  dropRefusal: string | null;
  menuHandlers: TaskMenuHandlers<Task>;
  onFlagCancellation?: (task: Task) => void;
  onOpenNotes: (task: Task) => void;
  onOpenDetail: (task: Task) => void;
}) {
  const blocked = isDragging && dropRefusal !== null;
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable || blocked });
  const total = tasks.reduce((sum, t) => sum + (t.points_override ?? t.catalog_points ?? 0), 0);

  // Chan: "by default their tasks display first while everyone else'
  // shows below." Stable within each group — the API already returns
  // `created_at` ascending, and `filter` preserves that order.
  const mine = meId ? tasks.filter((t) => t.owner_user_id === meId) : [];
  const others = meId ? tasks.filter((t) => t.owner_user_id !== meId) : tasks;

  const renderCard = (t: Task) => {
    const pinned = dragRefusal(t, COLUMN_IDS, actor);
    const definitionLocked = definitionLockRefusal(t, weekStateById.get(t.week_id), actor) != null;
    return (
    <TaskCard
      key={t.id}
      task={t}
      draggable={pinned === null}
      pinnedReason={pinned}
      definitionLocked={definitionLocked}
      actor={actor}
      menuHandlers={menuHandlers}
      onFlagCancellation={
        onFlagCancellation && !['cleared', 'cancelled', 'pending_cancellation'].includes(t.status)
          ? onFlagCancellation
          : undefined
      }
      onOpenNotes={onOpenNotes}
      onOpenDetail={onOpenDetail}
    />
    );
  };

  return (
    <div
      className={cn(
        'flex w-column shrink-0 snap-start flex-col gap-2 rounded-xl bg-surface-2 p-2',
        'transition-opacity duration-fast',
        // Grayed out for the duration of a drag it cannot accept
        // (Chan's ask). `aria-disabled` says the same thing to a screen
        // reader that the dimming says to the eye.
        blocked && 'opacity-40 saturate-50'
      )}
      aria-disabled={blocked || undefined}
      title={blocked ? (dropRefusal ?? undefined) : undefined}
    >
      <div className="flex items-center justify-between px-2 pb-1 pt-1">
        <div className="flex items-center gap-1.5 text-eyebrow text-ink-2">
          {id === 'blocked' ? <Ban className="size-3 text-blocked" aria-hidden /> : null}
          {id === 'cleared' ? <CheckCircle2 className="size-3 text-cleared" aria-hidden /> : null}
          {COLUMN_LABEL[id]}
          <span className="num text-num-xs rounded bg-surface-3 px-1.5 py-0.5 text-ink-3">{tasks.length}</span>
        </div>
        <span className="num text-num-sm text-ink-3">{total}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-[80px] flex-1 flex-col gap-2 rounded-lg p-0.5 transition-[background-color,box-shadow]',
          isOver && droppable && !blocked && 'bg-[#F2F7FF] shadow-[inset_0_0_0_1px_#9CC2F7]',
          isOver && (!droppable || blocked) && 'shadow-[inset_0_0_0_1px_#CBD2E0]'
        )}
      >
        {mine.map(renderCard)}
        {mine.length > 0 && others.length > 0 ? (
          <div className="flex items-center gap-2 px-1 pt-1 text-micro text-ink-3">
            <span className="h-px flex-1 bg-hairline" aria-hidden />
            Everyone else
            <span className="h-px flex-1 bg-hairline" aria-hidden />
          </div>
        ) : null}
        {others.map(renderCard)}
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
  // mid-drag, so post-move refreshes go through `load()` instead
  // and only fall back to a toast if they fail.
  const { me } = useAuth();
  const isOversight = me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin';
  // ERC / DCA: read exactly what oversight reads, write nothing. The
  // "flag for cancellation" affordance is oversight-only to begin with
  // (Chan, 2026-09-09), so a read-only oversight account gets the same
  // "stays blank" treatment a non-oversight account already gets --
  // there is precedent for absence here, not a disabled control.
  const canWrite = !me?.readOnly;
  const actor: Actor | null = me
    ? { id: me.id, authority: me.authority, isClearingFounder: me.isClearingFounder, readOnly: me.readOnly }
    : null;

  const boardResource = useResource((signal) => api.get<Board>('/api/tasks/board', { signal }), []);
  const [board, setBoard] = React.useState<Board | null>(null);
  // The definition lock (PLAN.md §10.1) fires on a task's WEEK leaving
  // `planning`, and the board's own task rows carry no week state --
  // `week_id` only. A dozen recent weeks is comfortably enough to cover
  // every task a live board can show (nothing here holds a week open
  // past its own close), so one small fetch beats joining week state
  // into every task row server-side for a UI-only concern.
  const weeksResource = useResource(
    (signal) => api.get<{ id: string; state: string }[]>('/api/weeks?limit=12', { signal }),
    []
  );
  const weekStateById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const w of weeksResource.data ?? []) m.set(w.id, w.state);
    return m;
  }, [weeksResource.data]);
  const [activeTask, setActiveTask] = React.useState<Task | null>(null);
  const [blockTarget, setBlockTarget] = React.useState<Task | null>(null);
  const [cancelTarget, setCancelTarget] = React.useState<Task | null>(null);
  const [notesTarget, setNotesTarget] = React.useState<Task | null>(null);
  const [detailTarget, setDetailTarget] = React.useState<Task | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const [ownerFilter, setOwnerFilter] = React.useState<string>(
    () => localStorage.getItem(OWNER_FILTER_KEY) ?? 'all'
  );
  const [search, setSearch] = React.useState('');

  React.useEffect(() => {
    localStorage.setItem(OWNER_FILTER_KEY, ownerFilter);
  }, [ownerFilter]);

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

  // Keep the open detail dialog in step with the board it came from, so
  // a note added or a block resolved inside it doesn't leave the dialog
  // showing a snapshot the board has already moved past.
  React.useEffect(() => {
    if (!detailTarget || !board) return;
    const fresh = COLUMN_IDS.flatMap((c) => board[c]).find((t) => t.id === detailTarget.id);
    if (fresh && fresh !== detailTarget) setDetailTarget(fresh);
  }, [board, detailTarget]);

  const findColumn = (taskId: string): BoardColumn | null => {
    if (!board) return null;
    for (const c of COLUMNS) if (board[c.id].some((t) => t.id === taskId)) return c.id;
    return null;
  };

  const announcements: Announcements = {
    onDragStart({ active }) {
      const t = active.data.current as Task | undefined;
      const from = findColumn(String(active.id));
      const fromLabel = from ? COLUMN_LABEL[from] : 'the board';
      return `Picked up "${t?.title ?? 'task'}", ${t?.points_override ?? t?.catalog_points ?? 'unpriced'} points, from ${fromLabel}.`;
    },
    onDragOver({ active, over }) {
      if (!over) return 'No column under the cursor.';
      const colId = over.id as BoardColumn;
      const t = active.data.current as Task | undefined;
      const refusal = t ? moveRefusal(t, colId, actor) : null;
      return refusal ? `${COLUMN_LABEL[colId]}, not available. ${refusal}` : `Moving over ${COLUMN_LABEL[colId]}.`;
    },
    onDragEnd({ over }) {
      if (!over) return 'Move cancelled, returned to its column.';
      const colId = over.id as BoardColumn;
      const waitingOn = NEXT_ACTOR[colId];
      return `Moved to ${COLUMN_LABEL[colId]}.${waitingOn ? ` Waiting on ${waitingOn}.` : ''}`;
    },
    onDragCancel({ active }) {
      const from = findColumn(String(active.id));
      return `Move cancelled, returned to ${from ? COLUMN_LABEL[from] : 'its column'}.`;
    },
  };

  // A pointer drag ends with a `click` on the card it started from, so
  // without this every completed drag would also pop the detail dialog
  // open on top of the board the user just rearranged.
  const dragEndedAt = React.useRef(0);
  function openDetail(t: Task) {
    if (Date.now() - dragEndedAt.current < 250) return;
    setDetailTarget(t);
  }

  function handleDragStart(e: DragStartEvent) {
    setActiveTask((e.active.data.current as Task) ?? null);
  }

  async function moveTask(task: Task, to: BoardColumn) {
    // The same mirror the columns were dimmed with. A drop can still
    // reach here from the keyboard path, so refuse it in words rather
    // than starting an optimistic move the server will undo.
    const refusal = moveRefusal(task, to, actor);
    if (refusal) {
      toast.error(refusal);
      return;
    }

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
      // A status change can resolve to the SAME visual column it started
      // in -- e.g. a `rejected` task (renders in Backlog) legally moving
      // to `todo` (also Backlog) on rework, or the drop simply landing
      // back near its own column. Spreading `[from]: …filter…` and then
      // `[to]: [...b[to], …]` in one object literal is safe when they're
      // different keys, but when `from === to` the second assignment
      // reads `b[to]` -- the ORIGINAL, unfiltered array -- and appends
      // the updated task on top of it, duplicating the card on screen
      // and inflating the column's point total. Reproduced: dragging a
      // Returned task toward a disabled column resolved onto Backlog,
      // its own column, and doubled it. Same-column updates go through
      // `map`, never `filter` + append.
      if (from === to) {
        return { ...b, [from]: b[from].map((t) => (t.id === task.id ? { ...t, status } : t)) };
      }
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

  // The card menu's "Resolve a block" quick action. Unlike the detail
  // dialog, the card doesn't have the task's blocks loaded, so this
  // fetches them first. One open block resolves immediately, the same
  // `POST /api/blocks/:id/resolve` the dialog's Resolve button calls;
  // more than one is ambiguous from a flat menu item, so it opens the
  // detail dialog instead of guessing which block was meant.
  async function quickResolveBlock(task: Task) {
    try {
      const blocks = await api.get<{ id: string; resolved_at: string | null }[]>(`/api/tasks/${task.id}/blocks`);
      const open = blocks.filter((b) => !b.resolved_at);
      if (open.length === 1) {
        await api.post(`/api/blocks/${open[0].id}/resolve`);
        toast.success('Block resolved.');
        load();
      } else if (open.length > 1) {
        toast.warning('This task has more than one open block — resolve them from the task detail.');
        openDetail(task);
      } else {
        load();
      }
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not resolve the block');
    }
  }

  // The one place a task card's menu handlers are wired up. Every action
  // goes through `moveTask` — the same optimistic move + refusal-toast
  // path the board's drag-and-drop already uses — so the card menu is a
  // second trigger for the same code, never a second ladder.
  const menuHandlers: TaskMenuHandlers<Task> = {
    onSubmit: (t) => void moveTask(t, 'submitted'),
    onTakeBack: (t) => void moveTask(t, 'in_progress'),
    onRework: (t) => void moveTask(t, 'backlog'),
    onDeclareBlock: (t) => void moveTask(t, 'blocked'),
    onResolveBlock: (t) => void quickResolveBlock(t),
    onOpen: (t) => openDetail(t),
  };

  function handleDragEnd(e: DragEndEvent) {
    setActiveTask(null);
    dragEndedAt.current = Date.now();
    const { active, over } = e;
    if (!over) return;
    const task = active.data.current as Task;
    void moveTask(task, over.id as BoardColumn);
  }

  if (!board) {
    return (
      <div>
        <PageHeader
          title="Board"
          description="Drag to move. Every drop goes through the same check a button click would."
          actions={
            <Button
              onClick={() => setCreateOpen(true)}
              disabled={me?.readOnly}
              title={me?.readOnly ? 'Your account is read-only.' : undefined}
            >
              <Plus className="size-3.5" aria-hidden />
              New task
            </Button>
          }
        />
        <ResourceView resource={boardResource} skeleton={<SkeletonBoard columns={COLUMNS.length} />}>
          {() => null}
        </ResourceView>
        {createOpen ? (
          <CreateTaskDialog onClose={() => setCreateOpen(false)} onCreated={load} />
        ) : null}
      </div>
    );
  }

  // Everyone who owns at least one card, for the filter. Built from the
  // board itself rather than a second roster request — a person with no
  // tasks this week has nothing to filter to.
  const people = new Map<string, { name: string; position: string | null }>();
  for (const c of COLUMN_IDS) {
    for (const t of board[c]) {
      if (!people.has(t.owner_user_id)) {
        people.set(t.owner_user_id, { name: t.ownerName ?? 'Unknown', position: t.ownerPosition });
      }
    }
  }

  const needle = search.trim().toLowerCase();
  const matches = (t: Task) => {
    if (ownerFilter === 'mine' && t.owner_user_id !== me?.id) return false;
    if (ownerFilter !== 'mine' && ownerFilter !== 'all' && t.owner_user_id !== ownerFilter) return false;
    if (!needle) return true;
    return (
      t.title.toLowerCase().includes(needle) ||
      (t.ownerName ?? '').toLowerCase().includes(needle) ||
      (t.client_ref ?? '').toLowerCase().includes(needle)
    );
  };

  const visible = Object.fromEntries(COLUMN_IDS.map((c) => [c, board[c].filter(matches)])) as Record<
    BoardColumn,
    Task[]
  >;
  const totalVisible = COLUMN_IDS.reduce((n, c) => n + visible[c].length, 0);
  const totalAll = COLUMN_IDS.reduce((n, c) => n + board[c].length, 0);
  const filtering = ownerFilter !== 'all' || needle.length > 0;

  // The banner is the decision-maker's action surface, so it is theirs
  // alone (Chan, 2026-09-09). Staff still see every flagged card in its
  // own column, carrying its own "awaiting decision" chip.
  const flaggedForCancellation = isOversight ? (board.flagged ?? []) : [];

  return (
    <div>
      <PageHeader
        title="Board"
        description="Drag to move. Every drop goes through the same check a button click would."
        actions={
          <Button
            onClick={() => setCreateOpen(true)}
            disabled={me?.readOnly}
            title={me?.readOnly ? 'Your account is read-only.' : undefined}
          >
            <Plus className="size-3.5" aria-hidden />
            New task
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, owner, client ref…"
            aria-label="Search the board"
            className="h-[34px] w-[260px] rounded-md border border-hairline-strong bg-surface pl-8 pr-2 text-body text-ink placeholder:text-ink-3 focus-visible:border-brand-600 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-100"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <Users className="size-3.5 text-ink-3" aria-hidden />
          <Select value={ownerFilter} onValueChange={setOwnerFilter}>
            <SelectTrigger className="w-[200px]" aria-label="Filter by owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everyone</SelectItem>
              {me ? <SelectItem value="mine">Just my tasks</SelectItem> : null}
              {[...people.entries()]
                .filter(([id]) => id !== me?.id)
                .map(([id, p]) => (
                  <SelectItem key={id} value={id}>
                    {p.name}
                    {p.position ? ` · ${p.position}` : ''}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        {filtering ? (
          <>
            <span className="num text-num-xs text-ink-3">
              {totalVisible} of {totalAll}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setOwnerFilter('all');
                setSearch('');
              }}
            >
              <X className="size-3.5" aria-hidden />
              Clear
            </Button>
          </>
        ) : (
          <span className="text-body-sm text-ink-3">Your tasks sort to the top of every column.</span>
        )}
      </div>

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
        onDragCancel={() => {
          setActiveTask(null);
          dragEndedAt.current = Date.now();
        }}
      >
        <div className="flex snap-x snap-proximity gap-3 overflow-x-auto pb-4">
          {COLUMNS.map((c) => (
            <Column
              key={c.id}
              id={c.id}
              droppable={c.droppable}
              tasks={visible[c.id]}
              meId={me?.id}
              actor={actor}
              weekStateById={weekStateById}
              isDragging={activeTask != null}
              dropRefusal={activeTask ? moveRefusal(activeTask, c.id, actor) : null}
              menuHandlers={menuHandlers}
              onFlagCancellation={isOversight && canWrite ? setCancelTarget : undefined}
              onOpenNotes={setNotesTarget}
              onOpenDetail={openDetail}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }}>
          {activeTask ? <TaskCard task={activeTask} dragging /> : null}
        </DragOverlay>
      </DndContext>

      {detailTarget ? (
        <TaskDetailDialog
          task={detailTarget}
          weekState={weekStateById.get(detailTarget.week_id) ?? null}
          onClose={() => setDetailTarget(null)}
          onChanged={load}
          onFlagCancellation={isOversight && canWrite ? (t) => setCancelTarget(t) : undefined}
          onDeclareBlock={(t) => setBlockTarget(t)}
        />
      ) : null}

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

      {createOpen ? (
        <CreateTaskDialog onClose={() => setCreateOpen(false)} onCreated={load} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// Task detail
// ---------------------------------------------------------------------

interface Note {
  id: string;
  body: string;
  created_at: string;
  authorName: string | null;
}

interface TaskBlock {
  id: string;
  target: string;
  reason: string;
  created_at: string;
  resolved_at: string | null;
  blockingName: string | null;
  createdByName: string | null;
  resolvedByName: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  todo: 'Backlog',
  in_progress: 'In progress',
  submitted: 'Submitted',
  verified: 'Verified',
  cleared: 'Cleared',
  rejected: 'Returned',
  cancelled: 'Cancelled',
  pending_cancellation: 'Awaiting cancellation decision',
};

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

function statusTone(status: string) {
  if (status === 'cleared') return 'cleared' as const;
  if (status === 'submitted' || status === 'verified') return 'pending' as const;
  if (status === 'rejected' || status === 'cancelled' || status === 'pending_cancellation') return 'danger' as const;
  return 'neutral' as const;
}

function StatusChip({ status }: { status: string }) {
  return <Chip tone={statusTone(status)}>{STATUS_LABEL[status] ?? status}</Chip>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-eyebrow text-ink-3">{label}</p>
      <div className="mt-0.5 text-body-sm text-ink">{children}</div>
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
function TaskDetailDialog({
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
  const isOversight = me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin';
  const readOnly = me?.readOnly ?? false;
  const canResolveBlock = (isOversight || task.owner_user_id === me?.id) && !readOnly;

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
  const [requestingChange, setRequestingChange] = React.useState(false);
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
          {openBlocks.length > 0 ? (
            <Chip tone="danger">
              <Ban className="size-3 shrink-0" aria-hidden />
              Blocked
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
              {blocks.map((b) => (
                <li
                  key={b.id}
                  className={cn(
                    'flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-body-sm',
                    b.resolved_at ? 'border-hairline bg-surface-2 text-ink-3' : 'border-blocked-border bg-blocked-wash'
                  )}
                >
                  <div>
                    <p className={b.resolved_at ? 'text-ink-3' : 'text-ink'}>
                      {b.blockingName ?? 'Unknown'} — {b.reason}
                    </p>
                    <p className="text-micro text-ink-3">
                      raised by {b.createdByName ?? 'unknown'} · {new Date(b.created_at).toLocaleString()}
                      {b.resolved_at ? ` · resolved by ${b.resolvedByName ?? 'unknown'}` : ''}
                    </p>
                  </div>
                  {!b.resolved_at && canResolveBlock ? (
                    <Button variant="secondary" size="sm" onClick={() => resolveBlock(b.id)}>
                      Resolve
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

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

        {closed ? (
          <p className="shrink-0 text-body-sm text-ink-3">This task is closed — the record is frozen and takes no new notes.</p>
        ) : readOnly ? (
          <p className="shrink-0 text-body-sm text-ink-3">Your account is read-only — notes cannot be added.</p>
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
          {!closed && !readOnly ? (
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
    </>
  );
}

// The running worklog Chan asked for -- a task's narration, distinct
// from its `description`. Append-only server-side; this dialog only
// ever lists and posts, never edits or deletes a note. Reached from the
// card's note-count button, which is the "jump straight to the
// conversation" path; the full detail dialog above contains the same
// worklog in its wider context.
function TaskNotesDialog({ task, onClose, onNoteAdded }: { task: Task; onClose: () => void; onNoteAdded: () => void }) {
  const { me } = useAuth();
  const [notes, setNotes] = React.useState<Note[] | null>(null);
  const [body, setBody] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const closed = task.status === 'cleared' || task.status === 'cancelled';
  const readOnly = me?.readOnly ?? false;

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
        ) : readOnly ? (
          <p className="text-body-sm text-ink-3">Your account is read-only — notes cannot be added.</p>
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
          {!closed && !readOnly ? (
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
