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
    const db = serviceClient();
    const { data: memberships, error } = await db
      .schema('core')
      .from('memberships')
      .select('module, position, is_active, user_id, users:user_id(id, email, authority, person_id)')
      .eq('module', 'ops')
      .eq('is_active', true);

    if (error) throw error;

    const userIds = (memberships ?? [])
      .map((m: Record<string, unknown>) => (m.users as { person_id: string | null } | null)?.person_id)
      .filter((id): id is string => Boolean(id));

    const { data: people } = userIds.length
      ? await db.schema('core').from('people').select('id, first_name, last_name, display_name, is_active').in('id', userIds)
      : { data: [] as Array<Record<string, unknown>> };

    const peopleById = new Map((people ?? []).map((p) => [p.id as string, p]));

    const members = (memberships ?? []).map((m: Record<string, unknown>) => {
      const u = m.users as { id: string; email: string; authority: string; person_id: string | null } | null;
      const person = u?.person_id ? peopleById.get(u.person_id) : undefined;
      return {
        userId: u?.id,
        email: u?.email,
        authority: u?.authority,
        position: m.position,
        name: person
          ? (person.display_name as string) ?? `${person.first_name} ${person.last_name}`
          : u?.email,
      };
    });

    return { data: members };
  });
}
