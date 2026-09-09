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
 *
 * Cross-tab identity guard (case C, found chasing the persistent sign-in
 * bounce Chan re-reported): one browser profile can hold exactly one
 * Supabase session per origin -- `@supabase/auth-js` stores it under one
 * `localStorage` key and opens one `BroadcastChannel` on it, and every
 * same-origin tab's own SDK *instance* applies whatever it hears there,
 * by design. That means the underlying SDK client in tab A silently
 * adopts tab B's session the moment tab B signs in as a different demo
 * account -- this module cannot stop that part, it happens one layer
 * below us. What it can control is what this app *believes* and *does*
 * about its own identity.
 *
 * The first version of this guard tried to have tab A ignore the foreign
 * event and keep showing its old user. That was worse than useless: the
 * SDK's real internal session (and its auto-refresh timer) had already
 * moved to tab B's account, so tab A's ignored, un-refreshed access token
 * just sat there quietly decaying with nothing renewing it, surfacing as
 * a confusing, delayed, unexplained 401 whenever it finally expired --
 * while tab A's screen kept claiming to be signed in as someone else the
 * whole time.
 *
 * One browser profile genuinely cannot hold two identities on one
 * origin, so the deliberate, honest behaviour is: last sign-in wins, and
 * every *other* tab notices immediately and gives up its own session
 * with a clear on-screen reason -- never a silent bleed, never a silent
 * decay into a mystery bounce. `beginLocalAuthAction` marks the one-shot
 * window around this tab's own `signIn`/`signOut` calls, so that action
 * is trusted unconditionally; any other event that tries to switch this
 * tab to a different account fires `subscribeForeignSwitch` and drops
 * this tab to signed-out. Once dropped, `disowned` keeps this tab from
 * silently re-adopting whatever session shows up next -- only this tab's
 * own explicit sign-in may restore it.
 */
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

type Listener = (session: Session | null) => void;
type ForeignSwitchListener = () => void;

let current: Session | null = null;
// False until the SDK's own `INITIAL_SESSION` event has fired -- before
// that, "no session" and "haven't checked yet" are different facts, and
// callers (`lib/api.ts`, `useResource`) must not treat the second as the
// first.
let ready = false;
const listeners = new Set<Listener>();
const foreignSwitchListeners = new Set<ForeignSwitchListener>();

// Set immediately before this tab's own `signIn` / `signOut` call so the
// very next auth event is trusted unconditionally, even if it changes
// which user this tab holds. Cleared as soon as that event lands.
let expectingLocalUserChange = false;

// True once this tab has been dropped to signed-out because a *different*
// account signed in in another tab. While true, this tab must not accept
// any further foreign auth event -- otherwise the very next unrelated
// tab's sign-in would quietly resurrect it as yet another identity it
// never asked for. Only this tab's own `signIn`/`signOut` (via
// `beginLocalAuthAction`) clears it.
let disowned = false;

/**
 * Call immediately before this tab invokes `signInWithPassword` or
 * `signOut` itself. Marks the next auth event as a real, user-initiated
 * change of identity in *this* tab, as opposed to a same-user-elsewhere
 * broadcast or, worse, a different demo account signed in in a sibling
 * tab bleeding across the shared `BroadcastChannel`.
 */
export function beginLocalAuthAction(): void {
  expectingLocalUserChange = true;
}

/**
 * Subscribe to be told when THIS tab was dropped to signed-out because a
 * different account signed in in another tab on the same origin -- as
 * opposed to an ordinary sign-out, which `subscribeSession` alone already
 * reports as `null`. `auth-context.tsx` uses this to show a message that
 * says why, instead of a bare, unexplained bounce to `/login`.
 */
export function subscribeForeignSwitch(listener: ForeignSwitchListener): () => void {
  foreignSwitchListeners.add(listener);
  return () => {
    foreignSwitchListeners.delete(listener);
  };
}

supabase.auth.onAuthStateChange((_event, session) => {
  const isLocalAction = expectingLocalUserChange;
  expectingLocalUserChange = false;

  if (isLocalAction) {
    // This tab asked for this change itself -- trust it unconditionally
    // and let it back in even if `disowned` was set by an earlier foreign
    // switch.
    disowned = false;
    current = session;
    ready = true;
    listeners.forEach((listener) => listener(session));
    return;
  }

  if (!ready) {
    // The SDK's own `INITIAL_SESSION` replay on first subscribe -- there
    // is nothing yet to compare it against, so there is no such thing as
    // "foreign" here.
    current = session;
    ready = true;
    listeners.forEach((listener) => listener(session));
    return;
  }

  if (disowned) {
    // This tab already gave up its identity after a foreign switch and is
    // deliberately showing signed-out. Do not let whatever another tab
    // does next quietly resurrect it -- only this tab's own sign-in
    // (handled above) may.
    return;
  }

  if (session == null) {
    // A sign-out anywhere on this origin signs out everywhere -- that is
    // correct when it's the same account, and there is no "foreign" case
    // for a sign-out: nobody's identity is being replaced by nothing.
    current = null;
    listeners.forEach((listener) => listener(null));
    return;
  }

  if (current != null && session.user.id !== current.user.id) {
    // Another tab on this origin just signed in as a *different* account.
    // The SDK's own session (and its auto-refresh timer) has already
    // moved to that account -- nothing will ever refresh this tab's old
    // token again, so pretending to keep this tab's identity would only
    // trade a visible, honest sign-out now for a silent, unexplained 401
    // later. One browser profile cannot hold two identities on one
    // origin: last sign-in wins, and this tab gives its up cleanly.
    current = null;
    disowned = true;
    foreignSwitchListeners.forEach((listener) => listener());
    listeners.forEach((listener) => listener(null));
    return;
  }

  // Same account, relayed from another tab (e.g. a token refresh that tab
  // performed) -- this is still "us", accept it.
  current = session;
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
