/**
 * LRA Global Ops :: /api/task-edit-batches
 *
 * Chan, 2026-09-10: "GM can send a request to edit (should be done by
 * bulk like an edit feature on google docs), then approve by admin or
 * founder showing what changed like before and after".
 *
 * A bulk edit suggestion is ONE `ops.task_edit_batches` row (the single
 * summary note) owning N ordinary `ops.task_edit_requests` children —
 * the same typed proposals the single-request path already uses, so the
 * before/after Chan asked for is the one that already exists and the web
 * app renders both with the same `components/tasks/edit-request-diff.tsx`.
 * `20260910200000_ops_task_edit_batches.sql` is the real enforcement; as
 * in `routes/task-edit-requests.ts`, every guard in this file is
 * convenience only — a nicer 400/403 before the round trip, never the
 * actual gate.
 *
 * THREE THINGS ABOUT THIS FILE ARE DELIBERATE:
 *
 * 1. **Create, approve, reject and withdraw are all RPCs, and all run on
 *    `userClient`.** The database functions carry the authority ladder
 *    (`core.is_founder() and not core.is_read_only()`, the self-approval
 *    refusal, the >= 10-char rejection reason) and the atomicity, and
 *    they only work if `core.auth_user_id()` is the real caller.
 *    `serviceClient` appears in this file for exactly one thing — the
 *    display-name join — because on a service-role connection
 *    `core.auth_user_id()` is null, so `core.is_read_only()` returns
 *    false for everyone and the whole ladder evaluates as nobody. That
 *    is also why this router needs no `refuseReadOnlyWrites` hook: it
 *    performs no service-role write for the hook to guard, and
 *    `test/service-role-guard.test.ts` asserts that mechanically rather
 *    than trusting this comment.
 *
 * 2. **Nothing here decides an individual item.** All-or-nothing lives in
 *    `ops.decide_edit_batch`, which refuses a per-item decision at the
 *    row level, so there is deliberately no `/items/:id/approve` route to
 *    write. A half-applied batch of edits to the locked Monday record
 *    would be the worst instance yet of this project's recurring "correct
 *    response, broken side effect" defect (PLAN.md §12.7).
 *
 * 3. **The list endpoint is four queries regardless of how many batches
 *    or items come back** — batches, their children, the children's
 *    tasks, and one name join — because the approval screen has to render
 *    before → after per changed field per task, and doing that per item
 *    would be an N+1 on the one screen whose whole job is showing many
 *    changes at once.
 *
 * Everything the payload SAYS is decided by `assembleBatches`, which is
 * pure and covered by `test/task-edit-batches.test.ts`; the handlers do
 * IO and nothing else. Same split as `routes/now.ts`, and for the same
 * reason: presence-vs-null on a proposed field is easy to get backwards
 * and impossible to notice from a screenshot.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/domain.js';
import { authenticate, requireMembership, requireOversight } from '../middleware/auth.js';
import { userClient, serviceClient } from '../lib/supabase.js';
import { enrichWithOwners } from './tasks.js';

// -----------------------------------------------------------------------
// Request schemas
// -----------------------------------------------------------------------

/**
 * PRESENCE, not value, decides whether a field is being proposed. A
 * client that sends `description: null` is proposing to CLEAR the
 * description; not mentioning `description` at all is proposing nothing
 * about it. `.optional()` is what keeps `undefined` and `null` distinct
 * all the way from the browser to the `change_*` flag in the row — the
 * same distinction the table's flags exist for, and the same schema shape
 * `routes/task-edit-requests.ts` already uses.
 *
 * `.strict()` matters here and is not decoration: it makes the five
 * defining fields the ONLY proposable ones, so "propose a change to
 * `points_override`" is refused with a 400 naming the offending key
 * rather than being silently dropped. `ops.create_edit_batch` refuses it
 * again in the database; this is the friendlier of the two refusals.
 */
const changesSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    taskTypeId: z.string().uuid().nullable().optional(),
    ownerUserId: z.string().uuid().optional(),
    clientRef: z.string().nullable().optional(),
  })
  .strict();

const itemSchema = z.object({
  taskId: z.string().uuid(),
  changes: changesSchema,
});

export const createBatchSchema = z.object({
  reason: z
    .string()
    .min(10, 'a bulk edit suggestion needs a written reason of at least 10 characters'),
  items: z.array(itemSchema).min(1, 'a bulk edit suggestion must contain at least one item'),
});

export const rejectBatchSchema = z.object({
  reason: z
    .string()
    .min(10, 'rejecting a bulk edit suggestion needs a written reason of at least 10 characters'),
});

