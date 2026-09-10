/**
 * LRA Global Ops :: /api/scoreboard — Phase 8
 *
 * PRD.md §5/§6.5, PLAN.md §5: the team scoreboard and each person's
 * profile. This route is the first real consumer of `@lra/ops-scoring`'s
 * `reliability()` and `applyRecurringCap()` — the formulas themselves
 * are pure and tested in isolation (`packages/ops-scoring/test`); this
 * file's whole job is turning `ops.tasks` / `ops.weeks` /
 * `ops.task_blocks` rows into the plain numbers those functions expect,
 * nothing more.
 *
 * Two figures live at different timescales and PLAN.md is explicit both
 * must be visible, so neither is hidden behind the other:
 *
 *   - "This week" (raw cleared vs. capped score) is the CURRENT,
 *     still-open week — `ops.v_point_balances`, same source `/points`
 *     reads. The capped figure is the recurring cap
 *     (`applyRecurringCap`, PLAN.md §2.6) applied on top of that view,
 *     never in SQL, and it is always labelled next to the raw total so
 *     nobody discovers a silent haircut.
 *   - Reliability is computed over the most recent CLOSED weeks only
 *     (PRD.md §5.2's "last 8 completed weeks") — an in-progress week
 *     has no final commitment outcome yet, so it cannot enter the
 *     ratio.
 *
 * `ops.settings.leaderboard_visibility` (PRD.md §6.5, OPEN-QUESTIONS.md
 * #6) is enforced HERE, server-side, not left to the client to hide a
 * column: when it is `oversight_only`, a `staff` caller's list request
 * is filtered to their own row before it leaves this route, and a
 * `staff` caller requesting another person's profile is refused
 * outright. Reads run on `userClient` (RLS already grants any ops
 * member full read of `ops.tasks`/`ops.task_blocks`/`ops.weeks`,
 * PRD.md §6.1); `serviceClient` is used only for the cross-schema
 * roster join, the same pattern every other list endpoint in this app
 * already pays for (`routes/tasks.ts`, `routes/briefing.ts`,
 * `routes/now.ts`).
 *
 * Cycle time (PRD.md §4/§6.5) is computed across ALL of a person's
 * ever-cleared tasks, not scoped to the reliability window — it is a
 * separate claim ("how long does work take once you start it") from
 * "did you keep your commitments," and PRD.md §4 names no window for
 * it. `ops.tasks.first_in_progress_at` (added 20260910150000) is NULL
 * for any task that pre-dates that migration or never entered
 * `in_progress`; `medianCycleTimeHours` excludes those, never zeroing
 * them, so the median only ever reflects tasks with a real recorded
 * start. It follows the identical `maySeeReliability` gate as
 * reliability/hit-rate (Chan's brief: "same visibility rule").
 */

import type { FastifyInstance } from 'fastify';
import {
  applyRecurringCap,
  isStale,
  manilaWeekStart,
  medianCycleTimeHours,
  reliability,
  type MedianCycleTimeResult,
  type ReliabilityResult,
  type ReliabilityWeek,
} from '@lra/ops-scoring';
import { authenticate, requireMembership } from '../middleware/auth.js';
import { serviceClient, userClient } from '../lib/supabase.js';
import { loadOpsRoster } from '../lib/roster.js';
import { maySeeReliability, ApiError } from '../lib/domain.js';

interface WeekRow {
  id: string;
  week_start: string;
  week_end: string;
  state: string;
}

interface CommittedTaskRow {
  id: string;
  owner_user_id: string;
  status: string;
  committed_points: number | null;
  committed_week_id: string;
}

interface OpenTaskRow {
  owner_user_id: string;
  status: string;
  carry_over_count: number;
  last_activity_at: string;
}

interface BalanceRow {
  user_id: string;
  cleared_points: number;
  cleared_new_points: number;
  cleared_recurring_points: number;
}

interface BlockedByTaskRow {
  task_id: string;
  created_at: string;
}

interface BlockCausedRow {
  blocking_user_id: string;
  created_at: string;
  resolved_at: string | null;
}

interface ClearedTaskRow {
  id: string;
  owner_user_id: string;
  first_in_progress_at: string | null;
  cleared_at: string | null;
}

