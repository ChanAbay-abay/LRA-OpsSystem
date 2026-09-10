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
import { authenticate, requireMembership, requireOversight, requireAuthority, refuseReadOnlyWrites } from '../middleware/auth.js';
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
  // Undefined -> defaults to self. A real uuid -> oversight may create a
  // task for someone else. `null` -> deliberately unassigned (2026-09-11:
  // "tasks cannot move from the week's list until someone is assigned...
  // any of the employees can take up the task or have the GM assign
  // someone to it at a later time") -- the database's own tasks_insert
  // RLS (owner_user_id = self OR oversight) is the real gate on both the
  // "someone else" and the "nobody yet" cases; this route only produces a
  // clearer 403 than PostgREST's generic policy-violation message would.
  ownerUserId: z.string().uuid().nullable().optional(),
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
  // Owner reassignment on a direct edit. `ops.enforce_task_transition`'s
  // statement 2c is the real gate (2026-09-11): oversight may assign it
  // to anyone, and the new owner may claim it themselves if it is
  // currently unassigned. The route below only widens FAR enough to let
  // both of those legitimate calls reach the database -- an ordinary
  // staff member reassigning someone ELSE'S task is still refused here,
  // before ever touching PostgREST.
  ownerUserId: z.string().uuid().optional(),
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

const POINTS_UNION = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
  z.literal(13),
  z.literal(21),
]);

/**
 * PLAN-ADMIN-CORRECTIONS.md §1.2's whitelist, camelCase. `.strict()`
 * makes these the ONLY proposable fields -- most notably, `status` and
 * the commitment triple (`isCommitted`/`committedWeekId`/
 * `committedPoints`) are absent on purpose, not merely unchecked:
 * `ops.admin_correct_task`'s own jsonb whitelist has no column for any
 * of them either, so "propose a commitment change" is as inexpressible
 * here as "propose a points_override" is in a bulk edit suggestion
 * (`task-edit-batches.ts`). A status change is `POST /:id/force-status`
 * below, a different function entirely -- see the migration header for
 * why a transition is never folded into a column-write function.
 *
 * `pointsOverrideReason` is required whenever `pointsOverride` is
 * non-null, checked here as the friendlier 400 before
 * `ops.admin_correct_task` refuses it again in the database.
 */
const correctChangesSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    taskTypeId: z.string().uuid().nullable().optional(),
    ownerUserId: z.string().uuid().optional(),
    clientRef: z.string().nullable().optional(),
    pointsOverride: POINTS_UNION.nullable().optional(),
    pointsOverrideReason: z.string().nullable().optional(),
  })
  .strict()
  .refine((val) => Object.keys(val).length > 0, {
    message: 'an admin correction must change at least one field',
  })
  .refine(
    (val) =>
      !Object.prototype.hasOwnProperty.call(val, 'pointsOverride') ||
      val.pointsOverride === null ||
      val.pointsOverride === undefined ||
      (typeof val.pointsOverrideReason === 'string' && val.pointsOverrideReason.trim().length >= 10),
    {
      message: 'a points override requires a written reason of at least 10 characters',
      path: ['pointsOverrideReason'],
    }
  );

export const correctTaskSchema = z.object({
  reason: z.string().min(10, 'an admin correction needs a written reason of at least 10 characters'),
  changes: correctChangesSchema,
});

export const forceStatusSchema = z.object({
  to: z.enum(TASK_STATUSES),
  reason: z.string().min(10, 'forcing a task transition needs a written reason of at least 10 characters'),
});

export type CorrectTaskBody = z.infer<typeof correctTaskSchema>;

/** camelCase -> snake_case for `ops.admin_correct_task`'s `p_changes`, presence-not-truthiness, same convention as `toRpcItems` in `task-edit-batches.ts`. */
const CORRECT_FIELD_MAP: [keyof CorrectTaskBody['changes'], string][] = [
  ['title', 'title'],
  ['description', 'description'],
  ['taskTypeId', 'task_type_id'],
  ['ownerUserId', 'owner_user_id'],
  ['clientRef', 'client_ref'],
  ['pointsOverride', 'points_override'],
  ['pointsOverrideReason', 'points_override_reason'],
];

