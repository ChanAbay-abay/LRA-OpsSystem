/**
 * LRA Global Ops :: /api/briefing — the Monday briefing, in one call
 *
 * PLAN.md §3 / PRD.md §6.2: one endpoint returns everything the live
 * briefing screen needs — last week's scorecard, carry-overs, last
 * week's blocks, and each person's current-week commit candidates — so
 * the screen does not fan out into a half-dozen requests while it is
 * being read out loud in a room.
 *
 * Reliability (PRD.md §5) is Phase 8, not built yet, and is
 * deliberately NOT faked here: the scorecard reports committed/cleared
 * points and a hit-rate computed directly from `ops.tasks`, and leaves
 * reliability out rather than inventing a number this endpoint has no
 * business computing. Chan's ask that the feature "work regardless" of
 * catalog pricing holds throughout — an unpriced (`catalog_points =
 * null`) task simply contributes 0 to every sum, the same as `—` does
 * everywhere else in this app.
 *
 * All task/ledger reads run on `userClient` (RLS already grants any ops
 * member full read on `ops.tasks`/`ops.task_blocks`, PRD.md §6.1);
 * `serviceClient` is used only for the roster's cross-schema name join,
 * matching `routes/me.ts` and `routes/tasks.ts` exactly.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireMembership } from '../middleware/auth.js';
import { serviceClient, userClient } from '../lib/supabase.js';
import { loadOpsRoster } from '../lib/roster.js';
import { ApiError } from '../lib/domain.js';

interface TaskRow {
  id: string;
  title: string;
  status: string;
  owner_user_id: string;
  catalog_points: number | null;
  points_override: number | null;
  points_awarded: number | null;
  committed_points: number | null;
  is_committed: boolean;
  is_recurring: boolean;
  carry_over_count: number;
  first_week_id: string | null;
  created_at: string;
}

interface BlockRow {
  id: string;
  task_id: string;
  target: string;
  blocking_user_id: string | null;
  blocking_external: string | null;
  reason: string;
  created_at: string;
  resolved_at: string | null;
}

export default async function briefingRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  app.get('/:weekId', async (req) => {
    const { weekId } = req.params as { weekId: string };
    const db = userClient(req.accessToken);

    const { data: week, error: weekError } = await db.schema('ops').from('weeks').select('*').eq('id', weekId).maybeSingle();
    if (weekError) throw weekError;
    if (!week) throw new ApiError(404, 'unknown week', 'NOT_FOUND');

    const { data: previousWeek } = await db
      .schema('ops')
      .from('weeks')
      .select('*')
      .eq('week_start', new Date(new Date(week.week_start).getTime() - 7 * 86400000).toISOString().slice(0, 10))
      .maybeSingle();

    const roster = await loadOpsRoster(serviceClient());

    // --- Last week's scorecard --------------------------------------
    let scorecard: Array<{
      userId: string;
      name: string | null;
      position: string;
      committedPoints: number;
      clearedCommittedPoints: number;
      clearedPoints: number;
      hitRate: number | null;
    }> = [];

    if (previousWeek) {
      const { data: committedTasks } = await db
        .schema('ops')
        .from('tasks')
        .select('owner_user_id, status, committed_points')
        .eq('committed_week_id', previousWeek.id);

      const { data: balances } = await db
        .schema('ops')
        .from('v_point_balances')
        .select('user_id, cleared_points')
        .eq('week_id', previousWeek.id);

      const clearedByUser = new Map((balances ?? []).map((b) => [b.user_id as string, b.cleared_points as number]));

      const totals = new Map<string, { committed: number; clearedCommitted: number }>();
      for (const t of (committedTasks ?? []) as Array<{ owner_user_id: string; status: string; committed_points: number | null }>) {
        const cur = totals.get(t.owner_user_id) ?? { committed: 0, clearedCommitted: 0 };
        cur.committed += t.committed_points ?? 0;
        if (t.status === 'cleared') cur.clearedCommitted += t.committed_points ?? 0;
        totals.set(t.owner_user_id, cur);
      }

      scorecard = roster
        .filter((m) => m.position !== 'other')
        .map((m) => {
          const t = totals.get(m.userId) ?? { committed: 0, clearedCommitted: 0 };
          return {
            userId: m.userId,
            name: m.name,
            position: m.position,
            committedPoints: t.committed,
            clearedCommittedPoints: t.clearedCommitted,
            clearedPoints: clearedByUser.get(m.userId) ?? 0,
            hitRate: t.committed > 0 ? t.clearedCommitted / t.committed : null,
          };
        });
    }

    // --- Carry-overs: unfinished work now sitting in this week -------
    const { data: carriedTasks } = await db
      .schema('ops')
      .from('tasks')
      .select('id, title, owner_user_id, carry_over_count, first_week_id, created_at, status')
      .eq('week_id', weekId)
      .gt('carry_over_count', 0)
      .order('carry_over_count', { ascending: false });

    const nameByUser = new Map(roster.map((m) => [m.userId, m.name]));
    const carryOvers = (carriedTasks ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      ownerName: nameByUser.get(t.owner_user_id) ?? null,
      carryOverCount: t.carry_over_count,
      status: t.status,
    }));

    // --- Blocks: open now, plus what was resolved last week ----------
    const { data: openBlocks } = await db
      .schema('ops')
      .from('task_blocks')
      .select('id, task_id, target, blocking_user_id, blocking_external, reason, created_at, resolved_at')
      .is('resolved_at', null);

    let resolvedLastWeek: BlockRow[] = [];
    if (previousWeek) {
      const { data } = await db
        .schema('ops')
        .from('task_blocks')
        .select('id, task_id, target, blocking_user_id, blocking_external, reason, created_at, resolved_at')
        .gte('resolved_at', previousWeek.week_start)
        .lte('resolved_at', previousWeek.week_end);
      resolvedLastWeek = (data ?? []) as BlockRow[];
    }

    const hoursByBlocker = new Map<string, { label: string; hours: number }>();
    for (const b of resolvedLastWeek) {
      if (!b.resolved_at) continue;
      const key = b.blocking_user_id ?? `external:${b.blocking_external}`;
      const label = b.blocking_user_id ? (nameByUser.get(b.blocking_user_id) ?? 'Unknown') : (b.blocking_external ?? 'Unknown');
      const hours = (new Date(b.resolved_at).getTime() - new Date(b.created_at).getTime()) / 36e5;
      const cur = hoursByBlocker.get(key) ?? { label, hours: 0 };
      cur.hours += hours;
      hoursByBlocker.set(key, cur);
    }

    const openBlocksWithAge = ((openBlocks ?? []) as BlockRow[]).map((b) => ({
      ...b,
      hoursOpen: Math.round((Date.now() - new Date(b.created_at).getTime()) / 36e5),
      blockingName: b.blocking_user_id ? (nameByUser.get(b.blocking_user_id) ?? null) : b.blocking_external,
    }));

    // --- Commit section: each person's current-week candidates -------
    const { data: currentTasks } = await db
      .schema('ops')
      .from('tasks')
      .select('id, title, status, owner_user_id, catalog_points, points_override, points_awarded, committed_points, is_committed, is_recurring, carry_over_count, first_week_id, created_at')
      .eq('week_id', weekId)
      .in('status', ['todo', 'in_progress']);

    const commitCandidates: Record<string, TaskRow[]> = {};
    const committed: Record<string, TaskRow[]> = {};
    for (const t of (currentTasks ?? []) as TaskRow[]) {
      const bucket = t.is_committed ? committed : commitCandidates;
      (bucket[t.owner_user_id] ??= []).push(t);
    }

    return {
      data: {
        week,
        previousWeek: previousWeek ?? null,
        roster,
        scorecard,
        carryOvers,
        blocks: {
          open: openBlocksWithAge,
          byBlocker: [...hoursByBlocker.values()].sort((a, b) => b.hours - a.hours),
        },
        commitCandidates,
        committed,
      },
    };
  });
}
