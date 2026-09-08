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
import { userClient } from '../lib/supabase.js';

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
  app.get('/queue', { onRequest: requireOversight() }, async (req) => {
    const status = req.user.authority === 'gm' ? 'submitted' : 'verified';
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('tasks')
      .select('*')
      .eq('status', status)
      .order('last_activity_at', { ascending: true });
    if (error) throw error;

    const now = Date.now();
    const withAge = (data ?? []).map((t) => ({
      ...t,
      ageHours: Math.round((now - new Date(t.last_activity_at).getTime()) / 36e5),
    }));
    return { data: withAge };
  });
}
