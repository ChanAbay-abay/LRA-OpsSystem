/**
 * LRA Global Ops :: Supabase Clients and Audit Trail
 *
 * Two clients, on purpose:
 *
 *   userClient    forwards the caller's JWT, so RLS applies. This is the
 *                 default for anything touching `core` or `ops` data.
 *   serviceClient bypasses RLS. Reserved for genuinely system-level work:
 *                 outbox drain, week rollover, recurring generation,
 *                 audit writes, provisioning, and the auth middleware's
 *                 own profile lookup (a caller cannot be trusted to read
 *                 their own authority row under the very RLS policy that
 *                 depends on knowing it first).
 *
 * Reaching for serviceClient to avoid an RLS error is how a permission
 * model quietly dies. Fix the policy instead.
 *
 * Data lives in `core` and `ops`, not `public`, so every call chains
 * `.schema('core')` or `.schema('ops')` before `.from(table)` — there is
 * no default-schema client here, unlike LRA-HR's single-schema setup.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthUser, Authority, Module } from './domain.js';
import { env } from './env.js';

export function userClient(accessToken: string): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function serviceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------
// Audit trail — always via serviceClient. core.audit_logs is
// append-only even to the service role (a BEFORE trigger enforces that
// at the database level), so this can never rewrite history, only add
// to it.
// ---------------------------------------------------------------------

export interface AuditEntry {
  module?: Module;
  action: string;
  entityType: string;
  entityId?: string;
  oldValues?: unknown;
  newValues?: unknown;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Write an audit row. Never throws — an audit failure must not roll
 * back a legitimate business action, but it is logged loudly so the gap
 * is visible rather than silently swallowed.
 */
export async function writeAudit(
  actor: { id: string; email: string; authority: Authority },
  entry: AuditEntry
): Promise<void> {
  try {
    const db = serviceClient();
    const { error } = await db.schema('core').from('audit_logs').insert({
      actor_id: actor.id,
      actor_email: actor.email,
      actor_authority: actor.authority,
      module: entry.module ?? null,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      old_values: entry.oldValues ?? null,
      new_values: entry.newValues ?? null,
      ip_address: entry.ipAddress ?? null,
      user_agent: entry.userAgent ?? null,
    });
    if (error) {
      console.error('[audit] write failed', { entry, error });
    }
  } catch (err) {
    console.error('[audit] write threw', { entry, err });
  }
}

// ---------------------------------------------------------------------
// Notification outbox — always via serviceClient. There is no INSERT
// policy for `authenticated` on either table; this is the only path in.
// ---------------------------------------------------------------------

export interface OutboxInput {
  recipientId: string;
  module: Module;
  eventType: string;
  entityType: string;
  entityId?: string;
  title: string;
  body: string;
  link?: string;
  payload?: Record<string, unknown>;
}

export async function enqueueNotification(input: OutboxInput): Promise<void> {
  try {
    const db = serviceClient();
    const { error } = await db.schema('core').from('notification_outbox').insert({
      recipient_id: input.recipientId,
      module: input.module,
      event_type: input.eventType,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
      payload: input.payload ?? {},
    });
    if (error) {
      console.error('[outbox] enqueue failed', { input, error });
    }
  } catch (err) {
    console.error('[outbox] enqueue threw', { input, err });
  }
}

/** Load the full profile (authority + active memberships) for one user. */
export async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const db = serviceClient();
  const { data: profile, error } = await db
    .schema('core')
    .from('users')
    .select('id, email, authority, person_id, is_active')
    .eq('id', userId)
    .single();

  if (error || !profile) return null;

  const { data: memberships } = await db
    .schema('core')
    .from('memberships')
    .select('module, position, is_active')
    .eq('user_id', userId)
    .eq('is_active', true);

  return {
    id: profile.id,
    email: profile.email,
    authority: profile.authority as Authority,
    personId: profile.person_id,
    isActive: profile.is_active,
    memberships: (memberships ?? []).map((m) => ({
      module: m.module,
      position: m.position,
      isActive: m.is_active,
    })),
  };
}