export interface ScoreboardRow {
  userId: string;
  name: string | null;
  position: string;
  authority: string | null;
  currentWeek: {
    weekId: string;
    weekStart: string;
    rawClearedPoints: number;
    newPoints: number;
    rawRecurringPoints: number;
    cappedRecurringPoints: number;
    cappedScore: number;
  };
  lastClosedWeek: {
    weekId: string;
    weekStart: string;
    committedPoints: number;
    clearedCommittedPoints: number;
    hitRate: number | null;
    /** tasks not cleared/cancelled by week's end / tasks committed that week — PRD.md §4's carry-over rate. */
    carryOverRate: number | null;
  } | null;
  reliability: ReliabilityResult;
  reliabilitySettings: { windowWeeks: number; halfLifeWeeks: number; minWeeksForRating: number };
  /** Hours of OTHER people's work this person has blocked, within the reliability window. Feeds the "blocking others" modifier. */
  hoursBlockedByThem: number;
  /** Hours THIS person's own work has spent blocked, within the reliability window — the exoneration this app owes them. */
  hoursTheyWereBlocked: number;
  /** PRD.md §4: `cleared_at - first_in_progress_at`, minus blocked hours, median across all-time cleared tasks. Founder/admin only, same gate as reliability. */
  cycleTime: MedianCycleTimeResult;
}

interface ScoreboardSummary {
  visibility: 'all' | 'oversight_only';
  weekId: string;
  weekStart: string;
  rows: ScoreboardRow[];
}

