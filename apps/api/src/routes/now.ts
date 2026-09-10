/**
 * LRA Global Ops :: /api/now — the Now screen, in one call
 *
 * PLAN.md Phase 7: `/` becomes the real "who is working on what right
 * now" screen, polling every 20s. One person needs their own open work,
 * what of that work is blocked and why, what is waiting on THEM for
 * approval (oversight only), what was just handed to them, and — added
 * 2026-09-10 — whose work THEY are holding up. All in one round trip:
 * the same reasoning `routes/briefing.ts` and `points.ts#/digest`
 * already give for why a screen like this must not fan out into several
 * requests, since separate reads could disagree with each other by the
 * time the last one lands.
 *
 * `apps/web/src/routes/now.tsx` is the real consumer of this endpoint as
 * of 2026-09-10 (it was Phase 1's `/api/members` placeholder until
 * then). Everything below is on screen, which is why this session's two
 * additions are strictly additive: the four original keys keep their
 * exact shape and `blocked[]` only gains fields.
 *
 * Note what this endpoint deliberately does NOT return: a `canResolve`
 * boolean per block. Who may resolve a block is decided by
 * `ops.task_blocks_update` (20260910190000 — creator, named blocking
 * user, the blocked task's owner, or oversight), and the client mirrors
 * that rule in exactly one place, `lib/task-permissions.ts`. A second
 * server-side copy would be a second thing to drift out of step with the
 * policy. What this route DOES owe the client is the identities that
 * rule is about, which is what `blockingUserId` / `blockCreatedBy` are.
 *
 * Task reads run on `userClient`, so this shows the caller only what
 * `ops.tasks`' "any ops member reads everything" policy already grants
 * — nothing here widens visibility. `serviceClient` appears only for
 * the owner/blocker name join, the same cross-schema merge every other
 * list endpoint in this app already pays for (routes/tasks.ts,
 * routes/points.ts#/digest, routes/briefing.ts).
 *
 * The handler below does IO and nothing else; every decision about what
 * the payload SAYS lives in `assembleNowPayload`, which is pure and
 * covered by `test/now-payload.test.ts`. The ownership rules here (a
 * block on my own task is "waiting on me", the same block seen from the
 * other side is "I am holding this up") are the kind of thing that is
 * easy to get backwards and impossible to notice from a screenshot.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireMembership } from '../middleware/auth.js';
import { userClient, serviceClient } from '../lib/supabase.js';
import { blockDisplayName, enrichWithOwners } from './tasks.js';

// Not cleared/cancelled: those are done, and cleared is terminal.
// Everything else is work the owner still has to act on or wait on.
const OPEN_STATUSES = ['todo', 'in_progress', 'submitted', 'verified', 'rejected', 'pending_cancellation'];

const TASK_COLUMNS =
  'id, title, status, owner_user_id, created_by, catalog_points, points_override, rejected_reason, last_activity_at, created_at';

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  owner_user_id: string;
  created_by: string;
  catalog_points: number | null;
  points_override: number | null;
  rejected_reason: string | null;
  last_activity_at: string;
  created_at: string;
}

export interface BlockRow {
  id: string;
  task_id: string;
  target: string;
  reason: string;
  created_by: string;
  created_at: string;
  blocking_user_id: string | null;
  blocking_task_id: string | null;
  blocking_external: string | null;
}

export interface NowPayloadInput {
  /** The caller's own open tasks, newest activity first. */
  myTasks: TaskRow[];
  /** Open blocks on those tasks (and only those). */
  openBlocks: BlockRow[];
  /** Open blocks naming the caller as the person being waited on. */
  blocksIAmHolding: BlockRow[];
  /** The tasks those blocks sit on, ALREADY filtered to tasks the caller does not own. */
  heldTasks: TaskRow[];
  /** Oversight's approval queue; empty for staff. */
  awaitingMyApproval: TaskRow[];
  /** owner_user_id -> name/position, from the one batched roster join. */
  ownersByUserId: Map<string, { ownerName: string | null; ownerPosition: string | null }>;
  /** user_id -> display name, for the people named in a block. */
  namesByUserId: Map<string, string | null>;
  /**
   * task_id -> title, for the tasks named by a `task`-target block.
   *
   * Required rather than optional on purpose: an absent map would make a
   * task-target block render with no name at all, which is the exact
   * defect this field was added (2026-09-10) to fix.
   */
  titlesByTaskId: Map<string, string>;
}

/**
 * Turn the raw rows into exactly what the Now screen renders.
 *
 * Pure on purpose — see the file header. `heldTasks` arriving
 * pre-filtered is deliberate too: which tasks the caller owns is a
 * question the database answered in the query, and re-deriving it here
 * from `myTasks` would go wrong the moment a held task is one of the
 * caller's own CLOSED tasks (absent from `myTasks`, but still not
 * something they are holding up for someone else).
 */
