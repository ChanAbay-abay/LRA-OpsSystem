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
  manilaDayBounds,
  manilaDayStart,
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

// ---------------------------------------------------------------------
// The activity heatmap (DESIGN.md §19) — Chan, 2026-09-10: "like git
// commits, the greens on how many tasks they complete on those days,
// the greener it is — but instead of green use a blue."
//
// A cell counts TASKS that reached `cleared` on one Manila calendar day
// (§19.1) — read straight off `ops.point_ledger` where `state =
// 'cleared'`, the SAME rows the balance figures above are built from, so
// the picture can never disagree with the number over it. One
// `point_ledger` row with `state = 'cleared'` is written exactly once
// per task (the trigger fires on the transition, and the ledger is
// append-only), so counting rows per day IS counting tasks per day —
// no separate task read is needed.
// ---------------------------------------------------------------------

export interface ActivityDay {
  /** Manila calendar day, `YYYY-MM-DD` (`manilaDayStart`). */
  date: string;
  /** Tasks that reached `cleared` on this day. What the cell paints. */
  count: number;
  /** Points those tasks were worth — the tooltip's second line, never the cell's colour (§19.1). */
  points: number;
}

export interface ActivityWindow {
  /** Oldest to newest, always whole Manila weeks (Monday..Sunday), `windowWeeks * 7` entries. */
  days: ActivityDay[];
  windowWeeks: number;
  /** Sum of `count` across every day in the window — the total line (§19.6). */
  totalCleared: number;
  /**
   * The Manila day this person's `ops` membership began, or `null` if
   * unknown. A day strictly before this is an ABSENCE ("we weren't
   * watching yet"), not a zero (§19.5) — the client, not this function,
   * decides which days that covers, since it also has to know which
   * days are simply in the future.
   */
  sinceDate: string | null;
}

/** The one column `ops.point_ledger` gives this function that it needs. */
export interface ActivityLedgerRow {
  user_id: string;
  created_at: string;
  points: number;
}

/** DESIGN.md §19.2: 26 weeks is the full variant's measured maximum. */
export const ACTIVITY_WINDOW_WEEKS = 26;

/**
 * Calendar-date arithmetic on a `YYYY-MM-DD` string. Both the input and
 * the output are already Manila calendar days by the time anything here
 * touches them, so this is plain date math with no further timezone
 * conversion — `manilaDayStart` is what did the timezone work, upstream
 * of this function.
 */
function addDaysToIsoDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Every day of the window, per person in `userIds`, even a person with
 * zero cleared ledger rows — DESIGN.md §19.5's "render the full empty
 * grid anyway" needs a real day list to render, not a missing key.
 *
 * The window is anchored on `referenceWeekStart` (the same reference
 * week the rest of `buildScoreboard` uses, so `?weekId=` moves the
 * heatmap along with everything else) and always ends on that week's
 * Sunday — full weeks only, so the grid's columns are never a ragged
 * partial week. `rows` should already be filtered to `state = 'cleared'`
 * before this function ever sees them; it does not re-check `state`.
 */
