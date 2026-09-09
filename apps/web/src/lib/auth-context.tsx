/**
 * LRA Global Ops :: auth context
 *
 * Holds the Supabase session and the API's own `/api/me` profile
 * (authority + memberships), which is the only source either the
 * sidebar or a route guard trusts — never the JWT's own claims, per
 * PLAN.md's standing rule that authority is read from `core.users`.
 */
import * as React from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { api, ApiClientError } from './api';

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

  const loadMe = React.useCallback(async () => {
    try {
      const profile = await api.get<Me>('/api/me');
      setMe(profile);
    } catch (err) {
      // No profile yet (e.g. an auth user with no core.users row) is a
      // real, distinct state from "not logged in" — surface it rather
      // than silently pretending the session doesn't exist.
      if (err instanceof ApiClientError) {
        console.error('[auth] failed to load /api/me', err.message);
      }
      // A 401 specifically means the session itself is invalid/expired
      // (defect #5) — leaving `session` set while `me` is null renders a
      // half-authenticated shell (sidebar with blank role, dead nav
      // links, "Invalid or expired token" inline). Sign out so the
      // Supabase client drops the stale session and the app falls
      // through to the normal signed-out redirect to /login, instead of
      // limping along on a session the server has already rejected.
      if (err instanceof ApiClientError && err.status === 401) {
        await supabase.auth.signOut();
      }
      setMe(null);
    }
  }, []);

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
    await loadMe();
  }, [loadMe]);

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
