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
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
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
import {
  BOARD_COLUMN_IDS,
  BOARD_LANES,
  TAB_STORAGE_KEY,
  activeTabOf,
  columnFromDropId,
  columnPoints,
  countChipTitle,
  isTabDropId,
  laneDimRefusal,
  laneLabel,
  laneOf,
  matchesElsewhere,
  matchesElsewhereLabel,
  nextTabIndex,
  panelElementId,
  readStoredTabs,
  serializeTabs,
  tabDropId,
  tabElementId,
  type ActiveTabs,
  type BoardLane,
} from '@/lib/board-groups';

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

// The seven columns and the five lanes they render in both live in
// `lib/board-groups.ts` now (Chan, 2026-09-10: "i want you to group the
// columns. backlog and this week should be on the same column just on
// switchable tabs. verified and cleared should also work the same").
// Nothing about a column changed — `COLUMN_IDS` is still every column,
// flat, in board order, and it is still what `dragRefusal` is asked
// about.
const COLUMN_IDS = BOARD_COLUMN_IDS;

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

/** The 12px header icon a column carries, per DESIGN.md §5.5. Only these two. */
function columnIcon(id: BoardColumn) {
  if (id === 'blocked') return <Ban className="size-3 text-blocked" aria-hidden />;
  if (id === 'cleared') return <CheckCircle2 className="size-3 text-cleared" aria-hidden />;
  return null;
}

/**
 * One tab in a grouped lane's header — and, per the grouping contract's
 * item 1, its OWN drop target for its own column. The tab strip stays
 * visible and live during a drag, so a card can be dropped straight onto
 * "Cleared" without switching to it first.
 *
 * Dimming is decided here, per TAB, never by the lane (contract item 2):
 * `this_week` is never droppable, so a lane that dimmed whenever one of
 * its tabs refused would look dead on every drag Backlog would have
 * accepted. The refusal sentence is `moveRefusal`'s own — this component
 * receives it and never derives one, because a tab is a presentation of
 * an existing column and the permission mirror knows nothing about
 * groups.
 */
function LaneTab({
  column,
  droppable,
  selected,
  count,
  total,
  refusal,
  isDragging,
  index,
  onSelect,
  onKeyDown,
  registerRef,
}: {
  column: BoardColumn;
  droppable: boolean;
  selected: boolean;
  /** Cards visible in this tab under the current search + owner filter. */
  count: number;
  /** Cards in this tab ignoring the filter — the chip's tooltip discloses the difference. */
  total: number;
  /** Null when the dragged card may land in THIS column; otherwise why it may not. */
  refusal: string | null;
  isDragging: boolean;
  index: number;
  onSelect: (column: BoardColumn) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => void;
  registerRef: (index: number, node: HTMLButtonElement | null) => void;
}) {
  const dimmed = isDragging && refusal !== null;
  const { setNodeRef, isOver } = useDroppable({ id: tabDropId(column), disabled: dimmed || !droppable });
  const chipTitle = countChipTitle(count, total);

  return (
    <button
      ref={(node) => {
        setNodeRef(node);
        registerRef(index, node);
      }}
      type="button"
      role="tab"
      id={tabElementId(column)}
      // Only the selected panel is in the DOM (the inactive tab's cards
      // are not rendered), so the unselected tab's `aria-controls`
      // deliberately points at an id that appears when it is selected —
      // the ARIA APG's single-panel pattern.
      aria-controls={panelElementId(column)}
      aria-selected={selected}
      // Roving tabindex: one stop for the whole strip, arrows move within
      // it (contract item 7).
      tabIndex={selected ? 0 : -1}
      // During a drag this says only "you cannot drop here" — the tab is
      // still a working control and still switches on click, exactly as
      // the seven-column board's `aria-disabled` on a dimmed column meant
      // "no drops", not "inert".
      aria-disabled={dimmed || undefined}
      title={dimmed ? (refusal ?? undefined) : undefined}
      onClick={() => onSelect(column)}
      onKeyDown={(e) => onKeyDown(e, index)}
      className={cn(
        'flex h-[24px] shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-eyebrow',
        'transition-[background-color,color,box-shadow,opacity] duration-press ease',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        selected ? 'bg-surface text-ink' : 'text-ink-3 hover:bg-surface-3 hover:text-ink-2',
        // DESIGN.md §7.3's illegal-target cursor. The dimming itself is on
        // the inner span, not here — see below.
        dimmed && 'cursor-not-allowed',
        // The same two drop treatments the lane body uses (DESIGN.md
        // §7.3): a legal target fills and rings, an illegal one only rings.
        isOver && droppable && !dimmed && 'bg-[#F2F7FF] shadow-[inset_0_0_0_1px_#9CC2F7]',
        isOver && (!droppable || dimmed) && 'shadow-[inset_0_0_0_1px_#CBD2E0]'
      )}
    >
      {/*
        The dim lives on this inner span rather than on the button, and
        that is not cosmetic. Fading the whole button also fades the
        selected tab's white background, so mid-drag the tab that IS
        showing looked unselected while its bright sibling looked
        selected — reproduced in a screenshot on 2026-09-10, with the
        Plan lane showing This week's cards under a Backlog tab that read
        as active. Dimming only the content keeps "which tab am I looking
        at" true while still saying "not here" about the drop.
      */}
      <span className={cn('flex items-center gap-1.5', dimmed && 'opacity-40 saturate-50')}>
        {columnIcon(column)}
        {COLUMN_LABEL[column]}
        {/*
          Contract item 4: both tabs always show their own count. A tab may
          hide cards; it may never hide the existence of work. `--ink-2`, not
          `--ink-3`: DESIGN.md §12 measures `--ink-3` on `--surface-3` at
          4.47 and bans the pair outright.
        */}
        <span className="num text-num-xs rounded bg-surface-3 px-1.5 py-0.5 text-ink-2" title={chipTitle ?? undefined}>
          {count}
        </span>
      </span>
    </button>
  );
}

