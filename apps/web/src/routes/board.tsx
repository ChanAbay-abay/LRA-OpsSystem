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
import {
  BlockDialog,
  FlagCancellationDialog,
  TaskDetailDialog,
  TaskNotesDialog,
} from '@/components/tasks/task-detail-dialog';
import { Button } from '@/components/ui/button';
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
} from '@/lib/task-permissions';
import { blockRelation, blockRelationLabel, initials, type BlockRelation, type Task } from '@/lib/task-types';

/**
 * One open `ops.task_blocks` row as `GET /api/blocks/open` returns it —
 * the raw row, no name enrichment. Only the four fields the board's
 * block caption reads are declared.
 */
interface OpenBlock {
  id: string;
  task_id: string;
  /** Which of the three block targets this row is — see `blockDisplayName` on the API side. */
  target: string;
  created_by: string;
  blocking_user_id: string | null;
  /**
   * Reachable from the UI since the block dialog gained its target
   * picker (2026-09-10). The board resolves this to a title from the
   * board payload it already holds -- see `blockNoteFor` -- rather than
   * asking the API for one.
   */
  blocking_task_id: string | null;
  blocking_external: string | null;
  created_at: string;
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
  blockNote,
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
  /**
   * Chan, 2026-09-10: "i want it to be more clear which tasks you're
   * blocking and which tasks you're not." A card in the Blocked column
   * used to give no hint which side of the block the reader is on. This
   * is the oldest open block's relationship, in words, from
   * `lib/task-types.ts` — one sentence, truncated, in the same place
   * and the same register as the `returned` card's rejection reason
   * directly above. No new card region and no new hue (DESIGN.md §5.4 /
   * §2.3): the accountability weight comes from `font-semibold` when
   * the block names THIS person.
   */
  blockNote?: { label: string; relation: BlockRelation } | null;
}) {
  const pendingCancellation = task.status === 'pending_cancellation';
  const returned = task.status === 'rejected';
  const locked = pendingCancellation || !draggable;
  // `disabled` strips dnd-kit's pointer/keyboard activators for us
  // (listeners come back `undefined`), which is exactly what DESIGN.md
  // §7.3 asks for — a locked card simply cannot be picked up. But
  // dnd-kit ALSO puts `aria-disabled="true"` on its own `attributes`
  // object for a disabled draggable, and that claim is false here: the
  // card stays fully readable and clickable (opening the task modal is
  // its primary read path). Announcing "disabled" to a screen reader for
  // something the same person can open and read is wrong on its own,
  // and it's also what made Playwright's `.click()` refuse to click the
  // card and time out (2026-09-10 regression pass's Major, disproved by
  // the orchestrator's own re-test with a genuine dispatched click). The
  // honest distinction already lives in `aria-roledescription` below
  // ("task card" vs "draggable task card"), so dnd-kit's own
  // `aria-disabled` is dropped rather than kept as a second, incorrect
  // claim about the same element.
  const { attributes: draggableAttributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: task,
    disabled: locked,
  });
  // `undefined` (not omitting the key) so React drops the attribute from
  // the DOM entirely rather than rendering `aria-disabled="false"`.
  const attributes = { ...draggableAttributes, 'aria-disabled': undefined };
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
      // The `contains` guard is not defensive — it fixes a reproduced
      // defect (2026-09-10, stack trace captured). `TaskCardMenuButton`
      // renders its Radix dropdown through `DropdownMenu.Portal`, and a
      // Radix portal moves the menu's DOM node to `document.body` while
      // leaving it a CHILD OF THIS CARD IN THE REACT TREE. React
      // dispatches synthetic events along the fiber tree, not the DOM
      // tree, so clicking "Declare a block" in that menu propagated up
      // to this `onClick` and opened the task modal ON TOP OF the block
      // dialog the menu item had just opened — inerting it.
      //
      // The trigger button's own `stopPropagation` cannot help: the click
      // that matters happens on the menu ITEM, in the portal, not on the
      // trigger. The right-click path never had the bug, which is what
      // isolated it: `TaskCardContextMenu` wraps this card from the
      // OUTSIDE, so its portal's fiber chain does not run through here.
      //
      // Comparing against the real DOM subtree is the fix that survives
      // any future portalled control placed inside a card, rather than a
      // per-menu patch: a click that did not physically happen inside
      // this card is not a click on this card.
      onClick={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        onOpenDetail?.(task);
      }}
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
            : `${task.title}, ${task.points_override ?? task.catalog_points ?? 'unpriced'} points, owned by ${task.ownerName ?? 'unknown'}.${blockNote ? ` ${blockNote.label}.` : ''} Enter to open.`
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
      {blockNote ? (
        <p
          className={cn(
            'truncate text-micro text-blocked',
            blockNote.relation === 'waiting-on-you' && 'font-semibold'
          )}
          title={blockNote.label}
        >
          {blockNote.label}
        </p>
      ) : null}
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
  blockNoteFor,
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
  /** The oldest open block's relationship for a task, in words. Null for a task with no open block. */
  blockNoteFor: (task: Task) => { label: string; relation: BlockRelation } | null;
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
      blockNote={blockNoteFor(t)}
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
  // Chan, 2026-09-10: "i want it to be more clear which tasks you're
  // blocking and which tasks you're not." The board payload carries an
  // open-block COUNT per card and nothing about WHO the block names, so
  // a card in Blocked could not say whether the reader was waiting or
  // being waited on. `GET /api/blocks/open` already exists and returns
  // every open block in one small read (a live board's open blocks are
  // a handful of rows), and `/api/members` resolves the named blocker's
  // display name -- both refreshed by `load()` alongside the board, so
  // resolving a block updates the caption without a reload.
  const [openBlocks, setOpenBlocks] = React.useState<OpenBlock[] | null>(null);
  const [nameByUser, setNameByUser] = React.useState<Map<string, string>>(() => new Map());
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

  const loadOpenBlocks = React.useCallback(() => {
    api
      .get<OpenBlock[]>('/api/blocks/open')
      .then(setOpenBlocks)
      .catch(() => {
        // A card without its block caption is the pre-2026-09-10 board:
        // still complete, just less specific. Not worth a second error
        // toast on top of the board's own.
      });
  }, []);

  const load = React.useCallback(() => {
    api
      .get<Board>('/api/tasks/board')
      .then(setBoard)
      .catch(() => toast.error('Could not refresh the board'));
    loadOpenBlocks();
  }, [loadOpenBlocks]);

  // The board's first paint comes from `boardResource`, not `load()`, so
  // the block captions need their own mount read. The roster is stable
  // for the length of a session and is read once, never on refresh.
  React.useEffect(() => {
    loadOpenBlocks();
    api
      .get<{ userId: string; name: string | null }[]>('/api/members')
      .then((members) => setNameByUser(new Map(members.filter((m) => m.name).map((m) => [m.userId, m.name!]))))
      .catch(() => {});
  }, [loadOpenBlocks]);

  // Every task the board is holding, by id -- the lookup a
  // `task`-target block's caption needs. Built from the payload already
  // on screen (`/api/tasks/board` is not week-scoped, so a blocking task
  // from another week is in here too) rather than from a second read.
  const titleByTask = React.useMemo(() => {
    const m = new Map<string, string>();
    if (!board) return m;
    for (const column of COLUMNS) for (const t of board[column.id]) m.set(t.id, t.title);
    return m;
  }, [board]);

  /**
   * The oldest open block on a task, in the words `lib/task-types.ts`
   * decides. Oldest rather than newest: if a task is stuck on two
   * things, the one it has been stuck on longest is the one that needs
   * chasing. The `Ban N` badge already carries how many there are.
   */
  const blockNoteFor = React.useCallback(
    (task: Task): { label: string; relation: BlockRelation } | null => {
      if (!openBlocks) return null;
      const mine = openBlocks
        .filter((b) => b.task_id === task.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const oldest = mine[0];
      if (!oldest) return null;
      const relation = blockRelation(oldest, me?.id);
      // The three targets, resolved from what this screen already has:
      // the roster read for a person, the board payload itself for a
      // blocking task (every task is in it -- `/api/tasks/board` is not
      // week-scoped -- so a task title costs no extra request), and the
      // row's own free text for an outside party.
      const blockingName =
        oldest.target === 'person'
          ? oldest.blocking_user_id
            ? (nameByUser.get(oldest.blocking_user_id) ?? null)
            : null
          : oldest.target === 'task'
            ? oldest.blocking_task_id
              ? (titleByTask.get(oldest.blocking_task_id) ?? null)
              : null
            : oldest.blocking_external;
      return { label: blockRelationLabel(relation, blockingName, oldest.target), relation };
    },
    [openBlocks, nameByUser, titleByTask, me?.id]
  );

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
              blockNoteFor={blockNoteFor}
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
