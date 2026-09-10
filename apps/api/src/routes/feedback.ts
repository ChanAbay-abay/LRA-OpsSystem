/**
 * LRA Global Ops :: /api/feedback — the suggestion/bug channel
 *
 * `core.feedback` (20260911130000_core_feedback_channel.sql) is the real
 * guard; everything here is convenience, same as every other router in
 * this API. Two very different halves under one prefix:
 *
 *   POST /           any active ops member, INCLUDING a read-only
 *                     founder (ERC/DCA) — deliberately NOT gated by
 *                     `refuseReadOnlyWrites`. See the migration's point
 *                     3: reporting a bug is not a change to the
 *                     operational record, so the read-only guard does
 *                     not apply to this one write.
 *   GET /, PATCH /:id/archive, PATCH /:id/reopen, DELETE /:id
 *                     admin only — Chan's own inbox.
 *
 * Both halves run on `userClient`, never `serviceClient`: RLS is the
 * actual decision-maker (admin-only read, admin-only status/delete,
 * open-to-read-only insert), and there is no reason to bypass it here.
 *
 * `POST /` deliberately never chains `.select()` after `.insert()`.
 * Postgres RLS subjects a RETURNING clause to the table's SELECT
 * policy, same as a plain SELECT — and `core.feedback`'s SELECT policy
 * is admin-only, so a non-admin submitter asking for the row back would
 * have the entire INSERT refused, not just the read half. Confirmed
 * live against the local stack while proving the RLS suite (see
 * supabase/tests/rls_test.sql's `feedback` section) — this is not a
 * defensive guess.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAuthority, requireMembership } from '../middleware/auth.js';
import { userClient } from '../lib/supabase.js';

const submitSchema = z.object({
  kind: z.enum(['suggestion', 'bug']),
  // Matches `feedback_body_length` (core.feedback) — enforced here too
  // so a short/oversized body reads as a normal 400, not a raw
  // check-constraint message surfaced through pg-errors.ts.
  body: z.string().trim().min(10, 'Say a bit more — at least 10 characters.').max(4000),
  // Captured automatically by the web client from its own route
  // (`location.pathname`), never typed by the reporter.
  page: z.string().max(300).default(''),
});

export default async function feedbackRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  // No `refuseReadOnlyWrites` here — see the file header and
  // 20260911130000_core_feedback_channel.sql point 3. A read-only
  // founder is exactly as able to submit as anyone else; the database
  // enforces that directly.
  app.post('/', async (req, reply) => {
    const body = submitSchema.parse(req.body);
    const db = userClient(req.accessToken);

    // No `.select()` — see the file header for why requesting the row
    // back would refuse the whole write for a non-admin submitter.
    // `submitted_by`/`submitted_by_email`/`submitted_by_authority` are
    // not sent at all: `core.stamp_feedback_submitter()` derives them
    // server-side from the caller's own token, so nothing here could
    // forge them even by accident.
    const { error } = await db.schema('core').from('feedback').insert({
      kind: body.kind,
      body: body.body,
      page: body.page,
    });
    if (error) throw error;

    reply.code(201);
    return { data: { submitted: true } };
  });

  app.register(async (adminApp) => {
    adminApp.addHook('onRequest', requireAuthority('admin'));

    adminApp.get('/', async (req) => {
      const q = req.query as { status?: string };
      const db = userClient(req.accessToken);
      let query = db.schema('core').from('feedback').select('*').order('created_at', { ascending: false });
      if (q.status === 'open' || q.status === 'archived') query = query.eq('status', q.status);
      const { data, error } = await query;
      if (error) throw error;
      return { data };
    });

    // A single PATCH covering both directions (archive/reopen) rather
    // than two endpoints — `status` is the only field a client ever
    // sends, and the database's own immutability trigger
    // (`core.guard_feedback_immutable_content`) refuses anything else
    // regardless of what this route does.
    adminApp.patch('/:id', async (req) => {
      const { id } = req.params as { id: string };
      const statusSchema = z.object({ status: z.enum(['open', 'archived']) });
      const patchBody = statusSchema.parse(req.body);
      const db = userClient(req.accessToken);

      const patch =
        patchBody.status === 'archived'
          ? { status: 'archived', archived_at: new Date().toISOString(), archived_by: req.user.id }
          : { status: 'open', archived_at: null, archived_by: null };

      const { data, error } = await db.schema('core').from('feedback').update(patch).eq('id', id).select().single();
      if (error) throw error;
      return { data };
    });

    adminApp.delete('/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const db = userClient(req.accessToken);
      const { error } = await db.schema('core').from('feedback').delete().eq('id', id);
      if (error) throw error;
      return reply.code(204).send();
    });
  });
}
