/**
 * LRA Global Ops :: what a task card's quick-action menu offers
 *
 * PLAN.md §10 #2 (Chan, 2026-09-10): "tasks should have a quick submit
 * and block button with right click commands and a 3 dot option that
 * opens the same right click." This is the ONE function that decides
 * the menu's content and order — `components/tasks/task-card-menu.tsx`
 * renders it twice (once as a Radix context menu, once as a Radix
 * dropdown), but never decides anything on its own. Kept in `lib/`
 * rather than the component file, with no React/Radix import, so it can
 * be unit-tested the same direct way `task-permissions.test.ts` already
 * tests `moveRefusal` — no DOM, no alias resolution, no JSX.
 *
 * Every item's enabled state comes from `moveRefusal` — the same client
 * mirror of `ops.enforce_task_transition` the board's drag-and-drop
 * already dims columns with. Nothing here invents a looser or stricter
 * rule, and where the rule cannot be evaluated from a task alone —
 * "Resolve a block", which is decided per block — nothing is invented
 * either: the item carries no reason rather than a guessed one. A
 * read-only account (`actor.readOnly`) gets no write items at all —
 * omitted, not shown-and-disabled: a menu entry with no live path is
 * worse than no entry.
 */
import type { LucideIcon } from 'lucide-react';
import { Ban, CheckCircle2, FolderOpen, Send, Undo2 } from 'lucide-react';
import { moveRefusal, type Actor, type MovableTask } from './task-permissions';

export interface TaskMenuItem {
  key: string;
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  /** Why it's disabled, verbatim from `moveRefusal` — the item's title/tooltip. */
  reason?: string;
  onSelect: () => void;
}

export interface TaskMenuHandlers<T> {
  onSubmit?: (task: T) => void;
  onTakeBack?: (task: T) => void;
  onRework?: (task: T) => void;
  onDeclareBlock?: (task: T) => void;
  /** Offered only when the task has an open block; board.tsx resolves it directly when there's exactly one, otherwise opens the detail dialog. */
  onResolveBlock?: (task: T) => void;
  onOpen?: (task: T) => void;
}

function item(key: string, label: string, icon: LucideIcon, reason: string | null, onSelect: () => void): TaskMenuItem {
  return { key, label, icon, disabled: reason != null, reason: reason ?? undefined, onSelect };
}

/**
 * The single source of truth for a task card's menu — content and
 * order, shared by the context menu and the 3-dot dropdown. `task` only
 * needs the fields `moveRefusal` reads plus an `id`, so callers pass
 * their own richer task shape straight through without casting.
 */
export function buildTaskMenuItems<T extends MovableTask & { id: string }>(
  task: T,
  actor: Actor | null,
  handlers: TaskMenuHandlers<T>
): TaskMenuItem[] {
  const items: TaskMenuItem[] = [];
  const readOnly = actor?.readOnly ?? false;
  const closed = task.status === 'cleared' || task.status === 'cancelled';

  if (!readOnly) {
    if (handlers.onSubmit && (task.status === 'todo' || task.status === 'in_progress')) {
      const reason = moveRefusal(task, 'submitted', actor);
      items.push(item('submit', 'Submit for approval', Send, reason, () => handlers.onSubmit!(task)));
    }
    if (handlers.onTakeBack && task.status === 'submitted') {
      const reason = moveRefusal(task, 'in_progress', actor);
      items.push(item('take-back', 'Take it back', Undo2, reason, () => handlers.onTakeBack!(task)));
    }
    if (handlers.onRework && task.status === 'rejected') {
      const reason = moveRefusal(task, 'backlog', actor);
      items.push(item('rework', 'Rework it', Undo2, reason, () => handlers.onRework!(task)));
    }
    if (!closed && task.status !== 'pending_cancellation') {
      if (task.openBlockCount === 0) {
        if (handlers.onDeclareBlock) {
          const reason = moveRefusal(task, 'blocked', actor);
          items.push(item('block', 'Declare a block', Ban, reason, () => handlers.onDeclareBlock!(task)));
        }
      } else if (handlers.onResolveBlock) {
        // No refusal reason here, deliberately. Who may resolve a block is
        // decided per BLOCK, not per task: `blockResolveRefusal` grants the
        // block's `created_by`, the person its `blocking_user_id` names, the
        // task's owner, and oversight — four identities, mirroring the four
        // branches of `task_blocks_update` in
        // 20260910190000_ops_task_block_owner_resolves.sql. A card menu holds
        // a task and an `openBlockCount`; it does not hold the blocks, so it
        // cannot evaluate the two identity branches and cannot honestly
        // answer the question.
        //
        // It used to guess, with `isOversight || actor.id === owner_user_id`,
        // and the guess was wrong in the direction that costs the most: the
        // person who RAISED the block — always a legitimate resolver, and
        // usually the one who finds out first that it has cleared — was shown
        // a disabled item and a reason that was false. That is the same
        // second-opinion-not-a-mirror defect PLAN.md §11.1 describes, left
        // behind here when the dialog's copy of it was fixed.
        //
        // So the item stays enabled for anyone who is not read-only (the
        // `!readOnly` block above), and `quickResolveBlock` in board.tsx —
        // which fetches the blocks and therefore CAN be judged — surfaces the
        // server's own refusal in a toast if it comes to that. An honest
        // refusal after one click beats a false one before it.
        items.push(
          item('resolve-block', 'Resolve a block', CheckCircle2, null, () => handlers.onResolveBlock!(task))
        );
      }
    }
  }

  if (handlers.onOpen) {
    items.push(item('open', 'Open task', FolderOpen, null, () => handlers.onOpen!(task)));
  }

  return items;
}
