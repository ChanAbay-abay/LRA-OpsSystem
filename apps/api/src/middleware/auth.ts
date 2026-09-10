/**
 * LRA Global Ops :: Authentication and Authority Guards
 *
 * Guards here are a first line of defence, not the only one. RLS in the
 * database is the real enforcement — PostgREST is reachable with the
 * anon key without going anywhere near this API, so a ladder that
 * exists only here is decoration. If a guard is ever missed or bypassed,
 * the underlying query still returns or changes nothing the caller
 * should not see.
 *
 * Authority and module membership are read from `core.users` /
 * `core.memberships` via the service client, NEVER from the JWT
 * payload. A JWT's custom claims are set at issue time and a client
 * fully controls what it sends back; trusting them for authorization
 * is how a `role` claim becomes a self-promotion button.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { createClient } from '@supabase/supabase-js';
import { ApiError, type AuthUser, type Authority, type Module } from '../lib/domain.js';
import { loadAuthUser } from '../lib/supabase.js';
import { env } from '../lib/env.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
    accessToken: string;
  }
}

/**
 * Verify the bearer token and load the caller's authority + memberships.
 */
export async function authenticate(
  req: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError(401, 'Missing bearer token', 'NO_TOKEN');
  }

  const token = header.slice(7);
  const auth = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: authData, error: authError } = await auth.auth.getUser(token);
  if (authError || !authData?.user) {
    throw new ApiError(401, 'Invalid or expired token', 'BAD_TOKEN');
  }

  // Service client, deliberately: a brand-new user has no core.users row
  // yet to grant them SELECT on their own row via RLS, and self-lookup
  // during login must not depend on the very authorization it resolves.
  const profile = await loadAuthUser(authData.user.id);
  if (!profile) {
    throw new ApiError(403, 'No user profile found', 'NO_PROFILE');
  }
  if (!profile.isActive) {
    throw new ApiError(403, 'Account is deactivated', 'INACTIVE');
  }

  req.user = profile;
  req.accessToken = token;
}

/** Restrict a route to specific company authorities. */
export function requireAuthority(...authorities: Authority[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!authorities.includes(req.user.authority)) {
      throw new ApiError(
        403,
        `This action requires one of: ${authorities.join(', ')}`,
        'FORBIDDEN'
      );
    }
  };
}

/** Restrict a route to gm/founder/admin — the oversight tiers. */
export function requireOversight() {
  return requireAuthority('gm', 'founder', 'admin');
}

/** Restrict a route to active members of a given module. */
export function requireMembership(module: Module) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const isMember =
      req.user.authority === 'admin' ||
      req.user.memberships.some((m) => m.module === module && m.isActive);
    if (!isMember) {
      throw new ApiError(403, `This action requires ${module} module membership`, 'NOT_A_MEMBER');
    }
  };
}

/**
 * Refuse a write from a read-only account, in a router whose writes run on
 * `serviceClient`.
 *
 * WHY THIS EXISTS AT ALL. Every write policy in
 * 20260910120100_core_read_only_accounts.sql carries `not core.is_read_only()`,
 * and that clause covers every write path in the API that runs on
 * `userClient`. It cannot cover a service-role connection: `core.is_read_only()`
 * reads `core.auth_user_id()`, which is null as the service role, so the
 * function returns false for everyone. A router that writes as the service role
 * therefore has no read-only guard at all unless it makes the check itself.
 *
 * Two routers do: `routes/admin.ts` (the whole provisioning surface — invite,
 * patch, delete, restore, purge) and `routes/jobs.ts` (drain-outbox and
 * flag-stale, which write notifications and task flags). Both are
 * `requireAuthority('admin')`-gated, and an account can hold `authority =
 * 'admin'` AND `read_only` at the same time — `/admin/users` can create one in
 * two clicks. Such an account would keep both surfaces in full while every
 * screen told it, correctly, that it could change nothing.
 *
 * Extracted here once `jobs.ts` became the second real consumer, per the
 * standing rule against speculative abstraction. **Any new router that writes on
 * `serviceClient` must add this hook** — that is the invariant to preserve, and
 * the reason it lives next to the other authority hooks rather than inline in
 * one route file.
 *
 * Reads are deliberately untouched: read-only means "sees what oversight sees
 * and writes nothing", so only the mutating verbs are refused.
 */
export async function refuseReadOnlyWrites(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  if (req.user.readOnly) {
    throw new ApiError(
      403,
      'This account is read-only. It can see everything here and change nothing.',
      'READ_ONLY_ACCOUNT'
    );
  }
}
