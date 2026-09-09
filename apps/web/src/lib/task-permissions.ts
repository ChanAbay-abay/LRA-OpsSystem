/**
 * LRA Global Ops :: what THIS person may do with THIS task, per column
 *
 * A faithful client-side mirror of `ops.enforce_task_transition`
 * (supabase/migrations/20260909150300_ops_cancellation_approval.sql) —
 * and nothing more. The database is still the only enforcement: every
 * drop posts the same `POST /api/tasks/:id/status` a button would, and
 * an illegal one comes back refused with the trigger's own sentence.
 *
 * What this module buys is honesty *before* the drop. Chan's report:
 * "if a user moves a task on their own, it should automatically bring
 * the task back to the correct section if they don't have permission …
 * make sure it grays out the sections where they can't drop it." A card
 * that flies into a column and snaps back a moment later reads as a bug
 * even when it is the ladder working correctly. Columns the caller
 * cannot reach are dimmed and made undroppable for the duration of the
 * drag instead, so the refusal is visible before the mistake.
 *
 * Every refusal string here is written for the person reading it, but it
 * always corresponds 1:1 to a `raise exception` in the trigger. If the
 * two ever disagree the database wins and the user sees the server's
 * message via the toast in routes/board.tsx — a mirror that drifts
 * degrades to today's behaviour, it never grants anything.
 */

export type BoardColumn =
  | 'backlog'
  | 'this_week'
  | 'in_progress'
  | 'blocked'
  | 'submitted'
  | 'verified'
  | 'cleared';

/** Columns that map onto a real `ops.task_status`. `blocked` and `this_week` do not. */
export const COLUMN_STATUS: Partial<Record<BoardColumn, string>> = {
  backlog: 'todo',
  in_progress: 'in_progress',
  submitted: 'submitted',
  verified: 'verified',
  cleared: 'cleared',
};

export const COLUMN_LABEL: Record<BoardColumn, string> = {
  backlog: 'Backlog',
  this_week: 'This week',
  in_progress: 'In progress',
  blocked: 'Blocked',
  submitted: 'Submitted',
  verified: 'Verified',
  cleared: 'Cleared',
};

/** The minimum a task has to tell us for the ladder below to decide. */
export interface MovableTask {
  status: string;
  owner_user_id: string;
  ownerPosition: string | null;
  task_type_id: string | null;
  openBlockCount: number;
}

/** The minimum the caller has to be, from `useAuth().me`. */
export interface Actor {
  id: string;
  authority: 'staff' | 'gm' | 'founder' | 'admin';
  isClearingFounder: boolean;
  // Mirrors `core.users.read_only` / `core.is_read_only()`
  // (supabase/migrations/20260910120100_core_read_only_accounts.sql):
  // a strictly read-only founder account (ERC, DCA). Checked FIRST in
  // `moveRefusal`, ahead of the admin bypass, because that is where the
  // migration places `core.is_read_only()` in every write-path
  // predicate it touches — a read-only caller's own JWT always carries
  // authority, so the admin bypass would otherwise sail straight through.
  readOnly: boolean;
}

/**
 * `null` when the move is legal; otherwise the reason, in a sentence
 * meant to be read in a tooltip.
 */
