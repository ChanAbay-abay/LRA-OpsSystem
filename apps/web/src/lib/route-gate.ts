/**
 * LRA Global Ops :: what a protected route should render, as a decision
 *
 * `ProtectedRoute` in App.tsx is a permission gate, and this project has
 * learned twice now that a permission rule with no test is a rule that
 * drifts (PLAN.md §11.1). But the gate was also the site of a different
 * defect class — `/queue` and `/digest` sat on the loading shell forever
 * with the API down, because the gate treated "the profile is in flight"
 * and "the profile is never arriving" as the same state.
 *
 * Neither kind of bug is visible in a component that reads a context and
 * returns JSX, because there is nothing to call. So the decision is
 * pulled out here as a pure function over plain values — the same move
 * `lib/request-headers.ts` made for the Content-Type rule and
 * `lib/task-permissions.ts` for the transition ladder — and App.tsx
 * renders whatever it is told.
 *
 * The four inputs are exactly the four the component had: is the session
 * still bootstrapping, is there a session at all, did the profile load,
 * and what does this route require.
 */

export type Authority = 'staff' | 'gm' | 'founder' | 'admin';

export interface RouteRequirement {
  requireAdmin?: boolean;
  requireOversight?: boolean;
  requireFounder?: boolean;
}

export interface GateState {
  /** The session itself is still bootstrapping. */
  loading: boolean;
  /** Whether a session exists at all. */
  hasSession: boolean;
  /** The caller's authority, or null when `/api/me` has not resolved. */
  authority: Authority | null;
  /** Why `/api/me` failed, or null. Distinct from "not yet arrived". */
  meError: string | null;
  /**
   * The HTTP status behind `meError`, or null when nothing answered.
   *
   * Without it every failure looked like an outage. A 403 is the server
   * answering clearly and permanently -- a deactivated account, a
   * revoked membership -- and telling that person "the app will keep
   * working as soon as the connection is back" is false twice over: the
   * connection is fine, and waiting will not fix it.
   */
  meErrorStatus?: number | null;
}

export type GateDecision =
  /** Render the shell skeleton — something is genuinely still in flight. */
  | { kind: 'skeleton' }
  /** Send them to sign in. */
  | { kind: 'login' }
  /** Signed in, but this route is not theirs. */
  | { kind: 'home' }
  /** The profile could not be loaded and this route cannot proceed without it. */
  | { kind: 'error'; message: string }
  /**
   * The server answered, and the answer is no. Not a retryable outage:
   * the account itself cannot use this app until somebody changes that.
   */
  | { kind: 'refused'; message: string }
  /** Render the route. */
  | { kind: 'render' };

const OVERSIGHT: Authority[] = ['gm', 'founder', 'admin'];
const FOUNDER: Authority[] = ['founder', 'admin'];

export function routeGate(state: GateState, req: RouteRequirement = {}): GateDecision {
  if (state.loading) return { kind: 'skeleton' };
  if (!state.hasSession) return { kind: 'login' };

  const gated = Boolean(req.requireAdmin || req.requireOversight || req.requireFounder);

  // An ungated route never needed the profile to decide anything, so a
  // failed `/api/me` must not take it over: its own `useResource` already
  // shows a Retry panel for whatever it fetches, and that panel is about
  // the thing the visitor came for. Only a route that cannot answer
  // "is this yours?" without the profile reports the profile's failure.
  if (!gated) return { kind: 'render' };

  // Order matters: "never arriving" is checked BEFORE "not yet arrived".
  // Reversed, a permanent failure looks like a slow load forever — the
  // exact defect, since `loading` goes false while `authority` stays null.
  if (state.meError) {
    // A 403 is a verdict on the account, not a failure to reach the
    // server, and the two get different panels. Everything else --
    // including a null status, which means nothing answered at all --
    // stays the outage case.
    if (state.meErrorStatus === 403) return { kind: 'refused', message: state.meError };
    return { kind: 'error', message: state.meError };
  }

  // Genuinely still in flight for a beat after the session settles. The
  // skeleton is the honest answer, not a redirect on a role not yet read.
  if (state.authority === null) return { kind: 'skeleton' };

  if (req.requireAdmin && state.authority !== 'admin') return { kind: 'home' };
  if (req.requireOversight && !OVERSIGHT.includes(state.authority)) return { kind: 'home' };
  if (req.requireFounder && !FOUNDER.includes(state.authority)) return { kind: 'home' };

  return { kind: 'render' };
}