/** Optional note on an approval — an approver may say why, but is not required to. */
export const approveBatchSchema = z.object({
  reason: z.string().min(10).optional(),
});

export type CreateBatchBody = z.infer<typeof createBatchSchema>;
export type ProposedChanges = z.infer<typeof changesSchema>;

// -----------------------------------------------------------------------
// Pure payload shaping
// -----------------------------------------------------------------------

/** The five proposable fields, camelCase (API) -> snake_case (column). */
const FIELD_MAP: [keyof ProposedChanges, string][] = [
  ['title', 'title'],
  ['description', 'description'],
  ['taskTypeId', 'task_type_id'],
  ['ownerUserId', 'owner_user_id'],
  ['clientRef', 'client_ref'],
];

/**
 * The `p_items` argument for `ops.create_edit_batch`.
 *
 * The one rule: a key is present in the output if and only if it was
 * present in the input. `Object.prototype.hasOwnProperty` — not a
 * truthiness or null test — because `{ description: null }` must survive
 * as `{"description": null}` (a real, intentional clear) while
 * `{}` must produce no `description` key at all. A `?? null` here would
 * collapse those two into the same proposal and silently start clearing
 * descriptions nobody asked to clear.
 */
export function toRpcItems(items: CreateBatchBody['items']): Record<string, unknown>[] {
  return items.map((item) => {
    const out: Record<string, unknown> = { task_id: item.taskId };
    for (const [camel, snake] of FIELD_MAP) {
      if (Object.prototype.hasOwnProperty.call(item.changes, camel)) {
        out[snake] = item.changes[camel] ?? null;
      }
    }
    return out;
  });
}

/**
 * True when an item proposes nothing at all. Refused before the round
 * trip; `ops.create_edit_batch` refuses it again. Kept as its own
 * function because "the object is empty" is not what zod's `.strict()`
 * checks and it is the easiest way for a client-side suggestion buffer to
 * submit a no-op it thinks is a change.
 */
export function findEmptyItemIndex(items: CreateBatchBody['items']): number {
  return items.findIndex(
    (item) => !FIELD_MAP.some(([camel]) => Object.prototype.hasOwnProperty.call(item.changes, camel))
  );
}

export type EditRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

