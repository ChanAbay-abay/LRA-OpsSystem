-- =====================================================================
-- LRA Ops :: the owner of a blocked task may resolve the block
--
-- DEFECT THIS CLOSES (Chan, 2026-09-10: "users cant unblock a task, fix
-- it"). `ops.task_blocks_update` has, since 20260909090300, granted the
-- resolve to exactly three identities: the block's `created_by`, its
-- named `blocking_user_id`, and `core.is_oversight()`. The board's
-- detail modal, meanwhile, has always shown its Resolve button to
-- `isOversight || task.owner_user_id = me`. Those two sets are
-- different in BOTH directions, and the mismatch is the bug:
--
--   * a task's OWNER who did not declare the block sees the button and
--     the database refuses the write -- the blocked column became a
--     dead end for the one person who actually has to get out of it;
--   * the staff member who DECLARED the block is allowed by RLS but
--     the UI never offered them the button at all.
--
-- The second half is a client fix (`apps/web/src/lib/task-permissions.ts`
-- gains `blockResolveRefusal()`, mirroring this policy). This migration
-- fixes the first half, in the database, where the authority actually
-- lives.
--
-- WHY THE OWNER IS A LEGITIMATE RESOLVER. A block is a statement about
-- someone ELSE'S task: "your work cannot move until this other thing
-- happens." The person who finds out first that the other thing HAS
-- happened is the owner of the blocked task -- they are the one sitting
-- in front of the work, waiting. The block's author has, by then,
-- usually moved on. Requiring the author or oversight to come back and
-- clear a condition the owner can see is satisfied does not protect
-- anything: `ops.task_blocks` is append-only in every direction that
-- matters (created_at immutable, resolved_at server-stamped and
-- immutable once set, 20260910160000), so a resolve is a recorded,
-- attributable act, not a way to make a block disappear. What it does
-- protect against is the owner being stuck.
--
-- SCOPE. This is ONE new branch on ONE policy. The policy body below is
-- otherwise reproduced verbatim from its current live definition
-- (20260910120100_core_read_only_accounts.sql, which added the
-- `not core.is_read_only()` wrapper on top of 20260910090000's
-- `core.caller_is_active()` guards) -- never an edit of an applied
-- migration. The new branch sits INSIDE that wrapper and carries
-- `core.caller_is_active()` like every other identity branch, so:
--   * a read-only founder still cannot resolve, even one who owns the
--     blocked task;
--   * a soft-deleted/deactivated owner still cannot resolve.
-- `using` and `with check` stay byte-identical to each other, as they
-- already were.
--
-- NO RECURSION. The new branch subselects `ops.tasks`, whose own SELECT
-- policy is `tasks_select: core.is_member('ops')` (20260909090300, never
-- redefined since -- verified by grep across every migration). It does
-- not reference `ops.task_blocks`, so evaluating this policy cannot
-- re-enter itself.
-- =====================================================================

drop policy task_blocks_update on ops.task_blocks;
create policy task_blocks_update on ops.task_blocks for update to authenticated
using (
  (
    (created_by = core.auth_user_id() and core.caller_is_active())
    or (blocking_user_id = core.auth_user_id() and core.caller_is_active())
    or core.is_oversight()
    -- NEW, and the whole of this migration: the owner of the blocked task.
    or (core.caller_is_active() and exists (
          select 1 from ops.tasks t
          where t.id = task_blocks.task_id
            and t.owner_user_id = core.auth_user_id()))
  )
  and not core.is_read_only()
)
with check (
  (
    (created_by = core.auth_user_id() and core.caller_is_active())
    or (blocking_user_id = core.auth_user_id() and core.caller_is_active())
    or core.is_oversight()
    -- NEW, and the whole of this migration: the owner of the blocked task.
    or (core.caller_is_active() and exists (
          select 1 from ops.tasks t
          where t.id = task_blocks.task_id
            and t.owner_user_id = core.auth_user_id()))
  )
  and not core.is_read_only()
);

comment on table ops.task_blocks is
  'Blocks are derived state, never a task status (PRD.md §3.2). Resolvable '
  'by the block''s creator, its named blocking user, the OWNER of the '
  'blocked task (20260910190000 -- the person actually waiting on it), or '
  'oversight; never by a read-only or deactivated account.';
