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
 * rule. A read-only account (`actor.readOnly`) gets no write items at
 * all — omitted, not shown-and-disabled: a menu entry with no live path
 * is worse than no entry.
 */
import type { LucideIcon } from 'lucide-react';
import { Ban, CheckCircle2, FolderOpen, Send, Undo2 } from 'lucide-react';
import { moveRefusal, type Actor, type MovableTask } from './task-permissions';

export interface TaskMenuItem {
  key: string;
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  /** Why it's disabled, verbatim from `moveRefusal` (or the equivalent block-resolve rule) — the item's title/tooltip. */
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
  const isOversight = actor?.authority === 'gm' || actor?.authority === 'founder' || actor?.authority === 'admin';
  // Mirrors `TaskDetailDialog`'s `canResolveBlock` exactly — resolving a
  // block isn't a column move, so `moveRefusal` has no entry for it, but
  // the rule is the one already enforced there: owner or oversight,
  // never a read-only account.
  const canResolveBlock = !!actor && !readOnly && (isOversight || actor.id === task.owner_user_id);

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
        items.push(
          item(
            'resolve-block',
            'Resolve a block',
            CheckCircle2,
            canResolveBlock ? null : 'Only the owner or a GM/founder can resolve a block.',
            () => handlers.onResolveBlock!(task)
          )
        );
      }
    }
  }

  if (handlers.onOpen) {
    items.push(item('open', 'Open task', FolderOpen, null, () => handlers.onOpen!(task)));
  }

  return items;
}