/**
 * The grouped lane's header: a real `tablist`, hand-rolled.
 *
 * **Why not `@radix-ui/react-tabs`** (contract item 7 asks which and
 * why): every tab header is a `useDroppable`, and Radix's `Trigger`
 * would have to reach that node through `asChild` + ref composition —
 * the same portal/`asChild` indirection that produced the reproduced
 * click defect this file already documents on the task card. What Radix
 * would buy is roving focus and arrow keys, which is `nextTabIndex` in
 * `lib/board-groups.ts` plus eight lines here, and is unit-tested there
 * rather than trusted. So: no new dependency, the droppable ref goes
 * straight onto the button, and the keyboard contract is pinned by a
 * test. `scoreboard/period-tabs.tsx` set the precedent for hand-rolling
 * a small selector in this app; the difference is that one is four
 * peers with `aria-pressed` and this one genuinely owns panels.
 *
 * Activation is automatic (arrow moves focus AND switches the panel),
 * which the APG allows because switching costs nothing here — the cards
 * are already in memory, no request, no skeleton.
 */
function LaneTabs({
  lane,
  activeTab,
  visibleCounts,
  totalCounts,
  isDragging,
  refusalFor,
  onSelectTab,
}: {
  lane: BoardLane;
  activeTab: BoardColumn;
  visibleCounts: Record<BoardColumn, number>;
  totalCounts: Record<BoardColumn, number>;
  isDragging: boolean;
  refusalFor: (column: BoardColumn) => string | null;
  onSelectTab: (column: BoardColumn) => void;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const registerRef = React.useCallback((index: number, node: HTMLButtonElement | null) => {
    refs.current[index] = node;
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextTabIndex(e.key, index, lane.tabs.length);
    // `null` for every key this strip does not own — Space in particular,
    // which is dnd-kit's pick-up key everywhere else on this board.
    if (next === null) return;
    e.preventDefault();
    onSelectTab(lane.tabs[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label={`${laneLabel(lane)} — pick a column`} className="flex items-center gap-0.5">
      {lane.tabs.map((tab, index) => (
        <LaneTab
          key={tab.id}
          column={tab.id}
          droppable={tab.droppable}
          selected={tab.id === activeTab}
          count={visibleCounts[tab.id]}
          total={totalCounts[tab.id]}
          refusal={refusalFor(tab.id)}
          isDragging={isDragging}
          index={index}
          onSelect={onSelectTab}
          onKeyDown={onKeyDown}
          registerRef={registerRef}
        />
      ))}
    </div>
  );
}

function Lane({
  lane,
  activeTab,
  visible,
  visibleCounts,
  totalCounts,
  filtering,
  meId,
  actor,
  weekStateById,
  isDragging,
  refusalFor,
  onSelectTab,
  menuHandlers,
  onFlagCancellation,
  onOpenNotes,
  onOpenDetail,
  blockNoteFor,
}: {
  lane: BoardLane;
  /** Which of this lane's columns is on show. Always the only one for a single-column lane. */
  activeTab: BoardColumn;
  /** The filtered cards, per column — the lane reads only its own tabs. */
  visible: Record<BoardColumn, Task[]>;
  visibleCounts: Record<BoardColumn, number>;
  totalCounts: Record<BoardColumn, number>;
  /** Whether a search or owner filter is on, which changes the sibling affordance's wording. */
  filtering: boolean;
  meId: string | undefined;
  actor: Actor | null;
  /** This task's week's `state` — the definition lock's other half, see `definitionLockRefusal`. */
  weekStateById: Map<string, string>;
  /** A drag is in flight somewhere on the board. */
  isDragging: boolean;
  /** `moveRefusal` for the dragged card against one column, or null when nothing is being dragged. */
  refusalFor: (column: BoardColumn) => string | null;
  onSelectTab: (column: BoardColumn) => void;
  menuHandlers: TaskMenuHandlers<Task>;
  onFlagCancellation?: (task: Task) => void;
  onOpenNotes: (task: Task) => void;
  onOpenDetail: (task: Task) => void;
  /** The oldest open block's relationship for a task, in words. Null for a task with no open block. */
  blockNoteFor: (task: Task) => { label: string; relation: BlockRelation } | null;
}) {
  const tasks = visible[activeTab];
  const droppable = lane.tabs.find((t) => t.id === activeTab)?.droppable ?? false;
  const dropRefusal = refusalFor(activeTab);
  const blocked = isDragging && dropRefusal !== null;
  // Contract item 2: the LANE only dims when every one of its tabs
  // refuses. `laneDimRefusal` is where that lives, and it is unit-tested,
  // because getting it wrong greys out the Plan lane on every drag.
  const laneDim = isDragging ? laneDimRefusal(lane, activeTab, refusalFor) : null;
  const { setNodeRef, isOver } = useDroppable({ id: activeTab, disabled: !droppable || blocked });
  const total = columnPoints(tasks);
  // Contract item 5, the sharpest hazard in the change: a match sitting
  // in the tab you cannot see is a task the reader concludes does not
  // exist. When the active tab has nothing and its sibling has something,
  // the empty body carries a control that switches — not a toast, not a
  // badge alone.
  const elsewhere = matchesElsewhere(lane, activeTab, visibleCounts);

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

  const chipTitle = countChipTitle(visibleCounts[activeTab], totalCounts[activeTab]);

  return (
    <section
      aria-label={laneLabel(lane)}
      className={cn(
        'flex w-column shrink-0 snap-start flex-col gap-2 rounded-xl bg-surface-2 p-2',
        'transition-opacity duration-fast',
        // Grayed out for the duration of a drag it cannot accept
        // (Chan's ask) — but for a grouped lane, only when BOTH tabs
        // refuse. `aria-disabled` says the same thing to a screen reader
        // that the dimming says to the eye.
        laneDim !== null && 'opacity-40 saturate-50'
      )}
      aria-disabled={laneDim !== null || undefined}
      title={laneDim ?? undefined}
    >
      {/*
        Fixed 28px header for every lane, tabbed or not, so the five lanes
        keep one card baseline. The tab strip REPLACES the label rather
        than sitting above it: DESIGN.md §11 says the board is dense and
        the contract says the strip is chrome that must not cost a card's
        worth of vertical space.
      */}
      <div
        className={cn(
          'flex h-[28px] items-center justify-between gap-2 pl-1 pr-2',
          // DESIGN.md §13's unimplemented requirement, now real: the header
          // stays put while its cards scroll under it. `-mx-2 px-3` cancels the
          // lane's own `p-2` so the sticky band spans the full lane width and
          // the opaque background covers a card scrolling beneath it; without
          // that the card's top edge shows through on either side. `z-10` sits
          // above the cards but below the drag overlay.
          'sticky top-0 z-10 -mx-2 -mt-2 bg-surface-2 px-3 pt-2'
        )}
      >
        {lane.group ? (
          <LaneTabs
            lane={lane}
            activeTab={activeTab}
            visibleCounts={visibleCounts}
            totalCounts={totalCounts}
            isDragging={isDragging}
            refusalFor={refusalFor}
            onSelectTab={onSelectTab}
          />
        ) : (
          <div className="flex items-center gap-1.5 pl-1 text-eyebrow text-ink-2">
            {columnIcon(activeTab)}
            {COLUMN_LABEL[activeTab]}
            <span
              className="num text-num-xs rounded bg-surface-3 px-1.5 py-0.5 text-ink-2"
              title={chipTitle ?? undefined}
            >
              {tasks.length}
            </span>
          </div>
        )}
        {/* The lane's point total follows the active tab, matching the old per-column total exactly. */}
        <span className="num text-num-sm text-ink-3">{total}</span>
      </div>
      <div
        ref={setNodeRef}
        id={panelElementId(activeTab)}
        role={lane.group ? 'tabpanel' : undefined}
        aria-labelledby={lane.group ? tabElementId(activeTab) : undefined}
        className={cn(
          'flex min-h-[80px] flex-1 flex-col gap-2 rounded-lg p-0.5 transition-[background-color,box-shadow]',
          isOver && droppable && !blocked && 'bg-[#F2F7FF] shadow-[inset_0_0_0_1px_#9CC2F7]',
          isOver && (!droppable || blocked) && 'shadow-[inset_0_0_0_1px_#CBD2E0]'
        )}
      >
        {/*
          Keyed on the active tab so switching crossfades the body — the
          most DESIGN.md §7.2 allows on a filter-like state change
          ("changed values crossfade opacity over 160ms, nothing moves").
          Nothing slides. Under `prefers-reduced-motion` index.css already
          collapses the duration to nothing.
        */}
        <div key={activeTab} className="flex flex-1 flex-col gap-2 animate-in fade-in-0 duration-fast">
          {mine.map(renderCard)}
          {mine.length > 0 && others.length > 0 ? (
            <div className="flex items-center gap-2 px-1 pt-1 text-micro text-ink-3">
              <span className="h-px flex-1 bg-hairline" aria-hidden />
              Everyone else
              <span className="h-px flex-1 bg-hairline" aria-hidden />
            </div>
          ) : null}
          {others.map(renderCard)}
          {!tasks.length ? (
            // DESIGN.md §8's empty column: dashed inset box, centred,
            // still a valid drop target (the highlight above is on the
            // droppable that wraps this, so it still lights up).
            <div className="m-1 flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline-strong px-2 py-6 text-center">
              <p className="text-body-sm text-ink-3">{filtering ? 'No matches here.' : 'No tasks.'}</p>
              {elsewhere ? (
                <button
                  type="button"
                  onClick={() => onSelectTab(elsewhere.column)}
                  aria-label={`Show ${COLUMN_LABEL[elsewhere.column]} — ${matchesElsewhereLabel(elsewhere, filtering)}`}
                  className="rounded-sm text-label text-brand-700 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {matchesElsewhereLabel(elsewhere, filtering)}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * Two kinds of drop target now exist, and they need different rules.
 *
 * A lane BODY is tall, so `closestCenter` — which measures the dragged
 * card's centre against each droppable's centre — is right for it: the
 * nearest lane wins even when the pointer is in the gutter between two.
 * A tab HEADER is 24px tall and sits directly above that body, so under
 * plain `closestCenter` a card dragged over the top of a lane could be
 * nearer the INACTIVE tab's centre than the tall body's, and land in a
 * column nobody was aiming at. So a tab header only wins when the
 * pointer is physically inside it (`pointerWithin`), and otherwise it is
 * excluded from the contest entirely.
 *
 * This is also what keeps contract item 8 true without extra code:
 * during a KEYBOARD drag there is no pointer, `pointerWithin` returns
 * nothing, and the virtual pointer can only ever reach the active tab's
 * body — which is the documented gap, not an accident. Reaching the
 * inactive tab mid-keyboard-drag is out of scope; the tab strip itself is
 * reachable by ordinary Tab + Arrow keys outside a drag.
 */
const boardCollisionDetection: CollisionDetection = (args) => {
  const onATab = pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => isTabDropId(String(c.id))),
  });
  if (onATab.length > 0) return onATab;
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => !isTabDropId(String(c.id))),
  });
};

// One column (288px) + its gap (12px), per DESIGN.md's column geometry
// in §7.3. dnd-kit's default keyboard coordinate getter moves the
// virtual pointer in small fixed pixel steps, which measured out at
// 15-18 ArrowRight presses to cross one column (defect #3) — defeating
// DESIGN.md:665's "hard requirement" that the board be operable from a
// keyboard on the shared display. One press now covers exactly one
// column, landing the pointer over the next column's droppable rect so
// `closestCenter` picks it up immediately.
//
// Unchanged by the five-lane grouping (contract item 8): a lane is still
// `w-column` (288px) with the same 12px gap, so one press still crosses
// exactly one lane. There are simply two fewer presses to cross the
// board.
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

  // Which tab each grouped lane is showing, remembered across reloads —
  // one key, one effect, exactly the idiom `OWNER_FILTER_KEY` above
  // established. `readStoredTabs` validates what comes back, because
  // storage can hold anything and an unrecognised column would leave a
  // lane rendering `undefined` tasks (contract item 6).
  const [activeTabs, setActiveTabs] = React.useState<ActiveTabs>(() =>
    readStoredTabs(localStorage.getItem(TAB_STORAGE_KEY))
  );

  React.useEffect(() => {
    localStorage.setItem(TAB_STORAGE_KEY, serializeTabs(activeTabs));
  }, [activeTabs]);

  /**
   * Show the tab that owns this column. Called by the tab strip, by the
   * "3 matches in Cleared" affordance, and — contract item 3 — by every
   * successful move, so a card can never land in a tab the person cannot
   * see. A card vanishing into a hidden tab is the same defect as a card
   * vanishing from the board.
   */
  const revealColumn = React.useCallback((column: BoardColumn) => {
    const lane = laneOf(column);
    if (!lane.group) return;
    const group = lane.group;
    setActiveTabs((prev) => (prev[group] === column ? prev : { ...prev, [group]: column }));
  }, []);

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
    for (const c of COLUMN_IDS) for (const t of board[c]) m.set(t.id, t.title);
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
    for (const c of COLUMN_IDS) if (board[c].some((t) => t.id === taskId)) return c;
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
      // `over.id` is either a lane body (the bare column id) or a tab
      // header (`tab:<column>`); both are the same move, so both resolve
      // through `columnFromDropId`.
      const colId = over ? columnFromDropId(String(over.id)) : null;
      if (!colId) return 'No column under the cursor.';
      const t = active.data.current as Task | undefined;
      const refusal = t ? moveRefusal(t, colId, actor) : null;
      return refusal ? `${COLUMN_LABEL[colId]}, not available. ${refusal}` : `Moving over ${COLUMN_LABEL[colId]}.`;
    },
    onDragEnd({ over }) {
      const colId = over ? columnFromDropId(String(over.id)) : null;
      if (!colId) return 'Move cancelled, returned to its column.';
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

    // Contract item 3, and the reason this sits in `moveTask` rather than
    // in `handleDragEnd`: the card menu moves cards too ("Send back for
    // rework" lands in Backlog), so putting the reveal on the drag path
    // alone would still let a menu action drop a card into a hidden tab.
    // Placed after the refusal check so a refused move never switches
    // tabs, and before the no-op check so a drop onto the tab a card is
    // already in still shows it.
    revealColumn(to);

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
    const to = columnFromDropId(String(over.id));
    if (!to) return;
    const task = active.data.current as Task;
    void moveTask(task, to);
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
        <ResourceView resource={boardResource} skeleton={<SkeletonBoard columns={BOARD_LANES.length} />}>
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
  // Per-column counts, filtered and unfiltered. Both are needed by every
  // tab, and this is the heart of contract item 5: a tab's chip shows the
  // FILTERED count (so it never promises cards the body won't render),
  // while the unfiltered count goes in the chip's tooltip so a filtered
  // zero can never be read as an empty column. The filtered counts are
  // also what `matchesElsewhere` answers from — offering to switch to a
  // tab that then renders empty would be the same lie in reverse.
  const visibleCounts = Object.fromEntries(COLUMN_IDS.map((c) => [c, visible[c].length])) as Record<
    BoardColumn,
    number
  >;
  const totalCounts = Object.fromEntries(COLUMN_IDS.map((c) => [c, board[c].length])) as Record<BoardColumn, number>;
  const totalVisible = COLUMN_IDS.reduce((n, c) => n + visibleCounts[c], 0);
  const totalAll = COLUMN_IDS.reduce((n, c) => n + totalCounts[c], 0);
  const filtering = ownerFilter !== 'all' || needle.length > 0;

  // The banner is the decision-maker's action surface, so it is theirs
  // alone (Chan, 2026-09-09). Staff still see every flagged card in its
  // own column, carrying its own "awaiting decision" chip.
  const flaggedForCancellation = isOversight ? (board.flagged ?? []) : [];

  return (
    /*
      DESIGN.md §13: "`overflow-x: auto` with the column headers sticky at
      `top: 0` inside each column". That was never implemented, and grouping
      made it bite harder -- a 29-card Cleared tab scrolls its own tab strip
      off the top of the screen, so the control you need in order to switch
      back is exactly the thing that disappears.
      `position: sticky` resolves against the nearest scroll container, so this
      only works if the lane scroller IS that container. `overflow-x: auto`
      already makes it one on both axes (per the overflow spec a non-`visible`
      overflow-x computes overflow-y to `auto`), but with an unbounded height it
      never actually scrolls vertically -- the page does, and a sticky header
      inside it slides away with its lane. So the board fills `<main>` and
      scrolls internally instead: `h-full` + flex column here, `flex-1 min-h-0`
      on the scroller below. `min-h-0` is load-bearing -- a flex child's default
      `min-height: auto` refuses to shrink below its content, which is the same
      trap app-shell.tsx already documents for `<main>` itself.
    */
    <div className="flex h-full flex-col">
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
        collisionDetection={boardCollisionDetection}
        accessibility={{ announcements }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setActiveTask(null);
          dragEndedAt.current = Date.now();
        }}
      >
        <div
          className="flex min-h-0 flex-1 snap-x snap-proximity gap-3 overflow-x-auto overflow-y-auto pb-4"
          aria-label="Task board"
        >
          {BOARD_LANES.map((lane) => (
            <Lane
              key={lane.id}
              lane={lane}
              activeTab={activeTabOf(lane, activeTabs)}
              visible={visible}
              visibleCounts={visibleCounts}
              totalCounts={totalCounts}
              filtering={filtering}
              meId={me?.id}
              actor={actor}
              weekStateById={weekStateById}
              isDragging={activeTask != null}
              // One `moveRefusal` per COLUMN, asked per tab. The mirror
              // has not learned about groups and must not: a tab is a
              // presentation of an existing column.
              refusalFor={(column) => (activeTask ? moveRefusal(activeTask, column, actor) : null)}
              onSelectTab={revealColumn}
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