/** `ops.task_edit_batches`, as PostgREST returns it. */
export interface BatchRow {
  id: string;
  requested_by: string;
  requested_at: string;
  reason: string;
  status: EditRequestStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `ops.task_edit_requests`, as PostgREST returns it. Passed through
 * column-for-column on purpose: `apps/web/src/lib/task-edit-requests.ts`
 * already mirrors this row and `buildFieldDiffs` already turns it into a
 * readable before → after. Reshaping it here into some batch-specific
 * camelCase would mean a second diff renderer, which is exactly what the
 * build contract says not to write.
 */
export interface ItemRow {
  id: string;
  batch_id: string;
  task_id: string;
  [column: string]: unknown;
}

export interface TaskLite {
  id: string;
  title: string;
  status: string;
}

export interface BatchAssemblyInput {
  batches: BatchRow[];
  items: ItemRow[];
  tasks: TaskLite[];
  /** user id -> display name, from the one name join the handler pays for. */
  namesByUser: Record<string, string | null>;
}

export interface AssembledItem extends ItemRow {
  /** So the approver's queue can title a card without a second fetch per item. */
  taskTitle: string | null;
  /** So the UI can say "this task was cancelled underneath the suggestion" rather than showing a diff that can no longer apply. */
  taskStatus: string | null;
  requestedByName: string | null;
}

export interface AssembledBatch extends BatchRow {
  requestedByName: string | null;
  decidedByName: string | null;
  itemCount: number;
  /** Distinct tasks touched — a batch of six edits over two tasks reads differently from six over six. */
  taskCount: number;
  /** True when any item's task can no longer take the change (cleared/cancelled since it was proposed). Approving such a batch is refused wholesale by ops.decide_edit_batch, so the UI must be able to say so BEFORE the approver clicks. */
  hasUnapplicableItem: boolean;
  items: AssembledItem[];
}

const CLOSED_TASK_STATUSES = new Set(['cleared', 'cancelled']);

/**
 * Batches + their items + their tasks + names, assembled into what the
 * approval screen renders. Pure: every decision it makes is testable
 * without a database, which is the point (PLAN.md §12.7 — this project's
 * bugs live in what a handler does on the way, not in what it returns).
 *
 * Item order is the order the items arrive in (the handler asks for
 * `requested_at`, then `id`, so it is stable across polls); batch order
 * is the order the batches arrive in, decided by the handler's query, not
 * re-sorted here.
 */
export function assembleBatches(input: BatchAssemblyInput): AssembledBatch[] {
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  const itemsByBatch = new Map<string, ItemRow[]>();
  for (const item of input.items) {
    const list = itemsByBatch.get(item.batch_id);
    if (list) list.push(item);
    else itemsByBatch.set(item.batch_id, [item]);
  }

  const name = (id: string | null): string | null => (id ? input.namesByUser[id] ?? null : null);

  return input.batches.map((batch) => {
    const rows = itemsByBatch.get(batch.id) ?? [];
    const items: AssembledItem[] = rows.map((row) => {
      const task = taskById.get(row.task_id);
      return {
        ...row,
        taskTitle: task?.title ?? null,
        taskStatus: task?.status ?? null,
        requestedByName: name(batch.requested_by),
      };
    });

    return {
      ...batch,
      requestedByName: name(batch.requested_by),
      decidedByName: name(batch.decided_by),
      itemCount: items.length,
      taskCount: new Set(rows.map((r) => r.task_id)).size,
      // A task the caller cannot see at all reads as unapplicable too, and
      // that is the honest answer: an approver who cannot see the task
      // cannot review the diff either. In practice ops.tasks is readable by
      // every ops member, so this only fires for a genuinely deleted row.
      hasUnapplicableItem: items.some(
        (i) => i.taskStatus === null || CLOSED_TASK_STATUSES.has(i.taskStatus)
      ),
      items,
    };
  });
}

// -----------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------

const BATCH_COLUMNS =
  'id, requested_by, requested_at, reason, status, decided_by, decided_at, decision_reason, created_at, updated_at';

export default async function taskEditBatchesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  /**
   * The four reads behind one response. `db` is the caller's own client,
   * so a batch, an item or a task the caller may not see is not returned
   * — the payload cannot widen visibility past `ops`' own policies.
   * `svc` is used for the name join only (`core.people` is not readable
   * per-row by every ops member), exactly as every other list endpoint in
   * this app does it.
   */
  async function loadBatches(
    accessToken: string,
    filter: { status?: string; id?: string; requestedBy?: string }
  ): Promise<AssembledBatch[]> {
    const db = userClient(accessToken);

    let batchQuery = db.schema('ops').from('task_edit_batches').select(BATCH_COLUMNS);
    if (filter.id) batchQuery = batchQuery.eq('id', filter.id);
    if (filter.status) batchQuery = batchQuery.eq('status', filter.status);
    if (filter.requestedBy) batchQuery = batchQuery.eq('requested_by', filter.requestedBy);
    // Pending first, then most recent — the same "oldest work waiting on
    // you, first" convention /queue, /inbox and /task-edit-requests use.
    batchQuery = batchQuery.order('status', { ascending: true }).order('requested_at', { ascending: true });

    const { data: batches, error } = await batchQuery;
    if (error) throw error;
    if (!batches?.length) return [];

    const batchIds = batches.map((b) => b.id as string);
    const { data: items, error: itemsError } = await db
      .schema('ops')
      .from('task_edit_requests')
      .select('*')
      .in('batch_id', batchIds)
      .order('requested_at', { ascending: true })
      .order('id', { ascending: true });
    if (itemsError) throw itemsError;

    const taskIds = [...new Set((items ?? []).map((i) => i.task_id as string))];
    const { data: tasks, error: tasksError } = taskIds.length
      ? await db.schema('ops').from('tasks').select('id, title, status').in('id', taskIds)
      : { data: [], error: null };
    if (tasksError) throw tasksError;

    const userIds = [
      ...new Set(
        batches
          .flatMap((b) => [b.requested_by as string, b.decided_by as string | null])
          .filter((id): id is string => Boolean(id))
      ),
    ];
    // Bound to its own name, like `routes/task-edit-requests.ts` does, so
    // `test/service-role-guard.test.ts`'s detector sees a service-only
    // binding in this file and its "not a service-role writer" assertion
    // about this router is about something real rather than vacuous.
    const svc = serviceClient();
    const named = userIds.length
      ? await enrichWithOwners(svc, userIds.map((owner_user_id) => ({ owner_user_id })))
      : [];
    const namesByUser: Record<string, string | null> = {};
    for (const n of named) namesByUser[n.owner_user_id] = n.ownerName;

    return assembleBatches({
      batches: batches as unknown as BatchRow[],
      items: (items ?? []) as unknown as ItemRow[],
      tasks: (tasks ?? []) as unknown as TaskLite[],
      namesByUser,
    });
  }

