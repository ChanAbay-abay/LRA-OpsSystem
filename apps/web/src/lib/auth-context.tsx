/**
 * LRA Global Ops :: auth context
 *
 * Holds the Supabase session and the API's own `/api/me` profile
 * (authority + memberships), which is the only source either the
 * sidebar or a route guard trusts — never the JWT's own claims, per
 * PLAN.md's standing rule that authority is read from `core.users`.
 *
 * Reproduced defect this file fixes: `signIn()` used to call `loadMe()`
 * directly *and* the `onAuthStateChange` listener fired its own
 * `loadMe()` for the same sign-in, so a fresh sign-in produced two
 * near-simultaneous `GET /api/me` calls with the identical token. The
 * second one came back 401, and the old 401 handler treated that as
 * "this session is invalid" and force-signed-out the user — silently,
 * with no on-screen explanation, straight back to /login. Two
 * independent fixes, both required:
 *
 * 1. `loadMe` is wrapped in `singleFlight` so overlapping callers (the
 *    explicit call from `signIn`, the listener's own call, and anything
 *    StrictMode's double-invoked dev effects add on top) share exactly
 *    one in-flight request instead of each firing a new one. `signIn`
 *    no longer calls `loadMe` itself either, since `onAuthStateChange`
 *    already fires for the sign-in — belt and suspenders, not either/or.
 * 2. A 401 no longer force-signs-out on the first failure. It's retried
 *    once (a single failed request is not proof the session is dead —
 *    the whole bug above was exactly that: a spurious 401 next to a
 *    perfectly valid token). Only a second consecutive 401 is treated
 *    as a genuinely rejected session, and even then the sign-out is
 *    local-scope (this device only, not every session everywhere) and
 *    surfaced with a visible toast — never a silent bounce.
 */
import * as React from 'react';
import type { Session } from '@supabase/supabase-js';
import { toast } from 'sonner';
import { supabase } from './supabase';
import { api, ApiClientError } from './api';
import { singleFlight } from './single-flight';
import { beginLocalAuthAction, subscribeForeignSwitch, subscribeSession } from './session-store';

export interface Me {
  id: string;
  email: string;
  authority: 'staff' | 'gm' | 'founder' | 'admin';
  personId: string | null;
  memberships: { module: string; position: string; isActive: boolean }[];
  // The real "may clear a task / decide a flagged cancellation" flag,
  // computed server-side from `core.is_clearing_founder()`'s rule (admin,
  // or the single seated clearing founder). Never infer this from
  // `authority === 'admin' || authority === 'founder'` — a non-clearing
  // founder has authority 'founder' too, and that inference is exactly
  // the bug this field exists to close.
  isClearingFounder: boolean;
  // Mirrors `core.users.read_only` (a strictly read-only founder
  // account -- ERC, DCA -- see OPEN-QUESTIONS.md #5 and
  // supabase/migrations/20260910120100_core_read_only_accounts.sql).
  // `lib/task-permissions.ts` is the single place this gates write
  // affordances; nothing else should re-derive it.
  readOnly: boolean;
}

interface AuthContextValue {
  session: Session | null;
  me: Me | null;
  loading: boolean;
  /**
   * Why `/api/me` could not be loaded, or null. A signed-in session whose
   * profile never arrives is NOT the same state as one still in flight,
   * and conflating them is what left `/queue` and `/digest` on the
   * loading shell forever with the API down: `loading` goes false, `me`
   * stays null, and any gate written as `!me` waits on something that is
   * never coming. Deliberately not set when two consecutive 401s end the
   * session — that path signs out and the login redirect is the answer.
   */
  meError: string | null;
  /**
   * The HTTP status behind `meError`, or null when there was no response
   * to read one from (a genuine transport failure).
   *
   * The message alone cannot tell those apart, and the gate rendered
   * every `/api/me` failure as "The LRA Ops server can't be reached …
   * the app will keep working as soon as the connection is back."
   * Driven 2026-09-10 with a deactivated account: the server answered
   * `403 Account is deactivated` — reached, unambiguous, and permanent —
   * and the screen told the user it was a connection problem that would
   * fix itself. They would click Retry forever instead of asking their
   * GM why they were switched off.
   */
  meErrorStatus: number | null;
  /** Re-run the profile load, for the Retry on that failure panel. */
  retryMe: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [me, setMe] = React.useState<Me | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [meError, setMeError] = React.useState<string | null>(null);
  const [meErrorStatus, setMeErrorStatus] = React.useState<number | null>(null);

