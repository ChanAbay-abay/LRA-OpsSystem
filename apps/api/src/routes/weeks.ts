/**
 * LRA Global Ops :: /api/weeks
 *
 * Week creation, recurring generation, and close/rollover — Phase 5
 * only. The commitment lock, briefing open/close, and the briefing
 * screen itself are Phase 6 and deliberately not here: that phase is
 * blocked on the founder pricing the catalog (OPEN-QUESTIONS.md #3), and
 * building the lock without the screen that populates it for real would
 * be scope creep into a gated phase.
 *
 * Generation/close call the SQL functions via `userClient.rpc(...)`, so
 * an oversight caller's own JWT drives the function's internal
 * `is_system_caller() or is_oversight()` guard — the same "the database
 * is the real enforcement" rule as the task transition endpoint.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/domain.js';
import { authenticate, requireMembership, requireOversight } from '../middleware/auth.js';
import { userClient } from '../lib/supabase.js';
import { manilaWeekStart } from '@lra/ops-scoring';

const createSchema = z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export default async function weeksRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  app.get('/current', async (req) => {
    const db = userClient(req.accessToken);
    const weekStart = manilaWeekStart();
    const { data, error } = await db.schema('ops').from('weeks').select('*').eq('week_start', weekStart).maybeSingle();
    if (error) throw error;
    return { data };
  });

  // One week by id, for `/briefing?weekId=…`.
  //
  // Registered AFTER the literal `/current` above, deliberately: Fastify
  // matches a static segment before a parametric one regardless of
  // registration order, but relying on that silently is how `/board` and
  // `/:id` collided in the tasks router (apps/api/test/tasks-route.test.ts
  // pins that one against the real router rather than by inspection). The
  // same test exists for this pair, for the same reason.
  //
  // A non-uuid id is a 404 rather than a 500: PostgREST answers `22P02`
  // for a malformed uuid and `lib/pg-errors.ts` deliberately leaves that
  // code unmapped, so it would otherwise surface as an opaque server
  // error for what is really "no such week".
  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new ApiError(404, 'no such week', 'NOT_FOUND');
    }
    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').from('weeks').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    // `maybeSingle` gives null for a week RLS hides as well as one that
    // does not exist. From the caller's side those are the same answer,
    // and saying which would leak the existence of a row they may not see.
    if (!data) throw new ApiError(404, 'no such week', 'NOT_FOUND');
    return { data };
  });

  app.get('/', async (req) => {
    const q = req.query as { limit?: string };
    const limit = q.limit ? Number(q.limit) : 8;
    const db = userClient(req.accessToken);
    const { data, error } = await db
      .schema('ops')
      .from('weeks')
      .select('*')
      .order('week_start', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return { data };
  });

  // Idempotent on week_start: the unique constraint on ops.weeks does
  // the real work, this just turns the resulting 23505 into a friendly
  // "here's the existing row" instead of a 500.
  app.post('/', { onRequest: requireOversight() }, async (req) => {
    const body = createSchema.parse(req.body ?? {});
    const weekStart = body.weekStart ?? manilaWeekStart();
    const db = userClient(req.accessToken);

    const { data: existing } = await db.schema('ops').from('weeks').select('*').eq('week_start', weekStart).maybeSingle();
    if (existing) return { data: existing };

    const { data, error } = await db.schema('ops').from('weeks').insert({ week_start: weekStart }).select().single();
    if (error) throw error;
    return { data };
  });

  app.post('/:id/generate-recurring', { onRequest: requireOversight() }, async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').rpc('generate_recurring_tasks', { p_week_id: id });
    if (error) throw new ApiError(422, error.message, error.code ?? 'GENERATE_REFUSED');
    return { data };
  });

  // Phase 6 — the Monday briefing. `open` only stamps a screen-state
  // timestamp; `close` is the lock moment (`ops.close_briefing` moves
  // the week planning -> open and audit-logs it), matching PRD.md §3.1
  // exactly: the week is `open` once commitments are locked, not once
  // the meeting starts.
  app.post('/:id/briefing/open', { onRequest: requireOversight() }, async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').rpc('open_briefing', { p_week_id: id });
    if (error) throw new ApiError(422, error.message, error.code ?? 'BRIEFING_OPEN_REFUSED');
    return { data };
  });

  app.post('/:id/briefing/close', { onRequest: requireOversight() }, async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').rpc('close_briefing', { p_week_id: id });
    if (error) throw new ApiError(422, error.message, error.code ?? 'BRIEFING_CLOSE_REFUSED');
    return { data };
  });

  app.post('/:id/close', { onRequest: requireOversight() }, async (req) => {
    const { id } = req.params as { id: string };
    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').rpc('close_week', { p_week_id: id });
    if (error) throw new ApiError(422, error.message, error.code ?? 'CLOSE_REFUSED');
    return { data };
  });
}
