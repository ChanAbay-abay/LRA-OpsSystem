/**
 * LRA Global Ops :: the outbox drainer
 *
 * In-app only in the MVP (PLAN.md §2.3): reads `pending` + `in_app` rows
 * from `core.notification_outbox` and inserts them into
 * `core.notifications`. Email/WhatsApp later is a second drainer against
 * this same table with no call site touched. Runs on `serviceClient`
 * because the outbox has no INSERT/UPDATE policy for `authenticated` at
 * all — it is drained and written only here.
 */

import { serviceClient } from '../lib/supabase.js';

const BATCH_SIZE = 50;

export async function drainOutbox(): Promise<{ drained: number; failed: number }> {
  const db = serviceClient();

  const { data: rows, error } = await db
    .schema('core')
    .from('notification_outbox')
    .select('*')
    .eq('channel', 'in_app')
    .eq('state', 'pending')
    .lte('available_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;

  let drained = 0;
  let failed = 0;

  for (const row of rows ?? []) {
    const { error: insertError } = await db.schema('core').from('notifications').insert({
      user_id: row.recipient_id,
      title: row.title,
      message: row.body,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      link: row.link,
      // The moment the THING happened, not the moment we got around to
      // delivering it. `core.notifications.created_at` defaults to now(),
      // and leaving it to that default dates every notification to the
      // drain -- which was invisible while the drainer ran often, and
      // obvious the first time a backlog was drained: 744 notifications
      // spanning two days all arrived reading the same minute, so the
      // inbox could not be ordered or read.
      created_at: row.created_at,
    });

    if (insertError) {
      failed += 1;
      await db
        .schema('core')
        .from('notification_outbox')
        .update({ state: 'failed', attempts: row.attempts + 1, last_error: insertError.message })
        .eq('id', row.id);
      continue;
    }

    drained += 1;
    await db
      .schema('core')
      .from('notification_outbox')
      .update({ state: 'sent', sent_at: new Date().toISOString(), attempts: row.attempts + 1 })
      .eq('id', row.id);
  }

  return { drained, failed };
}
