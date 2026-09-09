/**
 * LRA Global Ops :: the stale-task flagger
 *
 * PLAN.md Phase 7: a daily job that flags tasks with no movement — a
 * `todo`/`in_progress` task whose `last_activity_at` is older than
 * `ops.settings.stale_after_days` — and notifies the owner. Mirrors the
 * shape of `services/outbox.ts` exactly: a plain async function the
 * `/api/jobs/*` route calls, runs on `serviceClient` because it reads
 * and notifies across every owner's tasks, not just the caller's.
 *
 * IDEMPOTENT PER TASK PER DAY, without a schema change. The obvious
 * design is a `last_stale_notified_at` column on `ops.tasks`, but that
 * is a migration and this lane does not own `supabase/` (see this
 * session's report for the request left for the migrations lane, if
 * one is still wanted later). Instead this checks
 * `core.notification_outbox` itself: before flagging a task, it looks
 * for an `ops.task.stale` row already enqueued for that task since
 * midnight UTC. Running the job twice in one day finds its own prior
 * row on the second pass and skips — no double notification, no new
 * column.
 */

import { serviceClient, enqueueNotification } from '../lib/supabase.js';

const DEFAULT_STALE_DAYS = 3;
// Movement is only meaningful while a task is actively being worked.
// Once it has left the owner's hands (submitted/verified/etc.) the
// clock belongs to `/api/points/queue`'s age-in-hours, not this job.
const ACTIVE_STATUSES = ['todo', 'in_progress'];

export interface FlagStaleResult {
  considered: number;
  flagged: number;
  alreadyNotifiedToday: number;
}

export async function flagStaleTasks(): Promise<FlagStaleResult> {
  const db = serviceClient();

  const { data: settings, error: settingsError } = await db
    .schema('ops')
    .from('settings')
    .select('stale_after_days')
    .eq('id', true)
    .maybeSingle();
  if (settingsError) throw settingsError;
  const staleAfterDays = settings?.stale_after_days ?? DEFAULT_STALE_DAYS;

  const cutoff = new Date(Date.now() - staleAfterDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: tasks, error } = await db
    .schema('ops')
    .from('tasks')
    .select('id, title, owner_user_id, last_activity_at')
    .in('status', ACTIVE_STATUSES)
    .lt('last_activity_at', cutoff);
  if (error) throw error;

  const considered = tasks?.length ?? 0;
  if (!considered) return { considered: 0, flagged: 0, alreadyNotifiedToday: 0 };

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { data: alreadyNotified, error: outboxError } = await db
    .schema('core')
    .from('notification_outbox')
    .select('entity_id')
    .eq('event_type', 'ops.task.stale')
    .gte('created_at', todayStart.toISOString())
    .in(
      'entity_id',
      (tasks ?? []).map((t) => t.id)
    );
  if (outboxError) throw outboxError;
  const notifiedToday = new Set((alreadyNotified ?? []).map((r) => r.entity_id as string));

  let flagged = 0;
  for (const task of tasks ?? []) {
    if (notifiedToday.has(task.id)) continue;

    const days = Math.floor((Date.now() - new Date(task.last_activity_at).getTime()) / 86_400_000);
    await enqueueNotification({
      recipientId: task.owner_user_id,
      module: 'ops',
      eventType: 'ops.task.stale',
      entityType: 'ops.task',
      entityId: task.id,
      title: 'Task has gone stale',
      body: `"${task.title}" has had no movement in ${days} day${days === 1 ? '' : 's'}.`,
      link: '/board',
    });
    flagged += 1;
  }

  return { considered, flagged, alreadyNotifiedToday: notifiedToday.size };
}