export function moveRefusal(task: MovableTask, to: BoardColumn, actor: Actor | null): string | null {
  if (!actor) return 'You are not signed in.';

  // Checked before the admin bypass, exactly where the trigger checks
  // `core.is_read_only()` in every write-path predicate it touches.
  if (actor.readOnly) return 'Your account is read-only.';

  // The trigger's rule 1: admin bypasses the ladder unconditionally.
  if (actor.authority === 'admin') return null;

  const isOwner = task.owner_user_id === actor.id;
  const isGm = actor.authority === 'gm';
  const isFounder = actor.authority === 'founder';
  const isOversight = isGm || isFounder;

  if (task.status === 'pending_cancellation') {
    return 'This task is waiting on the clearing founder’s cancellation decision.';
  }
  if (task.status === 'cleared' || task.status === 'cancelled') {
    return `A ${task.status} task is closed and cannot be moved.`;
  }

  if (to === 'this_week') {
    return 'This week’s commitments are set in the Monday briefing, not on the board.';
  }

  // Declaring a block is open to any ops member (`task_blocks_insert`
  // grants `core.is_member('ops')`); the reason dialog is the real gate.
  if (to === 'blocked') {
    return task.openBlockCount > 0 ? 'This task is already blocked.' : null;
  }

  // A task with an unresolved block renders in Blocked no matter what
  // its status says, so moving it elsewhere would put the card straight
  // back where it came from on the next refresh. Resolve the block from
  // the task's detail view first.
  if (task.openBlockCount > 0) {
    return 'Resolve the block first — open the task to do that.';
  }

  const target = COLUMN_STATUS[to];
  if (!target) return `${COLUMN_LABEL[to]} is not a drop target.`;
  if (target === task.status) return null; // same place; the board treats it as a no-op

  switch (task.status) {
    case 'todo':
    case 'in_progress': {
      if (target === 'todo' || target === 'in_progress') {
        return isOwner || isOversight ? null : 'Only the task’s owner or a GM/founder can move it.';
      }
      if (target === 'submitted') {
        if (!isOwner && !isOversight) return 'Only the task’s owner or a GM/founder can submit it.';
        if (!task.task_type_id) return 'Give this task a catalog type before submitting it.';
        return null;
      }
      return `A task in ${task.status === 'todo' ? 'Backlog' : 'In progress'} can’t go straight to ${COLUMN_LABEL[to]}.`;
    }

    case 'submitted': {
      if (target === 'in_progress') {
        return isOwner || isGm ? null : 'Only the owner (retracting) or a GM can pull this back.';
      }
      if (target === 'verified') {
        if (isOwner) return 'You can’t verify your own task.';
        if (task.ownerPosition === 'gm') {
          return isFounder ? null : 'A GM’s own task has to be verified by a founder.';
        }
        return isGm ? null : 'Only a GM verifies a submitted task.';
      }
      if (target === 'cleared') return 'A task has to be verified before it can be cleared.';
      return 'Sending a submitted task back needs a written reason — do it from Approvals.';
    }

    case 'verified': {
      if (target === 'cleared') {
        return actor.isClearingFounder ? null : 'Only the clearing founder can clear a task.';
      }
      return 'A verified task can only be cleared here; sending it back needs a reason, from Approvals.';
    }

    case 'rejected': {
      if (target === 'todo') {
        return isOwner || isOversight ? null : 'Only the owner can rework a rejected task.';
      }
      return 'A rejected task goes back to Backlog to be reworked.';
    }

    default:
      return 'This task can’t be moved from here.';
  }
}

/**
 * `null` when at least one column would accept this task from this
 * person (so the card is draggable); otherwise the reason it is pinned
 * where it is, for the card's tooltip and `aria-describedby`.
 *
 * When every column refuses, the refusals are not equally informative —
 * "This week's commitments are set in the Monday briefing" is true of
 * every card and explains nothing about this one. Prefer a refusal that
 * is specific to the task's own situation.
 */
export function dragRefusal(task: MovableTask, columns: BoardColumn[], actor: Actor | null): string | null {
  const reasons: string[] = [];
  for (const c of columns) {
    // A column that maps to the status the task already holds is where
    // the card came from, not a destination. `moveRefusal` allows it (a
    // drop back into your own column is a legitimate no-op for anyone,
    // and toasting an error at someone for putting a card back would be
    // absurd) — but it must not be the reason a card LOOKS draggable to
    // a person who cannot actually take it anywhere.
    if (COLUMN_STATUS[c] === task.status) continue;
    const r = moveRefusal(task, c, actor);
    if (r === null) return null;
    reasons.push(r);
  }
  const generic = (r: string) => r.includes('Monday briefing') || r.includes('not a drop target');
  return reasons.find((r) => !generic(r)) ?? reasons[0] ?? null;
}

/** True when at least one column would accept this task from this person. */
export function canDragTask(task: MovableTask, columns: BoardColumn[], actor: Actor | null): boolean {
  return dragRefusal(task, columns, actor) === null;
}

/**
 * The exact sentence `ops.enforce_task_transition`'s guard 2b raises
 * (20260910140000_ops_task_edit_requests.sql), reproduced verbatim so the
 * UI never invents a second vocabulary for the same refusal. Once a
 * committed task's week has left `planning`, its definition — title,
 * description, catalog type, owner, client reference — is frozen for
 * everyone but a founder or admin. The trigger's exemption is
 * `core.is_founder()`, not `core.is_oversight()`: a GM is refused here
 * exactly like staff, on purpose — a GM's only path to change a locked
 * task's definition is a task edit request (PLAN.md §10.1).
 *
 * Progress — status, notes, blocks — is never affected by this guard and
 * this function says nothing about it; see `moveRefusal` for that ladder.
 */
export interface DefinitionLockable {
  is_committed: boolean;
}

export function definitionLockRefusal(
  task: DefinitionLockable,
  weekState: string | null | undefined,
  actor: Actor | null
): string | null {
  if (!task.is_committed) return null;
  if (weekState == null || weekState === 'planning') return null;
  // A read-only founder (ERC/DCA) never reaches the founder bypass: the
  // trigger's `core.is_read_only()` check (statement 0) refuses them
  // before guard 2b is ever evaluated, exactly like every other write.
  if (actor && !actor.readOnly && (actor.authority === 'founder' || actor.authority === 'admin')) return null;
  return (
    "a committed task's definition (title/description/type/owner/client reference) is locked " +
    'once the week has left planning; ask the GM to raise a task edit request'
  );
}