async function buildScoreboard(accessToken: string, weekIdOverride?: string): Promise<ScoreboardSummary> {
  const db = userClient(accessToken);

  const { data: settings, error: settingsError } = await db.schema('ops').from('settings').select('*').eq('id', true).single();
  if (settingsError) throw settingsError;

  const windowWeeks: number = settings.reliability_window_weeks ?? 8;
  const halfLifeWeeks: number = settings.reliability_half_life_weeks ?? 3;
  const minWeeksForRating: number = settings.min_weeks_for_rating ?? 3;
  const staleAfterDays: number = settings.stale_after_days ?? 3;
  const capPct: number = settings.recurring_cap_pct ?? 0.4;
  const floorPoints: number = settings.recurring_floor_points ?? 0;
  const visibility: 'all' | 'oversight_only' = settings.leaderboard_visibility ?? 'all';

  // --- The reference "current" week for the points figures -----------
  let currentWeek: WeekRow | null = null;
  if (weekIdOverride) {
    const { data, error } = await db.schema('ops').from('weeks').select('id, week_start, week_end, state').eq('id', weekIdOverride).maybeSingle();
    if (error) throw error;
    currentWeek = data;
  } else {
    const { data, error } = await db
      .schema('ops')
      .from('weeks')
      .select('id, week_start, week_end, state')
      .eq('week_start', manilaWeekStart())
      .maybeSingle();
    if (error) throw error;
    currentWeek = data;
  }
  if (!currentWeek) {
    throw new ApiError(404, 'no week found for the scoreboard to render', 'NO_WEEK');
  }

  // Service client: same roster join as routes/briefing.ts and
  // routes/me.ts (see file header above) — used only to build every
  // row internally; `leaderboard_visibility`/`maySeeReliability` still
  // filter what actually leaves this function before either route
  // handler below returns it (verified 2026-09-10: neither the full
  // roster nor a filtered-out row is ever included in the response).
  const roster = await loadOpsRoster(serviceClient());

  // --- The reliability window: the most recent CLOSED weeks strictly
  // before the current reference week. An in-progress week has no
  // final commitment outcome, so it can never enter the ratio.
  const { data: closedWeeks, error: closedWeeksError } = await db
    .schema('ops')
    .from('weeks')
    .select('id, week_start, week_end, state')
    .eq('state', 'closed')
    .lt('week_start', currentWeek.week_start)
    .order('week_start', { ascending: false })
    .limit(windowWeeks);
  if (closedWeeksError) throw closedWeeksError;
  const window: WeekRow[] = closedWeeks ?? [];
  const windowWeekIds = window.map((w) => w.id);

  // --- Committed tasks across the window, and the blocks declared
  // against them (for the blocked-time exoneration rule, PRD.md §5.2).
  const committedTasks: CommittedTaskRow[] = windowWeekIds.length
    ? (
        await db
          .schema('ops')
          .from('tasks')
          .select('id, owner_user_id, status, committed_points, committed_week_id')
          .in('committed_week_id', windowWeekIds)
      ).data ?? []
    : [];
  const committedTaskIds = committedTasks.map((t) => t.id);

  const blocksOnCommittedTasks: BlockedByTaskRow[] = committedTaskIds.length
    ? (await db.schema('ops').from('task_blocks').select('task_id, created_at').in('task_id', committedTaskIds)).data ?? []
    : [];
  const earliestBlockByTask = new Map<string, string>();
  for (const b of blocksOnCommittedTasks) {
    const cur = earliestBlockByTask.get(b.task_id);
    if (!cur || b.created_at < cur) earliestBlockByTask.set(b.task_id, b.created_at);
  }
  const weekEndById = new Map(window.map((w) => [w.id, w.week_end]));

  // --- weeksByUser: ReliabilityWeek[] per person, most-recent-closed-week first.
  const weeksByUser = new Map<string, ReliabilityWeek[]>();
  for (const w of window) {
    const tasksThisWeek = committedTasks.filter((t) => t.committed_week_id === w.id);
    const byOwner = new Map<string, CommittedTaskRow[]>();
    for (const t of tasksThisWeek) {
      (byOwner.get(t.owner_user_id) ?? byOwner.set(t.owner_user_id, []).get(t.owner_user_id)!).push(t);
    }
    for (const member of roster) {
      const tasks = byOwner.get(member.userId) ?? [];
      let committedPoints = 0;
      let clearedCommittedPoints = 0;
      let exoneratedPoints = 0;
      for (const t of tasks) {
        const pts = t.committed_points ?? 0;
        committedPoints += pts;
        if (t.status === 'cleared') {
          clearedCommittedPoints += pts;
          continue;
        }
        // A block declared before the week ended exonerates a
        // commitment that failed to clear (PRD.md §5.2) — it is
        // excluded from the denominator entirely, never counted as a
        // silent miss.
        const firstBlock = earliestBlockByTask.get(t.id);
        const weekEnd = weekEndById.get(w.id);
        if (firstBlock && weekEnd && firstBlock <= weekEnd) {
          exoneratedPoints += pts;
        }
      }
      const arr = weeksByUser.get(member.userId) ?? [];
      arr.push({ weekId: w.id, weekStart: w.week_start, committedPoints, clearedCommittedPoints, exoneratedPoints });
      weeksByUser.set(member.userId, arr);
    }
  }

  // --- Modifiers: chronic carry-over and staleness read off the
  // person's CURRENTLY open tasks (a live snapshot, not a per-week
  // historical count — PRD.md §5.2 describes both as present-tense
  // conditions). Blocking-others is summed over the same reliability
  // window as the ratio itself, for consistency.
  const { data: openTasksData, error: openTasksError } = await db
    .schema('ops')
    .from('tasks')
    .select('owner_user_id, status, carry_over_count, last_activity_at')
    .in('status', ['todo', 'in_progress']);
  if (openTasksError) throw openTasksError;
  const openTasks: OpenTaskRow[] = openTasksData ?? [];

  const now = new Date();
  const chronicCarryOverByUser = new Map<string, number>();
  const staleByUser = new Map<string, number>();
  for (const t of openTasks) {
    if (t.carry_over_count >= 3) {
      chronicCarryOverByUser.set(t.owner_user_id, (chronicCarryOverByUser.get(t.owner_user_id) ?? 0) + 1);
    }
    if (isStale(new Date(t.last_activity_at), now, staleAfterDays)) {
      staleByUser.set(t.owner_user_id, (staleByUser.get(t.owner_user_id) ?? 0) + 1);
    }
  }

  const windowStart = window.length ? window[window.length - 1].week_start : currentWeek.week_start;
  const { data: blocksCausedData, error: blocksCausedError } = await db
    .schema('ops')
    .from('task_blocks')
    .select('blocking_user_id, created_at, resolved_at')
    .not('blocking_user_id', 'is', null)
    .gte('created_at', `${windowStart}T00:00:00Z`);
  if (blocksCausedError) throw blocksCausedError;
  const blocksCaused: BlockCausedRow[] = blocksCausedData ?? [];

  // --- Hours THIS person's own work has spent blocked, within the
  // window — the flip side of "blocking others" and the mechanism
  // PRD.md §5.2 says must "visibly exonerate": a block on someone's own
  // task never counts against them, and the profile screen shows why.
  const { data: recentBlocksData, error: recentBlocksError } = await db
    .schema('ops')
    .from('task_blocks')
    .select('task_id, created_at, resolved_at')
    .gte('created_at', `${windowStart}T00:00:00Z`);
  if (recentBlocksError) throw recentBlocksError;
  const recentBlocks: Array<{ task_id: string; created_at: string; resolved_at: string | null }> = recentBlocksData ?? [];

  const blockedTaskIds = [...new Set(recentBlocks.map((b) => b.task_id))];
  const { data: blockedOwnersData, error: blockedOwnersError } = blockedTaskIds.length
    ? await db.schema('ops').from('tasks').select('id, owner_user_id').in('id', blockedTaskIds)
    : { data: [] as Array<{ id: string; owner_user_id: string }>, error: null };
  if (blockedOwnersError) throw blockedOwnersError;
  const ownerByTaskId = new Map((blockedOwnersData ?? []).map((t) => [t.id, t.owner_user_id]));

  const blockedHoursByOwner = new Map<string, number>();
  for (const b of recentBlocks) {
    const owner = ownerByTaskId.get(b.task_id);
    if (!owner) continue;
    const end = b.resolved_at ? new Date(b.resolved_at) : now;
    const hours = Math.max(0, (end.getTime() - new Date(b.created_at).getTime()) / 3_600_000);
    blockedHoursByOwner.set(owner, (blockedHoursByOwner.get(owner) ?? 0) + hours);
  }

  const blockedHoursByBlocker = new Map<string, number>();
  for (const b of blocksCaused) {
    const end = b.resolved_at ? new Date(b.resolved_at) : now;
    const hours = Math.max(0, (end.getTime() - new Date(b.created_at).getTime()) / 3_600_000);
    blockedHoursByBlocker.set(b.blocking_user_id, (blockedHoursByBlocker.get(b.blocking_user_id) ?? 0) + hours);
  }

  // --- Cycle time (PRD.md §4): every task this person has ever cleared,
  // with a real recorded start. Not scoped to the reliability window —
  // "how long work takes once started" is a different claim from "did
  // you keep your commitments," and PRD.md §4 names no window for it.
  // Tasks with a null `first_in_progress_at` (pre-date the 20260910150000
  // migration, or never entered `in_progress`) are excluded entirely by
  // the `.not(...)` filter below, before `medianCycleTimeHours` ever sees
  // them — never zeroed, never approximated from `created_at`.
  const { data: clearedTasksData, error: clearedTasksError } = await db
    .schema('ops')
    .from('tasks')
    .select('id, owner_user_id, first_in_progress_at, cleared_at')
    .eq('status', 'cleared')
    .not('first_in_progress_at', 'is', null);
  if (clearedTasksError) throw clearedTasksError;
  const clearedTasks: ClearedTaskRow[] = clearedTasksData ?? [];
  const clearedTaskIds = clearedTasks.map((t) => t.id);

  // Blocked hours per cleared task, so cycle time excludes time spent
  // waiting on someone else (PRD.md §4's "minus total blocked time").
  // A still-open block on an already-cleared task is a data anomaly, not
  // something this route should assume away — fall back to `now` exactly
  // like the "hours they were blocked" computation above.
  const { data: cycleBlocksData, error: cycleBlocksError } = clearedTaskIds.length
    ? await db.schema('ops').from('task_blocks').select('task_id, created_at, resolved_at').in('task_id', clearedTaskIds)
    : { data: [] as Array<{ task_id: string; created_at: string; resolved_at: string | null }>, error: null };
  if (cycleBlocksError) throw cycleBlocksError;
  const blockedHoursByTask = new Map<string, number>();
  for (const b of cycleBlocksData ?? []) {
    const end = b.resolved_at ? new Date(b.resolved_at) : now;
    const hours = Math.max(0, (end.getTime() - new Date(b.created_at).getTime()) / 3_600_000);
    blockedHoursByTask.set(b.task_id, (blockedHoursByTask.get(b.task_id) ?? 0) + hours);
  }

  const clearedTasksByUser = new Map<string, Array<{ firstInProgressAt: Date | null; clearedAt: Date | null; blockedHours: number }>>();
  for (const t of clearedTasks) {
    const arr = clearedTasksByUser.get(t.owner_user_id) ?? [];
    arr.push({
      firstInProgressAt: t.first_in_progress_at ? new Date(t.first_in_progress_at) : null,
      clearedAt: t.cleared_at ? new Date(t.cleared_at) : null,
      blockedHours: blockedHoursByTask.get(t.id) ?? 0,
    });
    clearedTasksByUser.set(t.owner_user_id, arr);
  }

  // --- This week's raw/capped points, from the same view /points reads.
  const { data: balancesData, error: balancesError } = await db
    .schema('ops')
    .from('v_point_balances')
    .select('user_id, cleared_points, cleared_new_points, cleared_recurring_points')
    .eq('week_id', currentWeek.id);
  if (balancesError) throw balancesError;
  const balanceByUser = new Map((balancesData ?? []).map((b: BalanceRow) => [b.user_id, b]));

  const rows: ScoreboardRow[] = roster
    .filter((m) => m.position !== 'other')
    .map((m) => {
      const balance = balanceByUser.get(m.userId);
      const cap = applyRecurringCap({
        newPoints: balance?.cleared_new_points ?? 0,
        recurringPoints: balance?.cleared_recurring_points ?? 0,
        capPct,
        floorPoints,
      });

      const weeks = weeksByUser.get(m.userId) ?? [];
      const mostRecent = weeks[0];
      const cleanSweepThisWeek = !!mostRecent && mostRecent.committedPoints > 0 && mostRecent.clearedCommittedPoints === mostRecent.committedPoints;

      const rel = reliability(
        weeks,
        {
          chronicCarryOverTasks: chronicCarryOverByUser.get(m.userId) ?? 0,
          staleTaskCount: staleByUser.get(m.userId) ?? 0,
          blockedHoursCausedToOthers: blockedHoursByBlocker.get(m.userId) ?? 0,
          cleanSweepThisWeek,
        },
        { windowWeeks, halfLifeWeeks, minWeeksForRating }
      );

      let carryOverRate: number | null = null;
      if (mostRecent) {
        const tasksThatWeek = committedTasks.filter((t) => t.committed_week_id === mostRecent.weekId && t.owner_user_id === m.userId);
        if (tasksThatWeek.length > 0) {
          const carried = tasksThatWeek.filter((t) => !['cleared', 'cancelled'].includes(t.status)).length;
          carryOverRate = carried / tasksThatWeek.length;
        }
      }

      const lastClosedWeek = mostRecent
        ? {
            weekId: mostRecent.weekId,
            weekStart: mostRecent.weekStart,
            committedPoints: mostRecent.committedPoints,
            clearedCommittedPoints: mostRecent.clearedCommittedPoints,
            hitRate: mostRecent.committedPoints > 0 ? mostRecent.clearedCommittedPoints / mostRecent.committedPoints : null,
            carryOverRate,
          }
        : null;

      return {
        userId: m.userId,
        name: m.name,
        position: m.position,
        authority: m.authority,
        currentWeek: {
          weekId: currentWeek!.id,
          weekStart: currentWeek!.week_start,
          rawClearedPoints: balance?.cleared_points ?? 0,
          newPoints: balance?.cleared_new_points ?? 0,
          rawRecurringPoints: balance?.cleared_recurring_points ?? 0,
          cappedRecurringPoints: cap.cappedRecurringPoints,
          cappedScore: cap.totalPoints,
        },
        lastClosedWeek,
        reliability: rel,
        reliabilitySettings: { windowWeeks, halfLifeWeeks, minWeeksForRating },
        hoursBlockedByThem: Math.round((blockedHoursByBlocker.get(m.userId) ?? 0) * 10) / 10,
        hoursTheyWereBlocked: Math.round((blockedHoursByOwner.get(m.userId) ?? 0) * 10) / 10,
        cycleTime: medianCycleTimeHours(clearedTasksByUser.get(m.userId) ?? []),
      };
    })
    .sort((a, b) => b.currentWeek.cappedScore - a.currentWeek.cappedScore);

  return { visibility, weekId: currentWeek.id, weekStart: currentWeek.week_start, rows };
}

