/**
 * LRA Global Ops :: /api/me and /api/members
 *
 * The Phase 1 API surface: enough for a logged-in user to see who they
 * are and who else is on the team. Everything else in PLAN.md §3 arrives
 * with the phase that actually needs it.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { serviceClient } from '../lib/supabase.js';
import { loadOpsRoster } from '../lib/roster.js';

export default async function meRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);

  app.get('/', async (req) => {
    return {
      data: {
        id: req.user.id,
        email: req.user.email,
        authority: req.user.authority,
        personId: req.user.personId,
        memberships: req.user.memberships,
        // The real capability, computed server-side (domain.ts / lib/
        // supabase.ts) from the same rule as `core.is_clearing_founder()`.
        // The queue and board gate their clear/approve controls on this,
        // not on `authority === 'founder'` -- a founder who is not the
        // seated clearing founder must see a disabled control, same as a
        // GM would.
        isClearingFounder: req.user.isClearingFounder,
        // See domain.ts's `AuthUser.readOnly` -- the client-side mirror
        // in task-permissions.ts gates every write affordance on this.
        readOnly: req.user.readOnly,
      },
    };
  });
}

export async function membersRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);

  // Service client: the team roster is a join across core.users,
  // core.people and core.memberships that every ops member is allowed
  // to see in aggregate, but RLS on core.people scopes SELECT to
  // "self, or oversight" — a plain staff member's userClient would only
  // get their own person row back. This route is the one legitimate
  // system-level read that assembles the roster on their behalf; it
  // still only returns active ops members, mirroring what RLS would
  // allow an oversight caller to see directly.
  app.get('/', async () => {
    const members = await loadOpsRoster(serviceClient());
    return { data: members };
  });
}
