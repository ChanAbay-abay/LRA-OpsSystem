/**
 * LRA Global Ops :: /api/tasks, /api/blocks
 *
 * One transition endpoint (`POST /:id/status`) for every status change —
 * button, drag, keyboard. All writes here run on `userClient`, so
 * `ops.enforce_task_transition` (the BEFORE UPDATE trigger) is the real
 * ladder; this route cannot promote a transition the database would
 * refuse (PLAN.md §3). Board/list reads are enriched with the owner's
 * `core.position` in application code — `core.memberships` lives in a
 * different schema than `ops.tasks`, so this mirrors the manual merge
 * `routes/me.ts` already uses for the team roster, rather than
 * depending on PostgREST resolving a cross-schema embed.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/domain.js';
import { authenticate, requireMembership, requireOversight } from '../middleware/auth.js';
import { userClient, serviceClient } from '../lib/supabase.js';

const TASK_STATUSES = [
  'todo',
  'in_progress',
  'submitted',
  'verified',
  'cleared',
  'rejected',
  'cancelled',
  'pending_cancellation',
] as const;

const createSchema = z.object({
  weekId: z.string().uuid(),
  ownerUserId: z.string().uuid().optional(), // defaults to self; oversight may set another owner
  taskTypeId: z.string().uuid().nullable().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  clientRef: z.string().optional(),
  status: z.enum(['todo', 'in_progress']).optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  taskTypeId: z.string().uuid().nullable().optional(),
  clientRef: z.string().nullable().optional(),
});

// A cancellation FLAG needs its reason enforced the same way as a
// points override (min 10 chars, checked in zod AND the DB trigger --
// Chan's explicit ask to match that precedent exactly). A cancellation
// REFUSAL needs the same bar but which transition is a refusal depends
// on the task's current status, which zod cannot see -- that half is
// checked in the route after the current row is fetched.
const statusSchema = z
  .object({
    to: z.enum(TASK_STATUSES),
    reason: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.to === 'pending_cancellation' && (!val.reason || val.reason.trim().length < 10)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'a cancellation flag needs a written reason of at least 10 characters',
      });
    }
  });

// The founder's bulk clear / bulk flag. Capped at 200: the route is
// sequential and a runaway list would hold a request open for minutes.
// Three people cannot legitimately produce 200 verified tasks in a week,
// so the cap guards against a malformed client, not against anyone's
// real Monday.
//
// TWO SHAPES, because a bulk refusal has two honest forms (Chan,
// 2026-09-09: "allow option for batch or individual depending if more
// than one was selected"):
//
//   { ids: [...], reason }              — one verdict covering all of them
//   { items: [{ id, reason }, ...] }    — a separate verdict per task
//
// Both normalise to the same `(id, reason)` list before anything is
// written, so the transition path, the trigger and the partial-success
// contract below are identical either way. The difference is only in
// what the founder is asserting: "this batch is wrong for one reason" is
// a different claim from "each of these is wrong for its own reason",
// and forcing the first shape onto the second produces N copies of a
// sentence that fits none of them.
const bulkItemSchema = z.object({ id: z.string().uuid(), reason: z.string().optional() });

const bulkStatusSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(200).optional(),
    items: z.array(bulkItemSchema).min(1).max(200).optional(),
    to: z.enum(TASK_STATUSES),
    reason: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.ids === !val.items) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ids'],
        message: 'send exactly one of `ids` (one shared reason) or `items` (a reason per task)',
      });
      return;
    }

    // Sending work back is the one bulk action that costs someone their
    // week, so it carries the same 10-character bar as every other
    // written refusal in this system (override, block, cancellation) —
    // and it carries it PER TASK, so the `items` shape cannot be used to
    // smuggle in a blank reason for one row among nine good ones.
    if (val.to !== 'rejected') return;
    const short = (r?: string) => !r || r.trim().length < 10;
    const message = 'sending tasks back needs a written reason of at least 10 characters';

    if (val.ids && short(val.reason)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message });
    }
    for (const [i, item] of (val.items ?? []).entries()) {
      if (short(item.reason ?? val.reason)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', i, 'reason'], message });
      }
    }
  });

const overrideSchema = z.object({
  points: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8), z.literal(13), z.literal(21)]),
  reason: z.string().min(10, 'a points override needs a written reason of at least 10 characters'),
});

const blockSchema = z.object({
  target: z.enum(['task', 'person', 'external']),
  blockingTaskId: z.string().uuid().optional(),
  blockingUserId: z.string().uuid().optional(),
  blockingExternal: z.string().optional(),
  reason: z.string().min(10, 'a block needs a written reason of at least 10 characters'),
});

/** Attach `ownerPosition` / `ownerName` to a batch of tasks, per Chan's ask that position mean something in the board's grouping. */
export async function enrichWithOwners<T extends { owner_user_id: string }>(
  db: ReturnType<typeof serviceClient>,
  tasks: T[]
): Promise<(T & { ownerPosition: string | null; ownerName: string | null })[]> {
  const ownerIds = [...new Set(tasks.map((t) => t.owner_user_id))];
  if (!ownerIds.length) return tasks.map((t) => ({ ...t, ownerPosition: null, ownerName: null }));

  const [{ data: memberships }, { data: users }] = await Promise.all([
    db
      .schema('core')
      .from('memberships')
      .select('user_id, position')
      .eq('module', 'ops')
      .in('user_id', ownerIds),
    db.schema('core').from('users').select('id, email, person_id').in('id', ownerIds),
  ]);

  const personIds = (users ?? []).map((u) => u.person_id).filter((id): id is string => Boolean(id));
  const { data: people } = personIds.length
    ? await db.schema('core').from('people').select('id, display_name, first_name, last_name').in('id', personIds)
    : { data: [] as { id: string; display_name: string | null; first_name: string; last_name: string }[] };

  const positionByUser = new Map((memberships ?? []).map((m) => [m.user_id, m.position]));
  const userById = new Map((users ?? []).map((u) => [u.id, u]));
  const personById = new Map((people ?? []).map((p) => [p.id, p]));

  return tasks.map((t) => {
    const u = userById.get(t.owner_user_id);
    const person = u?.person_id ? personById.get(u.person_id) : undefined;
    const ownerName = person ? person.display_name ?? `${person.first_name} ${person.last_name}` : u?.email ?? null;
    return { ...t, ownerPosition: positionByUser.get(t.owner_user_id) ?? null, ownerName };
  });
}