// PLAN.md §10 #4, Chan 2026-09-10: "dont show the reliability metric for
// non-founder members and the hit rate." Founder + admin only — a `gm`
// caller is explicitly non-founder per Chan's own wording (§10.2 flags
// this as a judgement call, not a typo). Enforced HERE, the same way
// `leaderboard_visibility` already is: the field is genuinely absent
// from the JSON for a caller who may not see it, not hidden by the
// client. What stays for everyone — points, cleared totals, velocity —
// is Chan's own reasoning restated in §10.2: the point system exists so
// staff can track their own progress, and that isn't the judgement
// `reliability`/`hitRate` carry about them.
// `maySeeReliability` now lives in `lib/domain.ts` — /api/briefing needs
// the identical rule for its standup scorecard.

type PublicLastClosedWeek = Omit<NonNullable<ScoreboardRow['lastClosedWeek']>, 'hitRate'> & { hitRate?: number | null };

type PublicRow = Omit<ScoreboardRow, 'reliability' | 'reliabilitySettings' | 'lastClosedWeek' | 'cycleTime'> & {
  reliability?: ReliabilityResult;
  reliabilitySettings?: ScoreboardRow['reliabilitySettings'];
  lastClosedWeek: PublicLastClosedWeek | null;
  cycleTime?: MedianCycleTimeResult;
};