  /**
   * Raise one. GM, founder or admin (`requireOversight`) — the DB
   * trigger refuses staff regardless; this 403 is the earlier, friendlier
   * version of that refusal, same as the single-request route.
   *
   * The batch row and every item are created by ONE function call, so a
   * failure on item four cannot leave a childless pending batch sitting
   * in an approver's queue. `before_values` for each item is snapshotted
   * inside the database from the task's own current row — this endpoint
   * never accepts a "before" from the client, because a client that can
   * state the before can misstate it, and the before is half of what the
   * approver is being asked to judge.
   */
  app.post('/', { onRequest: requireOversight() }, async (req) => {
    const body = createBatchSchema.parse(req.body);

    const emptyAt = findEmptyItemIndex(body.items);
    if (emptyAt >= 0) {
      throw new ApiError(
        400,
        `item ${emptyAt + 1} proposes no change; every item must change at least one field`,
        'VALIDATION_ERROR'
      );
    }

    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').rpc('create_edit_batch', {
      p_reason: body.reason,
      p_items: toRpcItems(body.items),
    });
    if (error) throw new ApiError(422, error.message, error.code ?? 'EDIT_BATCH_REFUSED');

    const id = (data as { id?: string } | null)?.id;
    if (!id) throw new ApiError(500, 'the bulk edit suggestion was created but returned no id', 'INTERNAL');

    // Read it back through the same assembler the list uses, so the
    // client that just created a batch holds exactly the shape it will
    // see on its next poll — including each item's server-snapshotted
    // before_values.
    const [batch] = await loadBatches(req.accessToken, { id });
    return { data: batch ?? null };
  });

  app.get('/', async (req) => {
    const q = req.query as { status?: string; requestedBy?: string };
    return { data: await loadBatches(req.accessToken, { status: q.status, requestedBy: q.requestedBy }) };
  });

  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [batch] = await loadBatches(req.accessToken, { id });
    if (!batch) throw new ApiError(404, 'bulk edit suggestion not found', 'NOT_FOUND');
    return { data: batch };
  });

  /**
   * Approve — all of it, or none of it. Founder or admin, per Chan
   * ("then approve by admin or founder"), never a read-only account and
   * never the requester; all three are decided by
   * `ops.decide_edit_batch`, and its message is forwarded verbatim so the
   * refusal a person reads is the rule the database actually applied.
   *
   * `requireOversight()` is the pre-flight, and it is deliberately LOOSER
   * than the real rule: it admits GM, whom the database then refuses.
   * Tightening it to founder/admin here would put a second copy of the
   * authority ladder in application code, which is how the two drift —
   * the pattern `lib/task-permissions.ts` had to be corrected for on
   * 2026-09-10.
   */
  app.post('/:id/approve', { onRequest: requireOversight() }, async (req) => {
    const { id } = req.params as { id: string };
    const body = approveBatchSchema.parse(req.body ?? {});
    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').rpc('decide_edit_batch', {
      p_batch_id: id,
      p_approve: true,
      p_reason: body.reason ?? null,
    });
    if (error) throw new ApiError(422, error.message, error.code ?? 'APPROVE_REFUSED');
    return { data: (await loadBatches(req.accessToken, { id }))[0] ?? data };
  });

  app.post('/:id/reject', { onRequest: requireOversight() }, async (req) => {
    const { id } = req.params as { id: string };
    const body = rejectBatchSchema.parse(req.body);
    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').rpc('decide_edit_batch', {
      p_batch_id: id,
      p_approve: false,
      p_reason: body.reason,
    });
    if (error) throw new ApiError(422, error.message, error.code ?? 'REJECT_REFUSED');
    return { data: (await loadBatches(req.accessToken, { id }))[0] ?? data };
  });

  /**
   * Withdraw — the requester's own way out, and no `requireOversight`
   * for the same reason the single-request route has none: withdrawing
   * your own suggestion is the normal path, not a privileged one. It
   * exists because a batch's items cannot be withdrawn one at a time
   * (all-or-nothing cuts both ways), so without it a submitted
   * suggestion would be a dead end for the person who raised it.
   */
  app.post('/:id/withdraw', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').rpc('withdraw_edit_batch', { p_batch_id: id });
    if (error) throw new ApiError(422, error.message, error.code ?? 'WITHDRAW_REFUSED');
    return { data: (await loadBatches(req.accessToken, { id }))[0] ?? data };
  });
}
