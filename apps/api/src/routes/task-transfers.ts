/**
 * LRA Global Ops :: /api/task-invites
 *
 * The accept/decline/cancel side of a task transfer (2026-09-11, Chan:
 * "invite + accept is enough. either side can cancel/decline."). The
 * invite itself is created from the task's own side --
 * `POST /api/tasks/:id/invite-transfer` -- but once it exists it is
 * addressed to a PERSON, not scoped to the task it happens to be about,
 * so it gets its own resource here, the same reasoning
 * `routes/task-edit-requests.ts` gives for being a peer of `routes/tasks.ts`
 * rather than a sub-route of it.
 *
 * Every write here runs on `userClient`. `ops.task_assignment_invites`'
 * own RLS and triggers (`20260911120000_ops_task_assignment_and_transfer.sql`)
 * are the real gate:
 *   - decline/cancel are ordinary RLS-checked UPDATEs (only the invitee
 *     may decline, only the inviter may cancel, both only while pending);
 *   - accept is NOT reachable by any direct UPDATE at all -- the value
 *     'accepted' is absent from the RLS policy's WITH CHECK entirely, so
 *     "accept" below calls `ops.accept_task_transfer()`, the one
 *     SECURITY DEFINER function that can produce it, and that function
 *     re-checks the caller is the person the invite actually names.
 * This route never re-implements that identity check; it only forwards
 * whatever the database decides, verbatim.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/domain.js';
import { authenticate, requireMembership } from '../middleware/auth.js';
import { userClient } from '../lib/supabase.js';

export default async function taskTransfersRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  /**
   * Invites relevant to the caller -- the ones they sent (outgoing) and
   * the ones addressed to them (incoming). RLS (`task_invites_select`)
   * already scopes this to `from_user_id = caller OR to_user_id = caller
   * OR oversight`, so the query below is the whole story, not a filter
   * layered on top of a wider read.
   */
  app.get('/', async (req) => {
    const q = req.query as { taskId?: string; status?: string };
    const db = userClient(req.accessToken);
    let query = db.schema('ops').from('task_assignment_invites').select('*').order('created_at', { ascending: false });
    if (q.taskId) query = query.eq('task_id', q.taskId);
    if (q.status) query = query.eq('status', q.status);
    const { data, error } = await query;
    if (error) throw error;
    return { data };
  });

  app.post('/:id/decline', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_assignment_invites')
      .update({ status: 'declined' })
      .eq('id', id)
      .select()
      .single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'DECLINE_REFUSED');
    return { data };
  });

  app.post('/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_assignment_invites')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .select()
      .single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'CANCEL_REFUSED');
    return { data };
  });

  const acceptSchema = z.object({ id: z.string().uuid() });

  app.post('/:id/accept', async (req) => {
    const { id } = acceptSchema.parse(req.params);
    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').rpc('accept_task_transfer', { p_invite_id: id });
    if (error) throw new ApiError(422, error.message, error.code ?? 'ACCEPT_REFUSED');
    return { data };
  });
}
