/**
 * LRA Global Ops :: /api/jobs
 *
 * Cron-triggered system jobs. Guarded by admin authority for now (no
 * separate cron secret exists yet in this environment) — PLAN.md Phase
 * 9 wires a real cron target; until then an admin-authenticated call
 * (or a script running as Chan) is the trigger.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireAuthority } from '../middleware/auth.js';
import { drainOutbox } from '../services/outbox.js';
import { flagStaleTasks } from '../services/stale.js';

export default async function jobsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireAuthority('admin'));

  app.post('/drain-outbox', async () => {
    const result = await drainOutbox();
    return { data: result };
  });

  // Daily (PLAN.md Phase 7). Idempotent per task per day — see
  // services/stale.ts's header for how that holds without a new column.
  app.post('/flag-stale', async () => {
    const result = await flagStaleTasks();
    return { data: result };
  });
}
