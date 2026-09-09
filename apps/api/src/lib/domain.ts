/**
 * LRA Global Ops :: Domain Types
 *
 * Mirrors the `core` schema's enums exactly. Authority and module/
 * position are deliberately separate types here too — see PLAN.md §0.4.
 * `core.authority` is company rank and rarely changes; `core.module` /
 * `core.position` is additive module participation. Conflating them in
 * application code is exactly how HR's "a manager can forge hr_id" class
 * of defect happened, so the API never re-derives one from the other.
 */

export type Authority = 'staff' | 'gm' | 'founder' | 'admin';
export type Module = 'ops' | 'hr' | 'crm';
export type Position =
  | 'founder'
  | 'gm'
  | 'sales'
  | 'broker'
  | 'hr_officer'
  | 'accounting'
  | 'other';

export interface Membership {
  module: Module;
  position: Position;
  isActive: boolean;
}

/**
 * The authenticated caller. Authority and memberships are always read
 * from `core.users` / `core.memberships` in the auth middleware — never
 * from the JWT payload, which a client controls.
 */
export interface AuthUser {
  id: string;
  email: string;
  authority: Authority;
  personId: string | null;
  isActive: boolean;
  memberships: Membership[];
  // Mirrors `core.is_clearing_founder()` exactly (is_admin() OR the
  // is_clearing_founder column) -- the single seat that may clear a
  // task's points or decide a flagged cancellation. Computed here, once,
  // server-side, so the web app never has to re-derive "can this person
  // clear" from `authority` alone: an authority='founder' account that
  // is not the seated clearing founder must see the same disabled
  // control a GM does, and a UI that infers the capability from
  // authority would light that control up incorrectly (the exact defect
  // this field exists to close).
  isClearingFounder: boolean;
  // Mirrors `core.users.read_only` / `core.is_read_only()`
  // (supabase/migrations/20260910120100_core_read_only_accounts.sql):
  // a strictly read-only founder account (ERC, DCA) that sees exactly
  // what oversight sees and may write nothing at all. The database is
  // still the real gate -- every write policy checks
  // `core.is_read_only()` first -- this field only lets the web app
  // hide/disable the write affordances before the request is even made.
  readOnly: boolean;
}

export function isOversight(authority: Authority): boolean {
  return authority === 'gm' || authority === 'founder' || authority === 'admin';
}

export function isFounder(authority: Authority): boolean {
  return authority === 'founder' || authority === 'admin';
}

export function isAdmin(authority: Authority): boolean {
  return authority === 'admin';
}

export function hasMembership(user: AuthUser, module: Module): boolean {
  return (
    user.authority === 'admin' ||
    user.memberships.some((m) => m.module === module && m.isActive)
  );
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
