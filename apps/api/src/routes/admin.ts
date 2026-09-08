/**
 * LRA Global Ops :: Provisioning — /api/admin/users
 *
 * Admin (Chan) only, not the founder and not the GM. Provisioning is a
 * system act, not a business one — `requireAuthority('admin')` is
 * deliberately narrower than `requireOversight()`.
 *
 * No credential ever passes through this system, an agent, or a chat
 * log: the primary path is `inviteUserByEmail`, which lets Supabase
 * Auth send the invite directly. An admin-set password is documented
 * in `scripts/provision.md` as the fallback for a monitored inbox that
 * never arrives, and is not built here unless invites are known to fail.
 *
 * Idempotent on email — this endpoint will be re-run. Re-running finds
 * the existing auth user (if any) and repairs whatever rows are
 * missing, rather than erroring or duplicating.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/domain.js';
import { authenticate, requireAuthority } from '../middleware/auth.js';
import { serviceClient, writeAudit } from '../lib/supabase.js';

const AUTHORITIES = ['staff', 'gm', 'founder', 'admin'] as const;
const POSITIONS = [
  'founder',
  'gm',
  'sales',
  'broker',
  'hr_officer',
  'accounting',
  'other',
] as const;

const inviteSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  authority: z.enum(AUTHORITIES).default('staff'),
  position: z.enum(POSITIONS).default('other'),
});

const patchSchema = z.object({
  isActive: z.boolean().optional(),
  authority: z.enum(AUTHORITIES).optional(),
  position: z.enum(POSITIONS).optional(),
});

/** Next sequential LRA-### person code. Sequential, not client-supplied. */
async function nextPersonCode(db: ReturnType<typeof serviceClient>): Promise<string> {
  const { data, error } = await db
    .schema('core')
    .from('people')
    .select('person_code')
    .like('person_code', 'LRA-%')
    .order('person_code', { ascending: false })
    .limit(1);
  if (error) throw error;

  const last = data?.[0]?.person_code as string | undefined;
  const n = last ? Number(last.split('-')[1]) : 0;
  return `LRA-${String(n + 1).padStart(3, '0')}`;
}

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireAuthority('admin'));

  app.post('/', async (req) => {
    const body = inviteSchema.parse(req.body);
    const db = serviceClient();

    // 1. Find or invite the auth user. inviteUserByEmail is idempotent
    //    in effect here: if the address is already invited/registered,
    //    Supabase returns an error we detect and fall back to lookup.
    let authUserId: string;
    const { data: invited, error: inviteError } = await db.auth.admin.inviteUserByEmail(
      body.email
    );

    if (invited?.user) {
      authUserId = invited.user.id;
    } else {
      // Already exists — find it. Every other error is thrown, never
      // discarded: an admin invite failing silently is exactly the kind
      // of gap that makes provisioning untrustworthy.
      const { data: list, error: listError } = await db.auth.admin.listUsers();
      if (listError) throw listError;
      const existing = list.users.find((u) => u.email === body.email);
      if (!existing) {
        throw new ApiError(
          502,
          `Invite failed and no existing account was found for ${body.email}: ${inviteError?.message}`,
          'INVITE_FAILED'
        );
      }
      authUserId = existing.id;
    }

    // 2. core.people — find by email, or create with the next sequential code.
    const { data: existingPerson } = await db
      .schema('core')
      .from('people')
      .select('id')
      .eq('email', body.email)
      .maybeSingle();

    let personId = existingPerson?.id as string | undefined;
    if (!personId) {
      const personCode = await nextPersonCode(db);
      const { data: person, error: personError } = await db
        .schema('core')
        .from('people')
        .insert({
          person_code: personCode,
          first_name: body.firstName,
          last_name: body.lastName,
          display_name: `${body.firstName} ${body.lastName}`,
          email: body.email,
        })
        .select('id')
        .single();
      if (personError) throw personError;
      personId = person.id;
    }

    // 3. core.users — find or create, linked to the auth user and the person.
    const { data: existingUser } = await db
      .schema('core')
      .from('users')
      .select('id')
      .eq('id', authUserId)
      .maybeSingle();

    if (!existingUser) {
      const { error: userError } = await db.schema('core').from('users').insert({
        id: authUserId,
        email: body.email,
        authority: body.authority,
        person_id: personId,
      });
      if (userError) throw userError;
    }

    // 4. core.memberships — find or create the ops membership.
    const { data: existingMembership } = await db
      .schema('core')
      .from('memberships')
      .select('id')
      .eq('user_id', authUserId)
      .eq('module', 'ops')
      .maybeSingle();

    if (!existingMembership) {
      const { error: membershipError } = await db.schema('core').from('memberships').insert({
        user_id: authUserId,
        module: 'ops',
        position: body.position,
      });
      if (membershipError) throw membershipError;
    }

    // Creating a founder is the highest-privilege action in the
    // platform and must never be silent.
    await writeAudit(req.user, {
      module: 'ops',
      action: existingUser ? 'admin.users.repair' : 'admin.users.invite',
      entityType: 'core.users',
      entityId: authUserId,
      newValues: { email: body.email, authority: body.authority, position: body.position },
    });

    return {
      data: {
        userId: authUserId,
        personId,
        email: body.email,
        authority: body.authority,
        position: body.position,
        invited: Boolean(invited?.user),
      },
    };
  });

  app.get('/', async () => {
    const db = serviceClient();
    const { data: users, error } = await db
      .schema('core')
      .from('users')
      .select('id, email, authority, is_active, last_login, person_id');
    if (error) throw error;

    const { data: memberships } = await db
      .schema('core')
      .from('memberships')
      .select('user_id, module, position, is_active')
      .eq('module', 'ops');

    const membershipByUser = new Map((memberships ?? []).map((m) => [m.user_id, m]));

    return {
      data: (users ?? []).map((u) => ({
        ...u,
        opsMembership: membershipByUser.get(u.id) ?? null,
      })),
    };
  });

  app.patch('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.parse(req.body);
    const db = serviceClient();

    const patch: Record<string, unknown> = {};
    if (body.isActive !== undefined) patch.is_active = body.isActive;
    if (body.authority !== undefined) patch.authority = body.authority;

    if (Object.keys(patch).length) {
      const { error } = await db.schema('core').from('users').update(patch).eq('id', id);
      if (error) throw error;
    }

    if (body.position !== undefined) {
      const { error } = await db
        .schema('core')
        .from('memberships')
        .update({ position: body.position })
        .eq('user_id', id)
        .eq('module', 'ops');
      if (error) throw error;
    }

    await writeAudit(req.user, {
      module: 'ops',
      action: 'admin.users.patch',
      entityType: 'core.users',
      entityId: id,
      newValues: body,
    });

    return { data: { id, ...body } };
  });
}