function stripReliability(row: ScoreboardRow): PublicRow {
  // Cycle time follows the identical rule as reliability/hit-rate — the
  // key is genuinely absent from the JSON for anyone who isn't
  // founder/admin, not hidden client-side (Chan's brief, PLAN.md §10 #4's
  // established pattern applied to the same gate).
  const { reliability: _reliability, reliabilitySettings: _reliabilitySettings, cycleTime: _cycleTime, ...rest } = row;
  return {
    ...rest,
    lastClosedWeek: row.lastClosedWeek
      ? (() => {
          const { hitRate: _hitRate, ...lastClosedRest } = row.lastClosedWeek;
          return lastClosedRest;
        })()
      : null,
  };
}

export default async function scoreboardRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  app.get('/', async (req) => {
    const q = req.query as { weekId?: string };
    const summary = await buildScoreboard(req.accessToken, q.weekId);
    const canSeeReliability = maySeeReliability(req.user.authority);

    // OPEN-QUESTIONS.md #6 / PRD.md §6.5: `oversight_only` means a
    // staff caller sees only their own row on the team screen — this
    // is a real access rule, enforced here, not a client-side hide.
    // Independent of that rule: reliability/hit-rate are stripped per
    // row for anyone who isn't founder/admin, even oversight (`gm`).
    const rows = (
      summary.visibility === 'oversight_only' && req.user.authority === 'staff'
        ? summary.rows.filter((r) => r.userId === req.user.id)
        : summary.rows
    ).map((r) => (canSeeReliability ? r : stripReliability(r)));

    return { data: { ...summary, rows } };
  });

  app.get('/:userId', async (req) => {
    const { userId } = req.params as { userId: string };
    const q = req.query as { weekId?: string };
    const summary = await buildScoreboard(req.accessToken, q.weekId);

    if (summary.visibility === 'oversight_only' && req.user.authority === 'staff' && userId !== req.user.id) {
      throw new ApiError(
        403,
        "This company's scoreboard is limited to your own numbers. Ask oversight to see anyone else's.",
        'LEADERBOARD_RESTRICTED'
      );
    }

    const row = summary.rows.find((r) => r.userId === userId);
    if (!row) throw new ApiError(404, 'unknown person, or not an active ops member', 'NOT_FOUND');
    return { data: maySeeReliability(req.user.authority) ? row : stripReliability(row) };
  });
}
