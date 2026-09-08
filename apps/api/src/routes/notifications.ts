/**
 * LRA Global Ops :: /api/notifications
 *
 * Reads run on `userClient` (own inbox only, per RLS). The only mutation
 * exposed is marking a notification read, which the RLS trigger already
 * restricts to that one column on the caller's own row — this route
 * does not need to re-check anything the database won't.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { userClient } from '../lib/supabase.js';

export default async function notificationsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);

  app.get('/', async (req) => {
    const q = req.query as { unread?: string };
    const db = userClient(req.accessToken);
    let query = db.schema('core').from('notifications').select('*').order('created_at', { ascending: false });
    if (q.unread === 'true') query = query.eq('is_read', false);
    const { data, error } = await query;
    if (error) throw error;
    return { data };
  });

  app.post('/:id/read', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('core')
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return { data };
  });
}
