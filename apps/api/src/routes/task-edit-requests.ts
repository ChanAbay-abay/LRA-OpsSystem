/**
 * LRA Global Ops :: /api/task-edit-requests
 *
 * PRD.md §3.6 / Chan: "Once the meeting is concluded, those todos should
 * be set and not editable by the staff. Only admin and founder. GM can
 * flag for edits with the founder(LRA) or admin(me) approving the
 * edits." `20260910140000_ops_task_edit_requests.sql` is the real
 * enforcement (a GM/founder/admin-only INSERT guard, and a
 * no-self-approval UPDATE guard that applies the change atomically on
 * approval); every guard here is convenience only — a nicer 403/400
 * before the round trip, never the actual gate.
 *
 * WHO MAY DECIDE ONE CHANGED ON 2026-09-10, and this comment is the only
 * thing in this file that changed with it. It was the CLEARING founder
 * (`core.is_clearing_founder()`). Chan, briefing the bulk-suggestion
 * work: "then approve by admin or founder" — no clearing qualifier — so
 * `20260910200000_ops_task_edit_batches.sql` widened the decider on both
 * paths to `core.is_founder() and not core.is_read_only()`: any founder
 * or admin, and never a read-only founder (ERC/DCA hold `founder`
 * authority, so once the predicate stopped being
 * `is_clearing_founder()` the read-only clause had to be written down
 * rather than inherited). No code here needed changing, because this
 * route has always deferred the decision to the database — which is the
 * argument for having done it that way. All writes run on
 * `userClient` so the database's own triggers are what decide, exactly
 * like `routes/tasks.ts`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/domain.js';
import { authenticate, requireMembership, requireOversight } from '../middleware/auth.js';
import { userClient, serviceClient } from '../lib/supabase.js';
import { enrichWithOwners } from './tasks.js';

// Presence, not value, decides whether a field is being proposed: a
// client that sends `description: null` is proposing to CLEAR it, which
// is different from not mentioning `description` at all. `.optional()`
// lets zod preserve that distinction (`undefined` vs `null`) all the way
// to the route body.
const createSchema = z.object({
  taskId: z.string().uuid(),
  reason: z.string().min(10, 'a task edit request needs a written reason of at least 10 characters'),
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  taskTypeId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().uuid().optional(),
  clientRef: z.string().nullable().optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(10, 'rejecting an edit request needs a written reason of at least 10 characters'),
});

export default async function taskEditRequestsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  // GM (also founder/admin — see the migration header for why both are
  // allowed to use this path even though they could edit directly).
  // Staff is refused by the DB trigger; this 403 is just a friendlier,
  // earlier version of that refusal.
  app.post('/', { onRequest: requireOversight() }, async (req) => {
    const body = createSchema.parse(req.body);

    if (
      body.title === undefined &&
      body.description === undefined &&
      body.taskTypeId === undefined &&
      body.ownerUserId === undefined &&
      body.clientRef === undefined
    ) {
      throw new ApiError(400, 'an edit request must propose a change to at least one field', 'VALIDATION_ERROR');
    }

    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_edit_requests')
      .insert({
        task_id: body.taskId,
        requested_by: req.user.id,
        reason: body.reason,
        change_title: body.title !== undefined,
        proposed_title: body.title ?? null,
        change_description: body.description !== undefined,
        proposed_description: body.description ?? null,
        change_task_type_id: body.taskTypeId !== undefined,
        proposed_task_type_id: body.taskTypeId ?? null,
        change_owner_user_id: body.ownerUserId !== undefined,
        proposed_owner_user_id: body.ownerUserId ?? null,
        change_client_ref: body.clientRef !== undefined,
        proposed_client_ref: body.clientRef ?? null,
      })
      .select()
      .single();
    if (error) throw new ApiError(422, error.message, error.code ?? 'EDIT_REQUEST_REFUSED');
    return { data };
  });

  // Pending-first, per Chan's ask that an approver's queue reads oldest
  // work waiting on them first — same convention as /queue and /inbox.
  app.get('/', async (req) => {
    const q = req.query as { status?: string; taskId?: string };
    const db = userClient(req.accessToken);
    let query = db
      .schema('ops')
      .from('task_edit_requests')
      .select('*')
      .order('status', { ascending: true })
      .order('requested_at', { ascending: true });
    if (q.status) query = query.eq('status', q.status);
    if (q.taskId) query = query.eq('task_id', q.taskId);

    const { data, error } = await query;
    if (error) throw error;

    // Request rows themselves already came through userClient/RLS above
    // (any ops member reads all of ops.task_edit_requests); this only
    // resolves the requester's display name, the same enrichWithOwners
    // join every other list endpoint in this app pays for.
    const svc = serviceClient();
    const requesterIds = [...new Set((data ?? []).map((r) => r.requested_by as string))];
    const named = requesterIds.length
      ? await enrichWithOwners(svc, requesterIds.map((owner_user_id) => ({ owner_user_id })))
      : [];
    const nameByRequester = new Map(named.map((n) => [n.owner_user_id, n.ownerName]));

    return {
      data: (data ?? []).map((r) => ({ ...r, requestedByName: nameByRequester.get(r.requested_by) ?? null })),
    };
  });

  // A founder or admin only, and never a read-only one (20260910200000
  // — see the header; this was the clearing founder until 2026-09-10).
  // The DB trigger is the real gate; this 403 just avoids a round trip
  // for an obviously wrong caller (staff, or a GM trying to decide their
  // own request). Deliberately LOOSER than the real rule rather than a
  // second copy of it: `requireOversight()` admits GM, whom the database
  // then refuses. A tightened mirror here is the thing that drifts.
  app.post('/:id/approve', { onRequest: requireOversight() }, async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_edit_requests')
      .update({ status: 'approved' })
      .eq('id', id)
      .select()
      .single();
    if (error) {
      if (error.code === 'PGRST116') {
        throw new ApiError(404, 'edit request not found, or you do not have permission to decide it', 'NOT_FOUND');
      }
      throw new ApiError(422, error.message, error.code ?? 'APPROVE_REFUSED');
    }
    return { data };
  });

  app.post('/:id/reject', { onRequest: requireOversight() }, async (req) => {
    const { id } = req.params as { id: string };
    const body = rejectSchema.parse(req.body);
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_edit_requests')
      .update({ status: 'rejected', decision_reason: body.reason })
      .eq('id', id)
      .select()
      .single();
    if (error) {
      if (error.code === 'PGRST116') {
        throw new ApiError(404, 'edit request not found, or you do not have permission to decide it', 'NOT_FOUND');
      }
      throw new ApiError(422, error.message, error.code ?? 'REJECT_REFUSED');
    }
    return { data };
  });

  // Only the requester (checked by the DB trigger) — no requireOversight
  // here, since the requester withdrawing their own request is the
  // normal path, not a privileged one.
  app.post('/:id/withdraw', async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('task_edit_requests')
      .update({ status: 'withdrawn' })
      .eq('id', id)
      .select()
      .single();
    if (error) {
      if (error.code === 'PGRST116') {
        throw new ApiError(404, 'edit request not found, or you do not have permission to withdraw it', 'NOT_FOUND');
      }
      throw new ApiError(422, error.message, error.code ?? 'WITHDRAW_REFUSED');
    }
    return { data };
  });
}
