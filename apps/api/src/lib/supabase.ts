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
 * Every audit write that has failed since this process started, and the
 * last one's detail. `console.error` on a server nobody is tailing is
 * not "visible" — it is silently swallowed with extra steps, which is
 * what this comment used to claim it wasn't.
 *
 * The cost of believing otherwise was measured on 2026-09-10: a literal
 * string passed as `entity_id` (a uuid column) made every settings audit
 * row fail with 22P02, the PATCH returned 200 with a correct body, and
 * nobody learned that the audit trail for the parameters which rescore
 * the entire company had simply stopped recording. It was found by
 * someone counting rows, which is not a control.
 *
 * Surfaced on `GET /health` so a broken audit trail is discoverable
 * without reading logs. Deliberately a counter and not a throw: an
 * audit failure must never roll back the legitimate action it records.
 * "Does not throw" and "nobody finds out" are different choices and
 * this file previously made the second one by accident.
 */
export const auditFailures = {
  count: 0,
  last: null as { action: string; entityType: string; message: string; at: string } | null,
};

function recordAuditFailure(entry: AuditEntry, message: string): void {
  auditFailures.count += 1;
  auditFailures.last = {
    action: entry.action,
    entityType: entry.entityType,
    message,
    at: new Date().toISOString(),
  };
}

/**
 * Write an audit row. Never throws — an audit failure must not roll
 * back a legitimate business action — but a failure is counted in
 * `auditFailures` and reported by `GET /health`, not merely logged.
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
      recordAuditFailure(entry, error.message);
    }
  } catch (err) {
    console.error('[audit] write threw', { entry, err });
    recordAuditFailure(entry, err instanceof Error ? err.message : String(err));
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
    .select('id, email, authority, person_id, is_active, is_clearing_founder, read_only')
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
    // `core.is_clearing_founder()` verbatim: admin, or the one seated
    // clearing founder. Read from the same row as `authority` above, not
    // a second round trip, and not re-derived from a JWT claim.
    isClearingFounder: profile.authority === 'admin' || profile.is_clearing_founder === true,
    // `core.users.read_only` verbatim -- see `core.is_read_only()`.
    readOnly: profile.read_only === true,
  };
}
