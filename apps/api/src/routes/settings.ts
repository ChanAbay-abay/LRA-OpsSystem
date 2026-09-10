/**
 * LRA Global Ops :: /api/settings
 *
 * The single `ops.settings` row. Read by any ops member; written by
 * founder or admin — PRD.md names the founder as the owner, and Chan's
 * ask tonight is an admin console that can drive this screen too, so
 * `admin` is added alongside `founder` here rather than by weakening the
 * RLS policy (`ops.settings`'s UPDATE policy already checks
 * `core.is_founder()`, which is `authority in ('founder','admin')` —
 * admin was already covered; this route's guard just has to agree).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAuthority, requireMembership } from '../middleware/auth.js';
import { userClient, writeAudit } from '../lib/supabase.js';

const patchSchema = z.object({
  recurringCapPct: z.number().min(0).max(0.999).optional(),
  recurringFloorPoints: z.number().int().min(0).optional(),
  staleAfterDays: z.number().int().min(1).optional(),
  reliabilityWindowWeeks: z.number().int().min(1).optional(),
  reliabilityHalfLifeWeeks: z.number().min(0.1).optional(),
  minWeeksForRating: z.number().int().min(0).optional(),
  leaderboardVisibility: z.enum(['all', 'oversight_only']).optional(),
  timezone: z.string().optional(),
});

export default async function settingsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireMembership('ops'));

  app.get('/', async (req) => {
    const db = userClient(req.accessToken);
    const { data, error } = await db.schema('ops').from('settings').select('*').single();
    if (error) throw error;
    return { data };
  });

  app.patch('/', { onRequest: requireAuthority('founder', 'admin') }, async (req) => {
    const body = patchSchema.parse(req.body);
    const db = userClient(req.accessToken);

    const patch: Record<string, unknown> = { updated_by: req.user.id };
    if (body.recurringCapPct !== undefined) patch.recurring_cap_pct = body.recurringCapPct;
    if (body.recurringFloorPoints !== undefined) patch.recurring_floor_points = body.recurringFloorPoints;
    if (body.staleAfterDays !== undefined) patch.stale_after_days = body.staleAfterDays;
    if (body.reliabilityWindowWeeks !== undefined) patch.reliability_window_weeks = body.reliabilityWindowWeeks;
    if (body.reliabilityHalfLifeWeeks !== undefined) patch.reliability_half_life_weeks = body.reliabilityHalfLifeWeeks;
    if (body.minWeeksForRating !== undefined) patch.min_weeks_for_rating = body.minWeeksForRating;
    if (body.leaderboardVisibility !== undefined) patch.leaderboard_visibility = body.leaderboardVisibility;
    if (body.timezone !== undefined) patch.timezone = body.timezone;

    // These parameters drive the recurring cap and the reliability
    // formula that scores every person in the company, retroactively
    // across the scoreboard's 13-week windows — read the row on the
    // same userClient (not serviceClient, which would bypass RLS) so
    // the audit row carries a real before/after diff of only the
    // fields that actually changed, matching the shape the direct-edit
    // audit trigger already uses for tasks (20260910170000).
    const { data: before, error: beforeError } = await db.schema('ops').from('settings').select('*').eq('id', true).single();
    if (beforeError) throw beforeError;

    const { data, error } = await db.schema('ops').from('settings').update(patch).eq('id', true).select().single();
    if (error) throw error;

    const changedKeys = Object.keys(patch).filter((key) => key !== 'updated_by' && before[key] !== data[key]);
    if (changedKeys.length) {
      await writeAudit(req.user, {
        module: 'ops',
        action: 'admin.settings.patch',
        entityType: 'ops.settings',
        // No entityId: `core.audit_logs.entity_id` is a uuid, and
        // `ops.settings` is a singleton keyed `id = true` — a boolean —
        // so there is no uuid to point at and `entity_type` already
        // identifies the row uniquely. This passed the literal string
        // 'settings' until 2026-09-10, which Postgres rejected as
        // 22P02 invalid input syntax for type uuid. `writeAudit` catches
        // its own errors, so the PATCH still returned 200 with the right
        // body and the audit row simply never existed.
        oldValues: Object.fromEntries(changedKeys.map((key) => [key, before[key]])),
        newValues: Object.fromEntries(changedKeys.map((key) => [key, data[key]])),
      });
    }

    return { data };
  });
}
