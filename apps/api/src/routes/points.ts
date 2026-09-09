/**
 * LRA Global Ops :: /api/points
 *
 * The "bank balance waiting to clear" reads (PRD.md §3.5): cleared /
 * pending-with-GM / pending-with-founder / committed-not-submitted, plus
 * the raw ledger and the oversight queue. All reads run on `userClient`
 * so a plain staff member gets exactly the rows `ops.point_ledger`'s
 * "any ops member reads" policy already grants them — nothing here
 * widens visibility beyond what RLS already allows.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireMembership, requireOversight } from '../middleware/auth.js';
import { userClient, serviceClient } from '../lib/supabase.js';
import { enrichWithOwners } from './tasks.js';

export default async function pointsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  app.get('/me', async (req) => {
    const q = req.query as { weekId?: string; userId?: string };
    const userId = q.userId && req.user.authority !== 'staff' ? q.userId : req.user.id;
    const db = userClient(req.accessToken);

    let query = db.schema('ops').from('v_point_balances').select('*').eq('user_id', userId);
    if (q.weekId) query = query.eq('week_id', q.weekId);
    const { data, error } = await query;
    if (error) throw error;
    return { data };
  });

  app.get('/ledger', async (req) => {
    const q = req.query as { userId?: string; weekId?: string };
    const db = userClient(req.accessToken);
    let query = db.schema('ops').from('point_ledger').select('*').order('created_at', { ascending: false });
    if (q.userId) query = query.eq('user_id', q.userId);
    if (q.weekId) query = query.eq('week_id', q.weekId);
    const { data, error } = await query;
    if (error) throw error;
    return { data };
  });

  // The oversight queue: GM sees `submitted`, founder sees `verified`,
  // both oldest-first with age in hours -- PRD.md §6.4's "a GM who sits
  // on verifications is visible to everyone" is this screen's whole
  // point, so age is computed server-side, not left to the client clock.
  //
  // The server already refuses a GM verifying their own task (422, left
  // alone -- that part works). But with exactly one GM in this company,
  // leaving the GM's own submitted tasks IN the list left a dead-end
  // "Verify" button that could never succeed, cluttering the queue every
  // week (defect #6). Excluding the caller's own tasks here, in the
  // query, means every other client of this endpoint gets the same fix
  // for free rather than each screen re-implementing the filter.
  app.get('/queue', { onRequest: requireOversight() }, async (req) => {
    const status = req.user.authority === 'gm' ? 'submitted' : 'verified';
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('tasks')
      .select('*')
      .eq('status', status)
      .neq('owner_user_id', req.user.id)
      .order('last_activity_at', { ascending: true });
    if (error) throw error;

    const now = Date.now();
    const withAge = (data ?? []).map((t) => ({
      ...t,
      queueKind: 'verify_or_clear',
      ageHours: Math.round((now - new Date(t.last_activity_at).getTime()) / 36e5),
    }));

    // Flagged cancellations sit in the SAME queue but are a distinctly
    // different decision — approving one cancels the task and awards
    // no points, which must never be confusable with the "Verify" /
    // "Approve" buttons above (Chan's explicit ask). Visible to any
    // oversight caller so the GM sees it is pending too; only the
    // clearing founder's own decision will actually be accepted, which
    // `ops.enforce_task_transition` enforces regardless of what this
    // read returns.
    const { data: flagged, error: flaggedError } = await db
      .schema('ops')
      .from('tasks')
      .select('*')
      .eq('status', 'pending_cancellation')
      .order('cancellation_requested_at', { ascending: true });
    if (flaggedError) throw flaggedError;

    const withCancellationAge = (flagged ?? []).map((t) => ({
      ...t,
      queueKind: 'cancellation_decision',
      ageHours: Math.round((now - new Date(t.cancellation_requested_at ?? t.last_activity_at).getTime()) / 36e5),
    }));

    return { data: [...withAge, ...withCancellationAge] };
  });

  /**
   * The founder's weekly digest (Chan, 2026-09-09).
   *
   * "I don't want the founder to keep looking at tasks, just a summary of
   * which ones are good … the founder just wants to monitor." The clearing
   * step itself is unchanged — credits are still only written when the
   * founder approves, because that is what `ops.enforce_task_transition`
   * and the ledger trigger enforce and nothing here touches either. What
   * changes is that he reads a page instead of a queue: four counts, the
   * blocked work with its reasons, and one checklist of GM-verified tasks
   * he can clear in a single action.
   *
   * ONE round trip on purpose. Four separate reads would let the counts in
   * the header disagree with the rows underneath them — the founder would
   * see "32 pts awaiting you" over a list totalling 27 and, correctly, stop
   * trusting the screen. Everything below is derived from a single `tasks`
   * fetch so the summary and the list can never be snapshots of different
   * moments.
   *
   * Reads run on `userClient`, so this endpoint shows the founder exactly
   * what RLS already grants him and widens nothing. `serviceClient` appears
   * only to resolve owner and blocker NAMES — `core.people` lives in
   * another schema, the same manual merge `/board` already does.
   */
  app.get('/digest', { onRequest: requireOversight() }, async (req) => {
    const q = req.query as { weekId?: string };
    const db = userClient(req.accessToken);

    let query = db.schema('ops').from('tasks').select('*');
    if (q.weekId) query = query.eq('week_id', q.weekId);
    const { data: tasks, error } = await query;
    if (error) throw error;

    const svc = serviceClient();
    const enriched = await enrichWithOwners(svc, tasks ?? []);
    const byId = new Map(enriched.map((t) => [t.id, t]));

    // Open blocks, with their reasons — "which ones are blocked and why"
    // is half of what Chan asked the digest to answer, and a count alone
    // answers none of it.
    const { data: openBlocks, error: blockError } = await db
      .schema('ops')
      .from('task_blocks')
      .select('*')
      .is('resolved_at', null);
    if (blockError) throw blockError;
    const relevantBlocks = (openBlocks ?? []).filter((b) => byId.has(b.task_id));

    const blockerIds = [
      ...new Set(relevantBlocks.flatMap((b) => [b.blocking_user_id, b.created_by]).filter((v): v is string => Boolean(v))),
    ];
    const namedBlockers = blockerIds.length
      ? await enrichWithOwners(svc, blockerIds.map((owner_user_id) => ({ owner_user_id })))
      : [];
    const nameById = new Map(namedBlockers.map((n) => [n.owner_user_id, n.ownerName]));

    const now = Date.now();
    const ageHours = (iso: string | null) => (iso ? Math.round((now - new Date(iso).getTime()) / 36e5) : 0);
    const pointsOf = (t: { points_override: number | null; catalog_points: number | null }) =>
      t.points_override ?? t.catalog_points ?? 0;
    const slim = (t: (typeof enriched)[number]) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      owner_user_id: t.owner_user_id,
      ownerName: t.ownerName,
      ownerPosition: t.ownerPosition,
      points: pointsOf(t),
      is_committed: t.is_committed,
      carry_over_count: t.carry_over_count,
      ageHours: ageHours(t.last_activity_at),
    });

    const blockedTaskIds = new Set(relevantBlocks.map((b) => b.task_id));
    const live = enriched.filter((t) => !['cleared', 'cancelled'].includes(t.status));

    // A blocked task is reported ONLY as blocked, never also as in
    // progress. Chan's three summary buckets are meant to partition the
    // week, and a task counted twice makes the totals lie.
    const blocked = relevantBlocks
      .map((b) => {
        const t = byId.get(b.task_id)!;
        return {
          ...slim(t),
          blockId: b.id,
          reason: b.reason,
          blockingName: b.blocking_user_id ? (nameById.get(b.blocking_user_id) ?? null) : b.blocking_external,
          raisedByName: nameById.get(b.created_by) ?? null,
          blockedHours: ageHours(b.created_at),
        };
      })
      .filter((b) => !['cleared', 'cancelled'].includes(b.status))
      .sort((a, b) => b.blockedHours - a.blockedHours);

    const inProgress = live
      .filter((t) => t.status === 'in_progress' && !blockedTaskIds.has(t.id))
      .map(slim)
      .sort((a, b) => b.ageHours - a.ageHours);

    // With the GM — the founder does not act on these, but "who is
    // sitting on what" is exactly the accountability this system exists
    // for, so the wait is shown rather than hidden.
    const withGm = live
      .filter((t) => t.status === 'submitted' && !blockedTaskIds.has(t.id))
      .map(slim)
      .sort((a, b) => b.ageHours - a.ageHours);

    // The action list. Same rule as `/queue`: the founder's own tasks are
    // excluded, because the trigger refuses a self-clear and a button
    // that can never succeed is worse than no button.
    const awaiting = live
      .filter((t) => t.status === 'verified' && !blockedTaskIds.has(t.id) && t.owner_user_id !== req.user.id)
      .map(slim)
      .sort((a, b) => b.ageHours - a.ageHours);

    // Grouped by person, because that is how the founder actually reads
    // it — "is Broker's week good?" is the question, not "is task #7
    // good?". Group order follows the largest wait, so whoever has been
    // waiting longest is at the top.
    const groups = [...new Map(awaiting.map((t) => [t.owner_user_id, t])).keys()].map((userId) => {
      const items = awaiting.filter((t) => t.owner_user_id === userId);
      return {
        userId,
        ownerName: items[0].ownerName,
        ownerPosition: items[0].ownerPosition,
        count: items.length,
        points: items.reduce((n, t) => n + t.points, 0),
        oldestHours: Math.max(...items.map((t) => t.ageHours)),
        tasks: items,
      };
    });
    groups.sort((a, b) => b.oldestHours - a.oldestHours);

    const rejected = live.filter((t) => t.status === 'rejected').map(slim);
    const pendingCancellation = live
      .filter((t) => t.status === 'pending_cancellation')
      .map((t) => ({ ...slim(t), reason: t.cancellation_reason }));

    return {
      data: {
        summary: {
          awaitingCount: awaiting.length,
          awaitingPoints: awaiting.reduce((n, t) => n + t.points, 0),
          awaitingPeople: groups.length,
          blockedCount: blocked.length,
          inProgressCount: inProgress.length,
          inProgressPoints: inProgress.reduce((n, t) => n + t.points, 0),
          withGmCount: withGm.length,
          rejectedCount: rejected.length,
          pendingCancellationCount: pendingCancellation.length,
          // "Stale" here is a plain age threshold on the founder's own
          // pile, not Phase 7's `flag-stale` job (which does not exist
          // yet). Named so it cannot be mistaken for that job's output.
          awaitingOverDayCount: awaiting.filter((t) => t.ageHours >= 24).length,
        },
        groups,
        blocked,
        inProgress,
        withGm,
        rejected,
        pendingCancellation,
      },
    };
  });
}
