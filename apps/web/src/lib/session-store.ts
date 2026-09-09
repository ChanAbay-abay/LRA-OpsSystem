/**
 * LRA Global Ops :: session store
 *
 * Reproduced defect this file fixes (the sign-in bounce, case A): every
 * caller that wanted "the current session" — `lib/api.ts` on every
 * request, `AuthProvider`'s own bootstrap — called
 * `supabase.auth.getSession()` independently. `getSession()` runs behind
 * the SDK's own internal lock, so a call made *during* a sign-in/sign-out
 * transition can resolve with whatever session was current when the lock
 * was free, not the one the transition just committed. In a captured
 * repro this showed up exactly as: sign in succeeds and mints a fresh
 * token, but the next `GET /api/me` — reading its own independent
 * `getSession()` — attaches the *previous* attempt's token, or none at
 * all.
 *
 * `onAuthStateChange` does not have this problem: the SDK calls it with
 * the session it just committed, from inside the same lock that made the
 * change, and it fires an `INITIAL_SESSION` event on every subscribe
 * (including the very first) so a subscriber never has to separately
 * call `getSession()` to learn the starting state. This module is the
 * *one* subscription for the whole app — `lib/api.ts` reads the token
 * synchronously off it instead of awaiting a fresh `getSession()` per
 * request, and `AuthProvider` mirrors the same stream into React state
 * instead of running its own parallel `getSession()` + listener pair.
 */
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

type Listener = (session: Session | null) => void;

let current: Session | null = null;
// False until the SDK's own `INITIAL_SESSION` event has fired -- before
// that, "no session" and "haven't checked yet" are different facts, and
// callers (`lib/api.ts`, `useResource`) must not treat the second as the
// first.
let ready = false;
const listeners = new Set<Listener>();

supabase.auth.onAuthStateChange((_event, session) => {
  current = session;
  ready = true;
  listeners.forEach((listener) => listener(session));
});

/**
 * Subscribe to every session change from this point on. If the store is
 * already past its initial load, the listener is called immediately with
 * the current session so a late subscriber (e.g. a component mounted
 * after the app already knows the answer) never has to wait for the next
 * auth event to catch up.
 */
export function subscribeSession(listener: Listener): () => void {
  listeners.add(listener);
  if (ready) listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/** Synchronous, race-free read of the current access token, or `null`. */
export function getAccessTokenSync(): string | null {
  return current?.access_token ?? null;
}

/** Has the SDK told us its starting session yet? */
export function isSessionReady(): boolean {
  return ready;
}
