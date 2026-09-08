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
