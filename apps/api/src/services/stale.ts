/**
 * LRA Global Ops :: the stale-task flagger
 *
 * PLAN.md Phase 7: a daily job that flags tasks with no movement — a
 * `todo`/`in_progress` task whose `last_activity_at` is older than
 * `ops.settings.stale_after_days` — and notifies the owner.
 *
 * THE LOGIC LIVES IN THE DATABASE NOW, in `ops.flag_stale_tasks()`
 * (migration 20260910230000), for the same reason as the drainer: it is
 * a pure set operation, and pg_cron can only call SQL. This file is a
 * thin adapter, not a second implementation.
 *
 * The idempotent-per-task-per-day property came with it unchanged. The
 * obvious design is a `last_stale_notified_at` column on `ops.tasks`;
 * this instead checks `core.notification_outbox` for an `ops.task.stale`
 * row already enqueued for that task since midnight UTC, so running the
 * job twice in one day finds its own prior row on the second pass and
 * skips. That was originally a way to avoid a migration this lane did
 * not own; it is kept now that a migration exists because
 * `alreadyNotifiedToday` below means "outbox rows", and swapping the
 * mechanism would quietly change what the route reports.
 *
 * Still `serviceClient`: it reads and notifies across every owner's
 * tasks, not just the caller's.
 */

import { serviceClient } from '../lib/supabase.js';

export interface FlagStaleResult {
  considered: number;
  flagged: number;
  alreadyNotifiedToday: number;
}

export async function flagStaleTasks(): Promise<FlagStaleResult> {
  const db = serviceClient();

  const { data, error } = await db.schema('ops').rpc('flag_stale_tasks');
  if (error) throw error;

  // A `returns table (...)` function comes back as a one-row array.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { considered: number; flagged: number; already_notified_today: number }
    | undefined;

  return {
    considered: row?.considered ?? 0,
    flagged: row?.flagged ?? 0,
    alreadyNotifiedToday: row?.already_notified_today ?? 0,
  };
}