  const fetchMe = React.useCallback(async () => {
    try {
      const profile = await api.get<Me>('/api/me');
      setMe(profile);
      setMeError(null);
      setMeErrorStatus(null);
      return;
    } catch (err) {
      if (err instanceof ApiClientError) {
        console.error('[auth] failed to load /api/me', err.message);
      }
      // A single 401 is not proof the session is dead. This is the
      // exact shape of the reproduced bug: two near-simultaneous
      // requests with the same valid token, one of which came back 401
      // for reasons that had nothing to do with the token being bad.
      // Retry once before drawing any conclusion.
      if (err instanceof ApiClientError && err.status === 401) {
        try {
          const profile = await api.get<Me>('/api/me');
          setMe(profile);
          setMeError(null);
          return;
        } catch (retryErr) {
          // Two consecutive 401s on the same session is the real
          // signal — the session is genuinely rejected server-side.
          // Say so on screen (never a silent bounce) and drop only
          // *this device's* session, not every session everywhere.
          if (retryErr instanceof ApiClientError && retryErr.status === 401) {
            toast.error('Your session could not be verified and you have been signed out.', {
              description: 'Please sign in again.',
            });
            await supabase.auth.signOut({ scope: 'local' });
          }
          setMe(null);
          // No `meError`: this path has just signed the device out, so
          // the session goes null and ProtectedRoute redirects to
          // /login. A failure panel behind a redirect is never seen.
          return;
        }
      }
      setMe(null);
      setMeError(
        err instanceof ApiClientError && err.message
          ? err.message
          : 'Could not reach the server to load your profile.'
      );
      // Null when there was no response at all — that IS the unreachable
      // case, and the only one the unreachable panel may claim.
      setMeErrorStatus(err instanceof ApiClientError ? err.status : null);
    }
  }, []);

  // `signIn` and the `onAuthStateChange` listener both need to trigger a
  // profile load for the same sign-in event. Sharing one single-flight
  // wrapper means whichever fires first wins and the other awaits the
  // same request, instead of both firing their own `GET /api/me`.
  const loadMe = React.useMemo(() => singleFlight(fetchMe), [fetchMe]);

  const retryMe = React.useCallback(() => {
    setMeError(null);
    void loadMe();
  }, [loadMe]);

  React.useEffect(() => {
    // One subscription to `lib/session-store.ts` instead of this
    // provider running its own independent `getSession()` bootstrap
    // *and* its own `onAuthStateChange` listener side by side. The store
    // already replays its `INITIAL_SESSION` value to a new subscriber,
    // so there is nothing left here to race -- this callback is called
    // with the exact session the SDK just committed, for the initial
    // load and for every transition after it.
    let first = true;
    const unsubscribe = subscribeSession((next) => {
      setSession(next);
      if (next) {
        void loadMe().finally(() => {
          if (first) setLoading(false);
          first = false;
        });
      } else {
        setMe(null);
        setMeError(null);
        if (first) setLoading(false);
        first = false;
      }
    });

    return unsubscribe;
  }, [loadMe]);

  React.useEffect(() => {
    // See `session-store.ts`'s cross-tab identity guard: this fires when
    // a *different* account signed in in another tab on this origin and
    // this tab was dropped to signed-out as a result. One browser profile
    // cannot hold two identities on one origin -- last sign-in wins, so
    // say that plainly instead of letting the redirect to `/login` (from
    // `session` going `null`, handled above) speak for itself.
    return subscribeForeignSwitch(() => {
      toast.error('You were signed out because a different account signed in in another tab.', {
        description: 'One browser can only stay signed in as one account at a time.',
      });
    });
  }, []);

  const signIn = React.useCallback(async (email: string, password: string) => {
    // Marks the event this call is about to produce as a real, local
    // change of identity -- see `session-store.ts`'s cross-tab bleed
    // guard. Without this, signing in as a *different* account than
    // whatever another open tab last touched is indistinguishable from
    // that other tab's own session bleeding in over the SDK's
    // `BroadcastChannel`, and would be silently ignored.
    beginLocalAuthAction();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // Do not call `loadMe` here — `onAuthStateChange` already fires a
    // SIGNED_IN event for this call and will load the profile itself.
    // Calling it from both places was the original bug: two
    // near-simultaneous `/api/me` requests for one sign-in.
  }, []);

  const signOut = React.useCallback(async () => {
    beginLocalAuthAction();
    await supabase.auth.signOut();
    setMe(null);
  }, []);

  return (
    <AuthContext.Provider value={{ session, me, loading, meError, meErrorStatus, retryMe, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