/** Open blocks keyed by task id, so board cards can show a count without an N+1 query. */
async function openBlockCounts(
  db: ReturnType<typeof serviceClient>,
  taskIds: string[]
): Promise<Map<string, number>> {
  if (!taskIds.length) return new Map();
  const { data } = await db
    .schema('ops')
    .from('task_blocks')
    .select('task_id')
    .in('task_id', taskIds)
    .is('resolved_at', null);
  const counts = new Map<string, number>();
  for (const row of data ?? []) counts.set(row.task_id, (counts.get(row.task_id) ?? 0) + 1);
  return counts;
}

/** Note counts keyed by task id, so board cards can show "who is actually narrating" at a glance (Chan's ask) without an N+1 query. */
async function noteCounts(db: ReturnType<typeof serviceClient>, taskIds: string[]): Promise<Map<string, number>> {
  if (!taskIds.length) return new Map();
  const { data } = await db.schema('ops').from('task_notes').select('task_id').in('task_id', taskIds);
  const counts = new Map<string, number>();
  for (const row of data ?? []) counts.set(row.task_id, (counts.get(row.task_id) ?? 0) + 1);
  return counts;
}

export default async function tasksRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  app.get('/', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const db = userClient(req.accessToken);
    let query = db.schema('ops').from('tasks').select('*').order('created_at', { ascending: false });
    if (q.weekId) query = query.eq('week_id', q.weekId);
    if (q.ownerId) query = query.eq('owner_user_id', q.ownerId);
    if (q.status) query = query.eq('status', q.status);
    if (q.committed !== undefined) query = query.eq('is_committed', q.committed === 'true');

    const { data, error } = await query;
    if (error) throw error;

    // Reads still run through userClient/RLS above; enrichment reads are
    // system-level (the same cross-schema join every roster read needs).
    const svc = serviceClient();
    const enriched = await enrichWithOwners(svc, data ?? []);
    const counts = await openBlockCounts(svc, enriched.map((t) => t.id));
    const notes = await noteCounts(svc, enriched.map((t) => t.id));
    let result = enriched.map((t) => ({ ...t, openBlockCount: counts.get(t.id) ?? 0, noteCount: notes.get(t.id) ?? 0 }));

    if (q.stale === 'true') {
      const staleMs = 3 * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - staleMs;
      result = result.filter(
        (t) => ['todo', 'in_progress'].includes(t.status) && new Date(t.last_activity_at).getTime() < cutoff
      );
    }

    return { data: result };
  });

  // The board is the same read as above, grouped for the client by
  // status, with `ownerPosition` present on every card so the UI can
  // sub-group by position without a second request.
  app.get('/board', async (req) => {
    const q = req.query as { weekId?: string };
    const db = userClient(req.accessToken);
    let query = db.schema('ops').from('tasks').select('*').order('created_at', { ascending: true });
    if (q.weekId) query = query.eq('week_id', q.weekId);

    const { data, error } = await query;
    if (error) throw error;

    // Reads above already ran through userClient/RLS (any ops member
    // reads all of ops.tasks); enrichment below is the same cross-schema
    // owner/block/note-count join every list endpoint in this app pays
    // for, on rows the caller already has.
    const svc = serviceClient();
    const enriched = await enrichWithOwners(svc, data ?? []);
    const counts = await openBlockCounts(svc, enriched.map((t) => t.id));
    const notes = await noteCounts(svc, enriched.map((t) => t.id));

    // Chan's decision (2026-09-09): the board stays at seven columns —
    // an eighth `pending_cancellation` column would sit empty almost all
    // the time and horizontal space is the board's scarcest resource.
    // But a flagged task must not disappear from view while it awaits a
    // decision, so it stays rendered in the column its
    // `pre_cancellation_status` resolves to (not hidden, not moved) —
    // the web client is what applies the "at risk" visual treatment and
    // makes the card non-draggable. `flagged` below is the SEPARATE list
    // the founder's banner reads from; it is not a column.
    const columns: Record<string, unknown[]> = {
      backlog: [],
      this_week: [],
      in_progress: [],
      blocked: [],
      submitted: [],
      verified: [],
      cleared: [],
    };
    const flagged: unknown[] = [];

    // Maps a real task_status to the column it renders in when nothing
    // else (a block) overrides that. Used for a task's own status, and
    // for a flagged cancellation's `pre_cancellation_status` snapshot —
    // literally "the column it held before being flagged", per Chan's
    // decision above.
    const statusColumn = (status: string, isCommitted: boolean): keyof typeof columns | null => {
      switch (status) {
        case 'todo':
          return isCommitted ? 'this_week' : 'backlog';
        case 'in_progress':
          return 'in_progress';
        case 'submitted':
          return 'submitted';
        case 'verified':
          return 'verified';
        case 'cleared':
          return 'cleared';
        // A returned task lands back in Backlog (Chan, 2026-09-09:
        // "make sure that returned tasks can be seen on the list").
        // It previously fell through to `null` and rendered in NO
        // column, so work the GM or founder sent back simply vanished
        // from its owner's board — the one screen they would look for it
        // on — while still counting against them. `rejected -> todo` is
        // the only transition the trigger allows out of this state, so
        // Backlog is where the card has to be for its owner to take it.
        // It stays visually distinct there: the web client renders a
        // "Returned" chip carrying `rejected_reason`.
        //
        // NOT `this_week`, even when committed. A returned task is no
        // longer a commitment being met; putting it back among this
        // week's promises would overstate the week.
        case 'rejected':
          return 'backlog';
        default:
          return null;
      }
    };

    for (const t of enriched) {
      const card = { ...t, openBlockCount: counts.get(t.id) ?? 0, noteCount: notes.get(t.id) ?? 0 };

      if (t.status === 'pending_cancellation') {
        const col = statusColumn(t.pre_cancellation_status ?? 'todo', t.is_committed);
        if (col) columns[col].push(card);
        flagged.push(card);
        continue;
      }

      if ((counts.get(t.id) ?? 0) > 0 && !['cleared', 'cancelled'].includes(t.status)) {
        columns.blocked.push(card);
        continue;
      }

      const col = statusColumn(t.status, t.is_committed);
      if (col) columns[col].push(card);
    }

    return { data: { ...columns, flagged } };
  });

  app.post('/', async (req) => {
    const body = createSchema.parse(req.body);
    const ownerUserId = body.ownerUserId ?? req.user.id;
    if (ownerUserId !== req.user.id && req.user.authority === 'staff') {
      throw new ApiError(403, 'only oversight may create a task for someone else', 'FORBIDDEN');
    }

    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('tasks')
      .insert({
        week_id: body.weekId,
        owner_user_id: ownerUserId,
        task_type_id: body.taskTypeId ?? null,
        title: body.title,
        description: body.description ?? null,
        client_ref: body.clientRef ?? null,
        status: body.status ?? 'todo',
        created_by: req.user.id,
      })
      .select()
      .single();
    if (error) throw error;
    return { data };
  });

  app.patch('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const db = userClient(req.accessToken);

    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.taskTypeId !== undefined) patch.task_type_id = body.taskTypeId;
    if (body.clientRef !== undefined) patch.client_ref = body.clientRef;

    const { data, error } = await db.schema('ops').from('tasks').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return { data };
  });

  // THE one transition endpoint. Whatever the caller asks for, the
  // database's own trigger decides whether it is legal — this route
  // never special-cases a persona. The cancellation ladder
  // (todo/in_progress/submitted/verified -> pending_cancellation ->
  // cancelled | <status before the flag>) goes through here too, same
  // as verify/reject/clear — no separate "approve cancellation"
  // endpoint, so there is exactly one place the ladder can be wrong.
  app.post('/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const body = statusSchema.parse(req.body);
    const db = userClient(req.accessToken);

    // Needed to tell a cancellation DECISION (current status is
    // pending_cancellation) apart from every other transition, since
    // that is the only case where `cancellation_decision_reason` is the
    // right column for `reason` rather than `rejected_reason`.
    const { data: current } = await db.schema('ops').from('tasks').select('status').eq('id', id).maybeSingle();

    if (
      current?.status === 'pending_cancellation' &&
      body.to !== 'pending_cancellation' &&
      body.to !== 'cancelled' &&
      (!body.reason || body.reason.trim().length < 10)
    ) {
      throw new ApiError(400, 'a cancellation refusal needs a written reason of at least 10 characters', 'VALIDATION_ERROR');
    }

    const patch: Record<string, unknown> = { status: body.to };
    if (body.to === 'rejected' || (body.to === 'submitted' && body.reason)) {
      patch.rejected_reason = body.reason ?? null;
    }
    if (body.to === 'pending_cancellation') {
      patch.cancellation_reason = body.reason ?? null;
    }
    if (current?.status === 'pending_cancellation' && body.to !== 'pending_cancellation') {
      // Approval (-> cancelled) or refusal (-> the pre-flag status) --
      // either way this is the decision reason, never rejected_reason.
      patch.cancellation_decision_reason = body.reason ?? null;
    }

    const { data, error } = await db.schema('ops').from('tasks').update(patch).eq('id', id).select().single();
    if (error) {
      // `.select().single()` on an UPDATE that RLS silently filtered to
      // zero rows (e.g. Sales flagging a Broker's task) comes back as
      // PGRST116 ("cannot coerce to a single JSON object") -- a correct
      // refusal with a wrong, internals-leaking message. Every other
      // transition refusal here is already a human sentence written by
      // the DB trigger, so only this one code needs translating.
      if (error.code === 'PGRST116') {
        throw new ApiError(404, 'task not found, or you do not have permission to change its status', 'NOT_FOUND');
      }
      throw new ApiError(422, error.message, error.code ?? 'TRANSITION_REFUSED');
    }
    return { data };
  });

  /**
   * Bulk transition — the founder's "approve all" (Chan, 2026-09-09).
   *
   * This grants NOTHING that `POST /:id/status` does not. It runs on
   * `userClient` and issues one UPDATE per task, so
   * `ops.enforce_task_transition` fires per row exactly as it would for
   * eleven separate clicks. A bulk endpoint that batched the rows into
   * one statement, or reached for `serviceClient` to go faster, would be
   * a second ladder — the precise thing PLAN.md §3 forbids.
   *
   * PARTIAL SUCCESS IS THE CONTRACT, per Chan's decision. The rows are
   * independent: one task that has gone stale between page load and
   * click (someone else cleared it, a block was raised, it was flagged
   * for cancellation) must not strand ten good ones. Every refusal comes
   * back with the trigger's own sentence attached to its task id, so the
   * screen can leave those rows in place with the reason shown while the
   * rest disappear.
   *
   * Sequential, not `Promise.all`. Each UPDATE takes a row lock and the
   * ledger trigger writes on commit; firing eleven at once against a
   * three-person Supabase project buys nothing and invites the lock
   * contention that already had to be mapped to a retryable 503 once.
   */
  app.post('/bulk-status', async (req) => {
    const body = bulkStatusSchema.parse(req.body);
    const db = userClient(req.accessToken);

    // The two request shapes collapse here, before any write, so
    // everything below this line is blind to which one arrived.
    const items = body.items ?? body.ids!.map((id) => ({ id, reason: body.reason }));

    const changed: unknown[] = [];
    const refused: { id: string; message: string }[] = [];

    for (const { id, reason } of items) {
      const patch: Record<string, unknown> = { status: body.to };
      if (body.to === 'rejected') patch.rejected_reason = reason ?? body.reason ?? null;

      const { data, error } = await db.schema('ops').from('tasks').update(patch).eq('id', id).select().single();
      if (error) {
        // Same PGRST116 translation as the single-task route: RLS
        // filtering the UPDATE to zero rows is a correct refusal with an
        // internals-leaking message.
        refused.push({
          id,
          message:
            error.code === 'PGRST116'
              ? 'not found, or you do not have permission to change its status'
              : error.message,
        });
        continue;
      }
      changed.push(data);
    }

    return { data: { changed, refused } };
  });

  // Commit / uncommit — Phase 6. `ops.enforce_task_transition`'s
  // commitment-lock guard is the real enforcement (owner-or-oversight,
  // and refused once the task's week has left `planning`); this route
  // just derives `committed_week_id`/`committed_points` from the task's
  // current week and catalog snapshot so the client never has to send
  // (or forge) either.
  app.post('/:id/commit', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);

    const { data: existing, error: fetchError } = await db
      .schema('ops')
      .from('tasks')
      .select('week_id, catalog_points, points_override')
      .eq('id', id)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!existing) throw new ApiError(404, 'task not found', 'NOT_FOUND');

    const { data, error } = await db
      .schema('ops')
      .from('tasks')
      .update({
        is_committed: true,
        committed_week_id: existing.week_id,
        committed_points: existing.points_override ?? existing.catalog_points ?? null,
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'COMMIT_REFUSED');
    return { data };
  });

  app.delete('/:id/commit', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('tasks')
      .update({ is_committed: false, committed_week_id: null, committed_points: null })
      .eq('id', id)
      .select()
      .single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'UNCOMMIT_REFUSED');
    return { data };
  });

  // The worklog — a running narration distinct from the task's
  // `description` (PRD addendum: "employees add descriptions as they
  // continue with the tasks"). Append-only at the DB layer
  // (`ops.forbid_task_note_mutation`); this route only ever INSERTs or
  // SELECTs.
  app.get('/:id/notes', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_notes')
      .select('*')
      .eq('task_id', id)
      .order('created_at', { ascending: true });
    if (error) throw error;

    // Note rows themselves already came through userClient/RLS above;
    // this only resolves the authors' display names, the same
    // enrichWithOwners join every other list endpoint pays for.
    const svc = serviceClient();
    const authorIds = [...new Set((data ?? []).map((n) => n.author_user_id as string))];
    const enriched = authorIds.length
      ? await enrichWithOwners(svc, authorIds.map((owner_user_id) => ({ owner_user_id })))
      : [];
    const nameByAuthor = new Map(enriched.map((e) => [e.owner_user_id, e.ownerName]));

    return {
      data: (data ?? []).map((n) => ({ ...n, authorName: nameByAuthor.get(n.author_user_id) ?? null })),
    };
  });

  app.post('/:id/notes', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_notes')
      .insert({ task_id: id, author_user_id: req.user.id, body: body.body })
      .select()
      .single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'NOTE_REFUSED');
    return { data };
  });

  // One task's blocks, open and resolved, for its detail view. The
  // board already gets an open-block COUNT per card; this is the "why",
  // which only the detail modal needs and so is not worth carrying on
  // every card in the board payload.
  app.get('/:id/blocks', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_blocks')
      .select('*')
      .eq('task_id', id)
      .order('created_at', { ascending: true });
    if (error) throw error;

    // Block rows themselves already came through userClient/RLS above;
    // this only resolves blocker/creator/resolver display names, the
    // same enrichWithOwners join every other list endpoint pays for.
    const svc = serviceClient();
    const userIds = [
      ...new Set(
        (data ?? [])
          .flatMap((b) => [b.blocking_user_id, b.created_by, b.resolved_by])
          .filter((v): v is string => Boolean(v))
      ),
    ];
    const named = userIds.length
      ? await enrichWithOwners(svc, userIds.map((owner_user_id) => ({ owner_user_id })))
      : [];
    const nameById = new Map(named.map((n) => [n.owner_user_id, n.ownerName]));

    return {
      data: (data ?? []).map((b) => ({
        ...b,
        blockingName: b.blocking_user_id ? (nameById.get(b.blocking_user_id) ?? null) : b.blocking_external,
        createdByName: nameById.get(b.created_by) ?? null,
        resolvedByName: b.resolved_by ? (nameById.get(b.resolved_by) ?? null) : null,
      })),
    };
  });

  app.post('/:id/override-points', { onRequest: requireOversight() }, async (req) => {
    const { id } = req.params as { id: string };
    const body = overrideSchema.parse(req.body);
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('tasks')
      .update({ points_override: body.points, points_override_reason: body.reason })
      .eq('id', id)
      .select()
      .single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'OVERRIDE_REFUSED');
    return { data };
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { error, count } = await db.schema('ops').from('tasks').delete({ count: 'exact' }).eq('id', id);
    if (error) throw error;
    if (!count) throw new ApiError(403, 'this task cannot be deleted (not yours, or past todo/cancelled)', 'FORBIDDEN');
    return reply.code(204).send();
  });

  app.post('/:id/blocks', async (req) => {
    const { id } = req.params as { id: string };
    const body = blockSchema.parse(req.body);
    if (body.target === 'task' && !body.blockingTaskId) {
      throw new ApiError(400, 'blockingTaskId is required when target is "task"', 'VALIDATION_ERROR');
    }
    if (body.target === 'person' && !body.blockingUserId) {
      throw new ApiError(400, 'blockingUserId is required when target is "person"', 'VALIDATION_ERROR');
    }
    if (body.target === 'external' && !body.blockingExternal?.trim()) {
      throw new ApiError(400, 'blockingExternal is required when target is "external"', 'VALIDATION_ERROR');
    }

    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_blocks')
      .insert({
        task_id: id,
        target: body.target,
        blocking_task_id: body.target === 'task' ? body.blockingTaskId : null,
        blocking_user_id: body.target === 'person' ? body.blockingUserId : null,
        blocking_external: body.target === 'external' ? body.blockingExternal : null,
        reason: body.reason,
        created_by: req.user.id,
      })
      .select()
      .single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'BLOCK_REFUSED');
    return { data };
  });
}

export async function blocksRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  app.get('/open', async (req) => {
    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').from('task_blocks').select('*').is('resolved_at', null);
    if (error) throw error;
    return { data };
  });

  app.post('/:id/resolve', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_blocks')
      .update({ resolved_at: new Date().toISOString(), resolved_by: req.user.id })
      .eq('id', id)
      .select()
      .single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'RESOLVE_REFUSED');
    return { data };
  });
}
