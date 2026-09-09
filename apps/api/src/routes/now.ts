/**
 * LRA Global Ops :: /api/now — the Now screen, in one call
 *
 * PLAN.md Phase 7: `/` becomes the real "who is working on what right
 * now" screen, polling every 20s. One person needs four things and
 * nothing else: their own open work, what of that work is blocked and
 * why, what is waiting on THEM for approval (oversight only), and what
 * was just handed to them. All in one round trip — the same reasoning
 * `routes/briefing.ts` and `points.ts#/digest` already give for why a
 * screen like this must not fan out into several requests: separate
 * reads could disagree with each other by the time the last one lands.
 *
 * `apps/web/src/routes/now.tsx` is still Phase 1's placeholder (reads
 * `/api/members` only) as of this session — it has not been wired to
 * this endpoint yet. See this session's report for the note to the web
 * lane.
 *
 * Task reads run on `userClient`, so this shows the caller only what
 * `ops.tasks`' "any ops member reads everything" policy already grants
 * — nothing here widens visibility. `serviceClient` appears only for
 * the owner/blocker name join, the same cross-schema merge every other
 * list endpoint in this app already pays for (routes/tasks.ts,
 * routes/points.ts#/digest, routes/briefing.ts).
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireMembership } from '../middleware/auth.js';
import { userClient, serviceClient } from '../lib/supabase.js';
import { enrichWithOwners } from './tasks.js';

// Not cleared/cancelled: those are done, and cleared is terminal.
// Everything else is work the owner still has to act on or wait on.
const OPEN_STATUSES = ['todo', 'in_progress', 'submitted', 'verified', 'rejected', 'pending_cancellation'];

interface TaskRow {
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

export default async function nowRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  app.get('/', async (req) => {
    const db = userClient(req.accessToken);

    const { data: myTasks, error } = await db
      .schema('ops')
      .from('tasks')
      .select('id, title, status, owner_user_id, created_by, catalog_points, points_override, rejected_reason, last_activity_at, created_at')
      .eq('owner_user_id', req.user.id)
      .in('status', OPEN_STATUSES)
      .order('last_activity_at', { ascending: false });
    if (error) throw error;

    const tasks = (myTasks ?? []) as TaskRow[];
    const taskIds = tasks.map((t) => t.id);

    // What of my own work is blocked, and why -- the caller's tasks
    // only. A block someone else raised on someone else's task is not
    // "waiting on me" and does not belong on this screen.
    const { data: openBlocks, error: blockError } = taskIds.length
      ? await db.schema('ops').from('task_blocks').select('*').in('task_id', taskIds).is('resolved_at', null)
      : { data: [] as Array<Record<string, unknown>>, error: null };
    if (blockError) throw blockError;

    const blockedTaskIds = new Set((openBlocks ?? []).map((b) => b.task_id as string));

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
        .select('id, title, status, owner_user_id, created_by, catalog_points, points_override, rejected_reason, last_activity_at, created_at')
        .eq('status', status)
        .neq('owner_user_id', req.user.id)
        .order('last_activity_at', { ascending: true });
      if (queueError) throw queueError;
      awaitingMyApproval = (queue ?? []) as TaskRow[];
    }

    // Newly assigned: someone else (oversight) created it in my name
    // and I haven't started it yet. Self-limiting on purpose -- no
    // arbitrary time window, since moving the task to `in_progress`
    // naturally drops it off this list.
    const newlyAssigned = tasks.filter((t) => t.status === 'todo' && t.created_by !== t.owner_user_id);

    // One name/position join across everything on the screen, batched
    // once (enrichWithOwners dedupes owner ids internally) -- the same
    // amortised cost /board and /digest already pay, not a new one.
    const svc = serviceClient();
    const combined = [...tasks, ...awaitingMyApproval].filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i);
    const enriched = await enrichWithOwners(svc, combined);
    const byId = new Map(enriched.map((t) => [t.id, t]));

    const blockerIds = [
      ...new Set(
        (openBlocks ?? []).flatMap((b) => [b.blocking_user_id, b.created_by]).filter((v): v is string => Boolean(v))
      ),
    ];
    const namedBlockers = blockerIds.length
      ? await enrichWithOwners(svc, blockerIds.map((owner_user_id) => ({ owner_user_id })))
      : [];
    const nameByBlocker = new Map(namedBlockers.map((n) => [n.owner_user_id, n.ownerName]));

    const pointsOf = (t: TaskRow) => t.points_override ?? t.catalog_points ?? 0;
    const slim = (t: TaskRow) => {
      const e = byId.get(t.id);
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

    // Every open block queried above was fetched BY `task_id in (...my
    // task ids...)`, so `t` is always found here -- no orphan filter
    // needed.
    const blocked = (openBlocks ?? []).map((b) => {
      const t = tasks.find((x) => x.id === b.task_id)!;
      return {
        ...slim(t),
        blockId: b.id,
        reason: b.reason,
        target: b.target,
        blockingName: b.blocking_user_id ? (nameByBlocker.get(b.blocking_user_id as string) ?? null) : b.blocking_external,
        blockedSince: b.created_at,
      };
    });

    return {
      data: {
        myOpenTasks: tasks.filter((t) => !blockedTaskIds.has(t.id)).map(slim),
        blocked,
        awaitingMyApproval: awaitingMyApproval.map(slim),
        newlyAssigned: newlyAssigned.map(slim),
      },
    };
  });
}
