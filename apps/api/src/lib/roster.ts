/**
 * LRA Global Ops :: the ops roster
 *
 * Extracted from `routes/me.ts`'s `GET /api/members` once a second
 * consumer (`routes/briefing.ts`) needed the exact same join — Chan's
 * standing rule is "extract only once a second real consumer needs it",
 * and the briefing screen's scorecard is that second consumer.
 *
 * Service client, deliberately: this assembles a company-wide roster
 * (core.users x core.memberships x core.people) that RLS on
 * `core.people` would otherwise scope to "self, or oversight" for a
 * plain staff caller — the same reasoning `me.ts` already documented.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface RosterMember {
  userId: string;
  email: string | null;
  authority: string | null;
  position: string;
  name: string | null;
  /**
   * `core.users.read_only` — a strictly read-only account (ERC, DCA).
   * Carried on the roster because a read-only member can never own,
   * submit or clear a task, so any screen that MEASURES output has to be
   * able to tell them apart from someone who simply scored zero.
   */
  readOnly: boolean;
}

export async function loadOpsRoster(db: SupabaseClient): Promise<RosterMember[]> {
  const { data: memberships, error } = await db
    .schema('core')
    .from('memberships')
    .select('module, position, is_active, user_id, users:user_id(id, email, authority, person_id, read_only)')
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

  return (memberships ?? []).map((m: Record<string, unknown>) => {
    const u = m.users as { id: string; email: string; authority: string; person_id: string | null; read_only: boolean | null } | null;
    const person = u?.person_id ? peopleById.get(u.person_id) : undefined;
    return {
      userId: u?.id ?? '',
      email: u?.email ?? null,
      authority: u?.authority ?? null,
      position: m.position as string,
      readOnly: u?.read_only ?? false,
      name: person ? (person.display_name as string) ?? `${person.first_name} ${person.last_name}` : (u?.email ?? null),
    };
  });
}