export function buildActivityByUser(
  rows: ActivityLedgerRow[],
  userIds: string[],
  referenceWeekStart: string,
  sinceDateByUser: Map<string, string | null>,
  weeks: number = ACTIVITY_WINDOW_WEEKS
): Map<string, ActivityWindow> {
  const windowStart = addDaysToIsoDate(referenceWeekStart, -(weeks - 1) * 7);
  const windowEnd = addDaysToIsoDate(referenceWeekStart, 6);

  const byUserByDay = new Map<string, Map<string, { count: number; points: number }>>();
  for (const row of rows) {
    const day = manilaDayStart(new Date(row.created_at));
    if (day < windowStart || day > windowEnd) continue;
    const byDay = byUserByDay.get(row.user_id) ?? new Map<string, { count: number; points: number }>();
    const cell = byDay.get(day) ?? { count: 0, points: 0 };
    cell.count += 1;
    cell.points += row.points;
    byDay.set(day, cell);
    byUserByDay.set(row.user_id, byDay);
  }

  const out = new Map<string, ActivityWindow>();
  for (const userId of userIds) {
    const byDay = byUserByDay.get(userId);
    const days: ActivityDay[] = [];
    let totalCleared = 0;
    for (let cursor = windowStart; cursor <= windowEnd; cursor = addDaysToIsoDate(cursor, 1)) {
      const cell = byDay?.get(cursor);
      days.push({ date: cursor, count: cell?.count ?? 0, points: cell?.points ?? 0 });
      totalCleared += cell?.count ?? 0;
    }
    out.set(userId, { days, windowWeeks: weeks, totalCleared, sinceDate: sinceDateByUser.get(userId) ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------
// Point windows (Chan, 2026-09-10: "i dont see a point in seeing the
// raw points. can we have a display as well of points that are yet to
// be done, points pending and waiting approval, and completed. then
// another one to have the points with total points that they could
// have. should have record of this week, month, 3 month, and overall").
//
// Four windows, one read. Everything below is pure and lives outside
// `buildScoreboard` so the bucketing and the valuation fallbacks can be
// tested without a database — the fallbacks are the part most likely to
// be wrong, because a task's worth is recorded in three different
// columns depending on how far it got.
// ---------------------------------------------------------------------

export interface PointBuckets {
  label: string;
  /** Weeks actually inside this window — fewer than the nominal 4/13 while the company is young. */
  weekCount: number;
  toDo: number;
  pending: number;
  completed: number;
  /** `pending_cancellation`: flagged but undecided, so still on the plate and still counted in `possible`. */
  atRisk: number;
  possible: number;
  taskCounts: { toDo: number; pending: number; completed: number; atRisk: number };
}

export interface ScoreboardPeriods {
  week: PointBuckets;
  month: PointBuckets;
  quarter: PointBuckets;
  all: PointBuckets;
}

/** The columns the windows need, and nothing else — one read serves all four. */
export interface PeriodTaskRow {
  owner_user_id: string;
  status: string;
  week_id: string;
  points_awarded: number | null;
  points_override: number | null;
  catalog_points: number | null;
}

type Bucket = 'toDo' | 'pending' | 'completed' | 'atRisk';

/**
 * Which bucket a status falls in, or null for "not a point anyone is
 * owed either way". `cancelled` is the only null: a cancelled task is
 * not a point someone failed to earn, so it is excluded from every
 * bucket AND from `possible` — counting it would invent a debt out of a
 * decision to stop doing something.
 */
function bucketFor(status: string): Bucket | null {
  switch (status) {
    case 'todo':
    case 'in_progress':
    // A returned task is work still owed, not work banked — it belongs
    // with `todo`, which is also the only status the trigger lets it
    // move to.
    case 'rejected':
      return 'toDo';
    case 'submitted':
    case 'verified':
      return 'pending';
    case 'cleared':
      return 'completed';
    case 'pending_cancellation':
      return 'atRisk';
    case 'cancelled':
      return null;
    default:
      return null;
  }
}

/**
 * What a task is worth in these windows.
 *
 * A CLEARED task's worth is settled: `points_awarded` is what the
 * trigger actually banked, and it is the only figure that matches the
 * ledger. Anything not yet cleared has no awarded figure, so the best
 * available claim is the override if oversight set one, else the
 * catalog snapshot taken at creation. A task with neither (an ad-hoc
 * task with no type, before anyone priced it) is worth 0 — an honest
 * zero, not a guess.
 */
export function taskWorth(t: PeriodTaskRow): number {
  if (t.status === 'cleared') return t.points_awarded ?? t.points_override ?? t.catalog_points ?? 0;
  return t.points_override ?? t.catalog_points ?? 0;
}

function emptyBuckets(label: string, weekCount: number): PointBuckets {
  return {
    label,
    weekCount,
    toDo: 0,
    pending: 0,
    completed: 0,
    atRisk: 0,
    possible: 0,
    taskCounts: { toDo: 0, pending: 0, completed: 0, atRisk: 0 },
  };
}

function bucketize(tasks: PeriodTaskRow[], label: string, weekCount: number): PointBuckets {
  const out = emptyBuckets(label, weekCount);
  for (const t of tasks) {
    const bucket = bucketFor(t.status);
    if (!bucket) continue;
    out[bucket] += taskWorth(t);
    out.taskCounts[bucket] += 1;
  }
  // "Total points they could have" (Chan's second display) is the sum of
  // the four, not a separate figure — so it can never disagree with the
  // parts it is made of.
  out.possible = out.toDo + out.pending + out.completed + out.atRisk;
  return out;
}

/**
 * The four windows, per person, from ONE task list.
 *
 * Windows are Manila weeks (`ops.weeks.week_start`) anchored on the
 * reference week — the week the rest of this route is reporting on, so
 * `?weekId=` moves all of them together rather than leaving "this week"
 * and "last 4 weeks" describing different periods. `month`/`quarter` are
 * the 4 / 13 most recent weeks that EXIST up to and including the
 * reference week, not calendar arithmetic: a week with no row is a week
 * the company did not run, and stretching the window over it would
 * quietly change what "last 4 weeks" means.
 *
 * `all` is deliberately NOT re-anchored — it is every week that exists,
 * including any after the reference week. "Overall" is a person's whole
 * record; re-anchoring it would make a founder browsing back to March
 * see a shrinking all-time total, which is not what the word means.
 *
 * Every user in `userIds` gets a row even with no tasks at all: four
 * genuine zeros, with the real `weekCount` attached, rather than a
 * missing key the client has to guess at.
 */
export function buildPeriodsByUser(
  tasks: PeriodTaskRow[],
  weeks: Array<{ id: string; week_start: string }>,
  referenceWeekStart: string,
  userIds: string[]
): Map<string, ScoreboardPeriods> {
  const descending = [...weeks].sort((a, b) => b.week_start.localeCompare(a.week_start));
  const anchored = descending.filter((w) => w.week_start <= referenceWeekStart);

  const windows: Array<{ key: keyof ScoreboardPeriods; label: string; weekIds: Set<string> }> = [
    {
      key: 'week',
      label: 'This week',
      weekIds: new Set(descending.filter((w) => w.week_start === referenceWeekStart).map((w) => w.id)),
    },
    { key: 'month', label: 'Last 4 weeks', weekIds: new Set(anchored.slice(0, 4).map((w) => w.id)) },
    { key: 'quarter', label: 'Last 13 weeks', weekIds: new Set(anchored.slice(0, 13).map((w) => w.id)) },
    { key: 'all', label: 'All time', weekIds: new Set(descending.map((w) => w.id)) },
  ];

  const tasksByUser = new Map<string, PeriodTaskRow[]>();
  for (const t of tasks) {
    const arr = tasksByUser.get(t.owner_user_id) ?? [];
    arr.push(t);
    tasksByUser.set(t.owner_user_id, arr);
  }

  const out = new Map<string, ScoreboardPeriods>();
  for (const userId of userIds) {
    const mine = tasksByUser.get(userId) ?? [];
    const periods = {} as ScoreboardPeriods;
    for (const w of windows) {
      periods[w.key] = bucketize(
        mine.filter((t) => w.weekIds.has(t.week_id)),
        w.label,
        w.weekIds.size
      );
    }
    out.set(userId, periods);
  }
  return out;
}

export interface ScoreboardRow {
  userId: string;
  name: string | null;
  position: string;
  authority: string | null;
  /**
   * `core.users.read_only` (ERC, DCA). Carried on the row so the LIST
   * handler can leave them off the team rail while `GET /:userId` still
   * resolves their profile -- see the filter in the `/` handler below for
   * why those two answers differ.
   */
  readOnly: boolean;
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
  /** Points to do / pending / completed / at risk, over four windows. Visible to everyone — see `stripReliability` below. */
  periods: ScoreboardPeriods;
  /**
   * Tasks cleared per Manila day, DESIGN.md §19. It belongs to the
   * person, not to management (Chan: "so staff can stay accountable on
   * their own"), so it is visible to everyone including staff and is
   * unaffected by `stripReliability` below, same as `periods`.
   */
  activity: ActivityWindow;
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

  // --- The four point windows (see `buildPeriodsByUser` above). ONE
  // task read covers all four: filtering four times in memory is free,
  // and four round trips that each saw the database at a slightly
  // different moment could disagree with each other about the same
  // task — the identical reasoning `/api/now` and `/api/briefing` are
  // built on. Every week row is fetched too (`ops.weeks` holds one row
  // per week the company has run, so this stays small for years).
  const { data: allWeeksData, error: allWeeksError } = await db
    .schema('ops')
    .from('weeks')
    .select('id, week_start')
    .order('week_start', { ascending: false });
  if (allWeeksError) throw allWeeksError;

  const { data: periodTasksData, error: periodTasksError } = await db
    .schema('ops')
    .from('tasks')
    .select('owner_user_id, status, week_id, points_awarded, points_override, catalog_points');
  if (periodTasksError) throw periodTasksError;

  const periodsByUser = buildPeriodsByUser(
    (periodTasksData ?? []) as PeriodTaskRow[],
    allWeeksData ?? [],
    currentWeek.week_start,
    roster.map((m) => m.userId)
  );

  // --- The activity heatmap (DESIGN.md §19): every `cleared` ledger row
  // in the window, for every roster member, read on the SAME
  // `userClient` as everything else in this route — RLS already grants
  // any ops member read of the whole ledger (`point_ledger_select`,
  // same rule `/api/points/ledger` reads under), so this widens nothing.
  const activityWindowStart = addDaysToIsoDate(currentWeek.week_start, -(ACTIVITY_WINDOW_WEEKS - 1) * 7);
  const { start: activityQueryStart } = manilaDayBounds(activityWindowStart);
  const { data: activityLedgerData, error: activityLedgerError } = await db
    .schema('ops')
    .from('point_ledger')
    .select('user_id, created_at, points')
    .eq('state', 'cleared')
    .gte('created_at', activityQueryStart.toISOString());
  if (activityLedgerError) throw activityLedgerError;

  const sinceDateByUser = new Map(roster.map((m) => [m.userId, m.joinedAt ? manilaDayStart(new Date(m.joinedAt)) : null]));
  const activityByUser = buildActivityByUser(
    (activityLedgerData ?? []) as ActivityLedgerRow[],
    roster.map((m) => m.userId),
    currentWeek.week_start,
    sinceDateByUser
  );

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
        readOnly: m.readOnly,
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
        // `buildPeriodsByUser` was handed the whole roster and the rows
        // below are a subset of it, so this key always exists -- the
        // assertion is Map.get's type, not a real possibility.
        periods: periodsByUser.get(m.userId)!,
        // Same "the assertion is Map.get's type, not a real possibility"
        // reasoning as `periods` above — `buildActivityByUser` was
        // handed the whole roster too.
        activity: activityByUser.get(m.userId)!,
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
  //
  // `periods` deliberately SURVIVES this function. It is points and
  // velocity — the caller's own kind of number, which §10.2 keeps
  // visible to staff on Chan's own reasoning ("the point system exists
  // so staff can track their own progress"). Stripping it would leave a
  // staff member's scoreboard card empty of the very thing it is for.
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
    // A read-only account (ERC, DCA -- the two other brokerages'
    // principals, who watch LRA but do not work in it) can never own,
    // submit or clear a task, so its card was a permanently empty seat on
    // the team's rail: not "scored zero this week" but "cannot ever
    // score", which is a different claim and one the card had no way to
    // make. They still SEE the whole scoreboard -- read-only is a flag on
    // the write half, never the read half (PLAN.md §10) -- they are simply
    // not among the people it measures.
    //
    // Filtered HERE and not in `buildScoreboard`, deliberately: `GET
    // /api/scoreboard/:userId` reads the same summary, and dropping the
    // row upstream would make a read-only person's own profile 404 with
    // "not an active ops member", which is false. The team list and one
    // named person are different questions and get different answers.
    //
    // Judgement call, flagged in PLAN.md §11.4, reversible by deleting
    // this one predicate. `routes/briefing.ts`'s standup scorecard walks
    // the same roster and still lists them; that screen is about who is in
    // the room, which is arguably a different question, so it was left
    // alone rather than changed by extension of this reasoning.
    const rows = (
      summary.visibility === 'oversight_only' && req.user.authority === 'staff'
        ? summary.rows.filter((r) => r.userId === req.user.id)
        : summary.rows.filter((r) => !r.readOnly)
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