export function toRpcChanges(changes: CorrectTaskBody['changes']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [camel, snake] of CORRECT_FIELD_MAP) {
    if (Object.prototype.hasOwnProperty.call(changes, camel)) {
      out[snake] = changes[camel] ?? null;
    }
  }
  return out;
}

/**
 * What a block NAMES, as one display string — the person, the blocking
 * task's title, or the free-text outside party.
 *
 * Extracted 2026-09-10 because `blockingName` was computed twice (here
 * and in `routes/now.ts`) and both copies read `blocking_user_id ? name
 * : blocking_external` — which silently returned `null` for a
 * `task`-target block, so a block on another task rendered as "Waiting
 * on someone else" with no title anywhere. That was invisible until the
 * UI's block dialog gained a real target picker (same date) and made
 * task/person targets reachable outside seeded data; the columns and
 * the `chk_ops_task_blocks_one_target` constraint have supported all
 * three since Phase 3.
 *
 * Switches on `target` rather than on which column happens to be
 * non-null: `target` is the declared intent and the check constraint
 * already guarantees the two agree, so reading intent cannot fall
 * through to the wrong branch. A missing map entry returns `null` — the
 * caller renders an em dash for an absence (DESIGN.md §8), it does not
 * invent a name.
 */
export function blockDisplayName(
  block: {
    target: string;
    blocking_user_id: string | null;
    blocking_task_id?: string | null;
    blocking_external: string | null;
  },
  nameByUserId: Map<string, string | null>,
  titleByTaskId: Map<string, string>
): string | null {
  switch (block.target) {
    case 'person':
      return block.blocking_user_id ? (nameByUserId.get(block.blocking_user_id) ?? null) : null;
    case 'task':
      return block.blocking_task_id ? (titleByTaskId.get(block.blocking_task_id) ?? null) : null;
    default:
      return block.blocking_external;
  }
}

/**
 * Attach `ownerPosition` / `ownerName` to a batch of tasks, per Chan's ask
 * that position mean something in the board's grouping.
 *
 * `owner_user_id` is nullable (2026-09-11: unassigned tasks) -- a null
 * owner simply resolves to `ownerName: null, ownerPosition: null`, which
 * is exactly the "Unassigned" state every screen that renders an owner
 * already has to handle for a name it could not look up.
 */
