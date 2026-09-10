/**
 * LRA Global Ops :: the outbox drainer
 *
 * In-app only in the MVP (PLAN.md §2.3): `pending` + `in_app` rows from
 * `core.notification_outbox` become rows in `core.notifications`.
 * Email/WhatsApp later is a second drainer against this same table with
 * no call site touched.
 *
 * THE LOGIC LIVES IN THE DATABASE NOW, in
 * `core.drain_notification_outbox(int)` (migration 20260910230000). It
 * moved there so pg_cron can run it: pg_cron runs inside Postgres and
 * cannot reach a Fastify server on a laptop, and this job is a pure
 * table-to-table set operation, so SQL is its natural home. This file is
 * deliberately a thin adapter and NOT a second implementation -- two
 * copies of the same loop would drift, and the one that drifted would be
 * the one nobody was watching.
 *
 * Everything the TypeScript used to guarantee is guaranteed there
 * instead, including carrying the outbox row's `created_at` onto the
 * notification rather than letting it default to the drain time. See
 * that migration's header for why that matters.
 *
 * Still `serviceClient`: the outbox has no INSERT/UPDATE policy for
 * `authenticated` at all, and the SQL function is granted to
 * `service_role` only.
 */

import { serviceClient } from '../lib/supabase.js';

// Unchanged from the TypeScript drainer this replaced. The SQL function
// defaults to 500; passing 50 explicitly keeps the batch size the route
// has always had rather than silently widening it.
const BATCH_SIZE = 50;

export async function drainOutbox(): Promise<{ drained: number; failed: number }> {
  const db = serviceClient();

  const { data, error } = await db
    .schema('core')
    .rpc('drain_notification_outbox', { p_limit: BATCH_SIZE });
  if (error) throw error;

  // A `returns table (...)` function comes back as a one-row array.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { drained: number; failed: number }
    | undefined;

  return { drained: row?.drained ?? 0, failed: row?.failed ?? 0 };
}