export function assembleNowPayload(input: NowPayloadInput) {
  const {
    myTasks,
    openBlocks,
    blocksIAmHolding,
    heldTasks,
    awaitingMyApproval,
    ownersByUserId,
    namesByUserId,
    titlesByTaskId,
  } = input;

  const blockedTaskIds = new Set(openBlocks.map((b) => b.task_id));
  const myTaskById = new Map(myTasks.map((t) => [t.id, t]));
  const heldTaskById = new Map(heldTasks.map((t) => [t.id, t]));

  // Newly assigned: someone else (oversight) created it in my name and
  // I haven't started it yet. Self-limiting on purpose -- no arbitrary
  // time window, since moving the task to `in_progress` naturally drops
  // it off this list.
  const newlyAssigned = myTasks.filter((t) => t.status === 'todo' && t.created_by !== t.owner_user_id);

  const pointsOf = (t: TaskRow) => t.points_override ?? t.catalog_points ?? 0;
  const slim = (t: TaskRow) => {
    const e = ownersByUserId.get(t.owner_user_id);
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      ownerUserId: t.owner_user_id,
      ownerName: e?.ownerName ?? null,
      ownerPosition: e?.ownerPosition ?? null,
      points: pointsOf(t),
      rejectedReason: t.rejected_reason,
      lastActivityAt: t.last_activity_at,
      createdAt: t.created_at,
    };
  };

  // Every open block in `openBlocks` was fetched BY `task_id in (...my
  // task ids...)`, so the task is always found -- the guard below is
  // there so a caller passing a mismatched pair gets a short list rather
  // than a crash, not because the route can produce one.
  const blocked = openBlocks
    .map((b) => {
      const t = myTaskById.get(b.task_id);
      if (!t) return null;
      return {
        ...slim(t),
        blockId: b.id,
        reason: b.reason,
        target: b.target,
        // One rule for all three targets, shared with
        // `GET /api/tasks/:id/blocks` (routes/tasks.ts). Before
        // 2026-09-10 this line read `blocking_user_id ? name :
        // blocking_external`, which resolved a `task`-target block to
        // `null` and left the row saying "Waiting on someone else".
        blockingName: blockDisplayName(b, namesByUserId, titlesByTaskId),
        blockedSince: b.created_at,
        // The identities the client needs in order to decide whether the
        // Resolve button belongs to this viewer at all -- the mirror of
        // `ops.task_blocks_update`'s four allowed identities. The
        // owner branch is already `ownerUserId` above and oversight is
        // already on `/api/me`, so these two are what was missing,
        // rather than a new copy of the whole rule.
        blockingUserId: b.blocking_user_id ?? null,
        blockCreatedBy: b.created_by,
        blockCreatedByName: namesByUserId.get(b.created_by) ?? null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Work I am personally holding up. Oldest block first: the longest
  // thing someone else has been waiting on me for is the one that should
  // lead, not the newest one.
  //
  // A block naming me on MY OWN task has no entry in `heldTaskById` and
  // falls out here -- it is already in `blocked` above, where it reads
  // correctly as something waiting on me rather than as a debt I owe
  // somebody else.
  const blockingOthers = blocksIAmHolding
    .map((b) => {
      const t = heldTaskById.get(b.task_id);
      if (!t) return null;
      const e = ownersByUserId.get(t.owner_user_id);
      return {
        blockId: b.id,
        reason: b.reason,
        target: b.target,
        blockedSince: b.created_at,
        taskId: t.id,
        taskTitle: t.title,
        taskStatus: t.status,
        points: pointsOf(t),
        ownerUserId: t.owner_user_id,
        ownerName: e?.ownerName ?? null,
        ownerPosition: e?.ownerPosition ?? null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.blockedSince.localeCompare(b.blockedSince));

  return {
    myOpenTasks: myTasks.filter((t) => !blockedTaskIds.has(t.id)).map(slim),
    blocked,
    awaitingMyApproval: awaitingMyApproval.map(slim),
    newlyAssigned: newlyAssigned.map(slim),
    blockingOthers,
  };
}

export default async function nowRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  app.get('/', async (req) => {
    const db = userClient(req.accessToken);

    const { data: myTasksData, error } = await db
      .schema('ops')
      .from('tasks')
      .select(TASK_COLUMNS)
      .eq('owner_user_id', req.user.id)
      .in('status', OPEN_STATUSES)
      .order('last_activity_at', { ascending: false });
    if (error) throw error;

    const myTasks = (myTasksData ?? []) as unknown as TaskRow[];
    const taskIds = myTasks.map((t) => t.id);

    // What of my own work is blocked, and why -- the caller's tasks
    // only. A block someone else raised on someone else's task is not
    // "waiting on me" and does not belong in this list.
    const { data: openBlocksData, error: blockError } = taskIds.length
      ? await db.schema('ops').from('task_blocks').select('*').in('task_id', taskIds).is('resolved_at', null)
      : { data: [], error: null };
    if (blockError) throw blockError;
    const openBlocks = (openBlocksData ?? []) as unknown as BlockRow[];

    // The mirror image, and the half this screen was missing: open
    // blocks that name ME as the person being waited on, on work that is
    // NOT mine. Chan's ask, verbatim: "i want it to be more clear which
    // tasks you're blocking and which tasks you're not." The query above
    // cannot answer that -- it is scoped to the caller's own task ids by
    // design -- so this is a genuinely differently-scoped second read,
    // not a filter of the first.
    //
    // Not oversight-gated. It is a list of the caller's OWN conduct, and
    // PRD.md §6.1 already makes every ops task readable to every ops
    // member; gating it would hide from someone the one thing they are
    // personally able to fix.
    const { data: holdingData, error: holdingError } = await db
      .schema('ops')
      .from('task_blocks')
      .select('*')
      .eq('blocking_user_id', req.user.id)
      .is('resolved_at', null)
      .order('created_at', { ascending: true });
    if (holdingError) throw holdingError;
    const blocksIAmHolding = (holdingData ?? []) as unknown as BlockRow[];

    // The tasks those blocks sit on, minus my own -- `.in()` on the ids
    // rather than a PostgREST embed, the same way every other read here
    // does it, since RLS is evaluated per table and this app does not
    // depend on cross-schema embeds resolving.
    const heldTaskIds = [...new Set(blocksIAmHolding.map((b) => b.task_id))];
    const { data: heldTasksData, error: heldTasksError } = heldTaskIds.length
      ? await db
          .schema('ops')
          .from('tasks')
          .select(TASK_COLUMNS)
          .in('id', heldTaskIds)
          .neq('owner_user_id', req.user.id)
      : { data: [], error: null };
    if (heldTasksError) throw heldTasksError;
    const heldTasks = (heldTasksData ?? []) as unknown as TaskRow[];

    // Awaiting MY approval -- oversight only, same rule as
    // /api/points/queue: a GM sees `submitted`, a founder sees
    // `verified`, and the caller's own tasks are excluded because the
    // trigger already refuses a self-verify/self-clear (a button that
    // can never succeed is worse than no button).
    let awaitingMyApproval: TaskRow[] = [];
    if (req.user.authority === 'gm' || req.user.authority === 'founder' || req.user.authority === 'admin') {
      const status = req.user.authority === 'gm' ? 'submitted' : 'verified';
      const { data: queue, error: queueError } = await db
        .schema('ops')
        .from('tasks')
        .select(TASK_COLUMNS)
        .eq('status', status)
        .neq('owner_user_id', req.user.id)
        .order('last_activity_at', { ascending: true });
      if (queueError) throw queueError;
      awaitingMyApproval = (queue ?? []) as unknown as TaskRow[];
    }

    // ONE name/position join across everything on the screen, batched
    // once (enrichWithOwners dedupes owner ids internally) -- the same
    // amortised cost /board and /digest already pay, not a new one. The
    // held tasks join in here rather than in a second pass for exactly
    // that reason.
    const svc = serviceClient();
    const combined = [...myTasks, ...awaitingMyApproval, ...heldTasks].filter(
      (t, i, arr) => arr.findIndex((x) => x.id === t.id) === i
    );
    const enriched = await enrichWithOwners(svc, combined);
    const ownersByUserId = new Map(
      enriched.map((t) => [t.owner_user_id, { ownerName: t.ownerName, ownerPosition: t.ownerPosition }])
    );

    // The people NAMED in a block on MY work (the person being waited
    // on, and the person who declared it) are not necessarily task
    // owners, so they need their own lookup -- still one batched call,
    // not one per row. Scoped to `openBlocks` only: `blockingOthers`
    // names nobody but the waiting task's owner, whose name the roster
    // join above already carries, so widening this set would fetch names
    // no field asks for.
    const blockerIds = [
      ...new Set(
        openBlocks.flatMap((b) => [b.blocking_user_id, b.created_by]).filter((v): v is string => Boolean(v))
      ),
    ];
    const namedBlockers = blockerIds.length
      ? await enrichWithOwners(svc, blockerIds.map((owner_user_id) => ({ owner_user_id })))
      : [];
    const namesByUserId = new Map(namedBlockers.map((n) => [n.owner_user_id, n.ownerName]));

    // Titles for the `task`-target blocks on MY work, so a block on
    // another task reads as that task's title instead of "someone
    // else". Scoped to `openBlocks` for the same reason `blockerIds`
    // above is: `blockingOthers` renders no `blockingName` field, so
    // fetching titles for it would fetch data no field asks for. On
    // `userClient` — `ops.tasks` is readable to every ops member, so
    // this needs no service-client bypass — and only issued when a
    // task-target block actually exists.
    const blockingTaskIds = [
      ...new Set(openBlocks.map((b) => b.blocking_task_id).filter((v): v is string => Boolean(v))),
    ];
    const { data: blockingTasksData, error: blockingTasksError } = blockingTaskIds.length
      ? await db.schema('ops').from('tasks').select('id, title').in('id', blockingTaskIds)
      : { data: [] as { id: string; title: string }[], error: null };
    if (blockingTasksError) throw blockingTasksError;
    const titlesByTaskId = new Map((blockingTasksData ?? []).map((t) => [t.id, t.title]));

    return {
      data: assembleNowPayload({
        myTasks,
        openBlocks,
        blocksIAmHolding,
        heldTasks,
        awaitingMyApproval,
        ownersByUserId,
        namesByUserId,
        titlesByTaskId,
      }),
    };
  });
}