export async function enrichWithOwners<T extends { owner_user_id: string | null }>(
  db: ReturnType<typeof serviceClient>,
  tasks: T[]
): Promise<(T & { ownerPosition: string | null; ownerName: string | null })[]> {
  const ownerIds = [...new Set(tasks.map((t) => t.owner_user_id).filter((id): id is string => id !== null))];
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
    if (t.owner_user_id === null) return { ...t, ownerPosition: null, ownerName: null };
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

/**
 * A task's activity history for the detail dialog's timeline (Chan: "each
 * task should have updates on when it was created, etc so when they open
 * a task, it shows when a task was made"). Two append-only sources, both
 * already governed by RLS the trigger writes into, so nothing here is a
 * new capability:
 *
 *  - `ops.point_ledger` — every status transition this task has ever
 *    made, with its actor, reason and timestamp (`point_ledger_select`:
 *    "any ops member reads the whole ledger"). This IS the task's
 *    submitted/verified/cleared/rejected/cancelled history; there is no
 *    second place that records it.
 *  - `core.audit_logs`, filtered to `entity_type = 'ops.task'` — admin
 *    corrections and direct definition edits. Read on `userClient`, NOT
 *    `serviceClient`, so `audit_select`'s own RLS (`actor_id = caller OR
 *    core.can_read_audit(...)`, which for `ops.task` means oversight or
 *    the task's owner) decides what comes back — a staff owner of a
 *    DIFFERENT task gets an empty array here, not a 403, exactly as RLS
 *    silently filtering a row is treated everywhere else in this file.
 *    This widens nothing: it is the same read `GET /admin/audit` already
 *    grants, scoped to one task instead of everything.
 *
 * Names are resolved with the same `enrichWithOwners` join every other
 * list endpoint in this file pays for — actor ids arrive as raw uuids
 * from both tables and neither carries a display name of its own.
 */
async function taskHistory(
  userDb: ReturnType<typeof userClient>,
  svc: ReturnType<typeof serviceClient>,
  taskId: string
): Promise<{ ledger: unknown[]; auditLogs: unknown[] }> {
  const [{ data: ledger, error: ledgerError }, { data: auditLogs, error: auditError }] = await Promise.all([
    userDb.schema('ops').from('point_ledger').select('*').eq('task_id', taskId).order('created_at', { ascending: true }),
    userDb
      .schema('core')
      .from('audit_logs')
      .select('*')
      .eq('entity_type', 'ops.task')
      .eq('entity_id', taskId)
      .order('created_at', { ascending: true }),
  ]);
  if (ledgerError) throw ledgerError;
  if (auditError) throw auditError;

  const actorIds = [
    ...new Set(
      [...(ledger ?? []).map((r) => r.actor_id), ...(auditLogs ?? []).map((r) => r.actor_id)].filter(
        (v): v is string => Boolean(v)
      )
    ),
  ];
  const named = actorIds.length ? await enrichWithOwners(svc, actorIds.map((owner_user_id) => ({ owner_user_id }))) : [];
  const nameByActor = new Map(named.map((n) => [n.owner_user_id, n.ownerName]));

  return {
    ledger: (ledger ?? []).map((r) => ({ ...r, actorName: r.actor_id ? (nameByActor.get(r.actor_id) ?? null) : null })),
    auditLogs: (auditLogs ?? []).map((r) => ({
      ...r,
      actorName: r.actor_id ? (nameByActor.get(r.actor_id) ?? null) : (r.actor_email ?? null),
    })),
  };
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

  /**
   * ONE task, in exactly the shape a `/board` card carries.
   *
   * Exists so a slim list screen (Now) can open the board's full task
   * detail modal without every list endpoint having to carry the whole
   * row. The shape is not "similar to" a board card, it IS one: the same
   * `enrichWithOwners` / `openBlockCounts` / `noteCounts` helpers, run on
   * a single-element batch. Reimplementing the join here is how the two
   * would silently drift apart the next time a card gains a field.
   *
   * ROUTE ORDER. Fastify's router (find-my-way) is a radix tree and
   * always prefers a static segment over a parametric one, so this
   * cannot shadow the literal `/board` above regardless of registration
   * order -- but that is a property of a dependency, not of this file,
   * so `test/tasks-route.test.ts` asserts it against the real router
   * rather than trusting the reading.
   */
  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };

    // A non-uuid id is not a task, and letting it reach Postgres turns
    // it into an unmapped 22P02 (invalid_text_representation) -- a 500
    // for what is plainly a 404. This is also the honest answer if a
    // future literal route ever did fall through to this handler.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new ApiError(404, 'task not found', 'NOT_FOUND');
    }

    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').from('tasks').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    // RLS filtering a row out and the row not existing are the same
    // answer to the caller on purpose: a 403 here would confirm the
    // existence of a task they may not read.
    if (!data) throw new ApiError(404, 'task not found', 'NOT_FOUND');

    const svc = serviceClient();
    const [enriched] = await enrichWithOwners(svc, [data]);
    const counts = await openBlockCounts(svc, [id]);
    const notes = await noteCounts(svc, [id]);

    return { data: { ...enriched, openBlockCount: counts.get(id) ?? 0, noteCount: notes.get(id) ?? 0 } };
  });

  /**
   * A task's activity history — Chan: "each task should have updates on
   * when it was created, etc so when they open a task, it shows when a
   * task was made." Deliberately a SEPARATE endpoint from `GET /:id`,
   * the same shape decision `/notes` and `/blocks` already made: `GET
   * /:id` has to stay byte-identical to a board card (the Now screen
   * opens this exact modal from a board-card-shaped row, and
   * `test/lifecycle-integration.test.ts` asserts the two payloads
   * `deepEqual` end to end), so a field only the detail dialog needs
   * does not belong on it. `taskHistory` does the actual read/join work;
   * see its own comment for the RLS story.
   */
  app.get('/:id/history', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const svc = serviceClient();
    const { ledger, auditLogs } = await taskHistory(db, svc, id);
    return { data: { ledger, auditLogs } };
  });

  app.post('/', async (req) => {
    const body = createSchema.parse(req.body);
    // `undefined` (the field was never sent) defaults to self; an
    // explicit `null` means "leave it unassigned" and must be told apart
    // from that default, not folded into it.
    const ownerUserId = body.ownerUserId === undefined ? req.user.id : body.ownerUserId;
    if (ownerUserId !== req.user.id && req.user.authority === 'staff') {
      throw new ApiError(
        403,
        'only oversight may create a task for someone else, or leave it unassigned',
        'FORBIDDEN'
      );
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
    // `ops.enforce_initial_task_status` now refuses an insert into a
    // closed week with a clear, human-readable message (20260910170000)
    // -- forward it as a real ApiError instead of the raw Postgres error
    // object every other write route in this file already avoids
    // leaking (commit/uncommit/notes/blocks/override-points below all
    // do the same translation).
    if (error) throw new ApiError(422, error.message, error.code ?? 'CREATE_REFUSED');
    return { data };
  });

  app.patch('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);

    if (body.ownerUserId !== undefined) {
      const isOversight = ['gm', 'founder', 'admin'].includes(req.user.authority) && !req.user.readOnly;
      const isSelfClaim = body.ownerUserId === req.user.id;
      if (!isOversight && !isSelfClaim) {
        throw new ApiError(
          403,
          "only a GM, founder or admin may reassign a task's owner directly -- or, if it is "
            + 'unassigned, the new owner may claim it themselves',
          'FORBIDDEN'
        );
      }
    }

    const db = userClient(req.accessToken);

    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.taskTypeId !== undefined) patch.task_type_id = body.taskTypeId;
    if (body.clientRef !== undefined) patch.client_ref = body.clientRef;
    if (body.ownerUserId !== undefined) patch.owner_user_id = body.ownerUserId;

    const { data, error } = await db.schema('ops').from('tasks').update(patch).eq('id', id).select().single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'PATCH_REFUSED');
    return { data };
  });

  /**
   * Self-claim (2026-09-11, Chan: "any of the employees can take up the
   * task"). A thin, explicit shorthand for `PATCH /:id { ownerUserId: self }`
   * -- same write, same trigger (statement 2c's self-claim branch), just a
   * clearer verb than a generic PATCH for the one action every ops member
   * (not only oversight) may take on someone else's -- well, nobody's --
   * task. The database refuses it outright if the task is not actually
   * unassigned; that refusal sentence is forwarded verbatim.
   */
  app.post('/:id/claim', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('tasks')
      .update({ owner_user_id: req.user.id })
      .eq('id', id)
      .select()
      .single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'CLAIM_REFUSED');
    return { data };
  });

  /**
   * Transfer by invite (2026-09-11, Chan: "invite + accept is enough").
   * The CURRENT owner invites another active ops member to take a task
   * over; nobody else may invite on their behalf. `ops.tasks_assignment_invites`'
   * own BEFORE INSERT trigger is the real gate (current-owner check,
   * active-member check, one-pending-invite-per-task check) -- this route
   * only shapes the request and forwards that trigger's refusal verbatim.
   * Accept/decline/cancel live under `/api/task-invites`, a peer resource,
   * not a task sub-route -- an invite outlives being looked at from "the
   * task's" side the moment it is addressed to someone.
   */
  app.post('/:id/invite-transfer', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ toUserId: z.string().uuid() }).parse(req.body);
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_assignment_invites')
      .insert({ task_id: id, from_user_id: req.user.id, to_user_id: body.toUserId })
      .select()
      .single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'INVITE_REFUSED');
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

    // Titles for `task`-target blocks. Read on `userClient`, not the
    // service client: `ops.tasks` is readable to every ops member
    // already, so this needs no RLS bypass and does not get one. Only
    // paid for when a task-target block actually exists.
    const blockingTaskIds = [
      ...new Set((data ?? []).map((b) => b.blocking_task_id).filter((v): v is string => Boolean(v))),
    ];
    const { data: blockingTasks } = blockingTaskIds.length
      ? await db.schema('ops').from('tasks').select('id, title').in('id', blockingTaskIds)
      : { data: [] as { id: string; title: string }[] };
    const titleById = new Map((blockingTasks ?? []).map((t) => [t.id, t.title]));

    return {
      data: (data ?? []).map((b) => ({
        ...b,
        blockingName: blockDisplayName(b, nameById, titleById),
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

  /**
   * The ONLY way an admin changes a task outside the ordinary ladder --
   * PLAN-ADMIN-CORRECTIONS.md. `requireAuthority('admin')` is the
   * friendlier pre-flight; `ops.admin_correct_task` is the real gate,
   * checking read-only, membership and the reason floor again itself,
   * because SECURITY DEFINER does not go through RLS. `refuseReadOnlyWrites`
   * is not strictly required here (the database already refuses a
   * read-only admin at its own rung 1) but it returns the friendly
   * READ_ONLY_ACCOUNT sentence instead of a raw 422, matching
   * `routes/admin.ts`.
   *
   * Runs on `userClient`, never `serviceClient` -- the RPC's own
   * `core.is_admin()`/`core.is_read_only()` checks must see the real
   * signed-in caller, exactly like every other RPC in this app that
   * carries its own authority ladder.
   */
  app.post(
    '/:id/correct',
    { onRequest: [requireAuthority('admin'), refuseReadOnlyWrites] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = correctTaskSchema.parse(req.body);
      const db = userClient(req.accessToken);
      const { data, error } = await db.schema('ops').rpc('admin_correct_task', {
        p_task_id: id,
        p_changes: toRpcChanges(body.changes),
        p_reason: body.reason,
      });
      // The database's own sentence, forwarded verbatim -- it is written
      // to be read by a person, and translating it here would only make
      // it worse.
      if (error) throw new ApiError(422, error.message, error.code ?? 'CORRECTION_REFUSED');
      return { data };
    }
  );

  /**
   * The ONLY way an admin forces a status past a transition the ordinary
   * ladder refuses (revive a terminal task, skip a rung). Deliberately a
   * SEPARATE endpoint from `/:id/correct` -- a transition is not a
   * column write, and `ops.admin_force_transition` derives no stamp and
   * writes no ledger row; its audit row says `stamps_not_derived: true`
   * rather than leaving that implied. `PATCH /:id`, `POST /:id/status`
   * and `POST /:id/override-points` are untouched by this endpoint --
   * after the migration's trigger fix they already route an admin
   * through the ordinary ladder, which is the point.
   */
  app.post(
    '/:id/force-status',
    { onRequest: [requireAuthority('admin'), refuseReadOnlyWrites] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = forceStatusSchema.parse(req.body);
      const db = userClient(req.accessToken);
      const { data, error } = await db.schema('ops').rpc('admin_force_transition', {
        p_task_id: id,
        p_to: body.to,
        p_reason: body.reason,
      });
      if (error) throw new ApiError(422, error.message, error.code ?? 'FORCE_TRANSITION_REFUSED');
      return { data };
    }
  );

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

    // `.is('resolved_at', null)` narrows this to blocks that are actually
    // OPEN, and it is about the message the caller gets, not about
    // authority.
    //
    // `resolved_at` still has to be sent: the 20260910160000 trigger
    // stamps it with `now()` the moment it FIRST becomes non-null, so a
    // value is what starts the transition -- the trigger's job is to make
    // sure it is the server's clock and not the client's. But that same
    // trigger raises `resolved_at is a server-derived stamp and cannot be
    // changed once set` on a SECOND resolve, and that sentence is written
    // for whoever tampers with the column, not for a person who
    // double-clicked or whose colleague resolved the block a moment
    // earlier. With this filter the second attempt simply matches no row
    // and gets the sentence below.
    const { data, error } = await db
      .schema('ops')
      .from('task_blocks')
      .update({ resolved_at: new Date().toISOString(), resolved_by: req.user.id })
      .eq('id', id)
      .is('resolved_at', null)
      .select()
      .maybeSingle();
    if (error) throw new ApiError(422, error.message, error.code ?? 'RESOLVE_REFUSED');
    if (!data) {
      // Three causes, indistinguishable from here and all needing the
      // same next step from the reader: no such block, the block is
      // already resolved, or RLS refused this caller the update. Naming
      // which one would leak whether a block the caller cannot touch
      // exists.
      throw new ApiError(
        409,
        'That block is already resolved, or it is not yours to resolve.',
        'BLOCK_NOT_OPEN'
      );
    }
    return { data };
  });
}
