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
}

interface AuthContextValue {
  session: Session | null;
  me: Me | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [me, setMe] = React.useState<Me | null>(null);
  const [loading, setLoading] = React.useState(true);

  const fetchMe = React.useCallback(async () => {
    try {
      const profile = await api.get<Me>('/api/me');
      setMe(profile);
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
          return;
        }
      }
      setMe(null);
    }
  }, []);

  // `signIn` and the `onAuthStateChange` listener both need to trigger a
  // profile load for the same sign-in event. Sharing one single-flight
  // wrapper means whichever fires first wins and the other awaits the
  // same request, instead of both firing their own `GET /api/me`.
  const loadMe = React.useMemo(() => singleFlight(fetchMe), [fetchMe]);

  React.useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) void loadMe().finally(() => setLoading(false));
      else setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (next) void loadMe();
      else setMe(null);
    });

    return () => sub.subscription.unsubscribe();
  }, [loadMe]);

  const signIn = React.useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // Do not call `loadMe` here — `onAuthStateChange` already fires a
    // SIGNED_IN event for this call and will load the profile itself.
    // Calling it from both places was the original bug: two
    // near-simultaneous `/api/me` requests for one sign-in.
  }, []);

  const signOut = React.useCallback(async () => {
    await supabase.auth.signOut();
    setMe(null);
  }, []);

  return (
    <AuthContext.Provider value={{ session, me, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
