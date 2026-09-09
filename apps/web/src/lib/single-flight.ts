/**
 * LRA Global Ops :: single-flight async guard
 *
 * Wraps an async function so that overlapping callers share exactly one
 * underlying call instead of each firing their own. This exists because
 * of a real, reproduced bug: `AuthProvider.signIn()` and its own
 * `onAuthStateChange` listener both call `loadMe()` for the same
 * sign-in, producing two near-simultaneous `GET /api/me` requests with
 * the same token — and the second one has come back 401 in practice.
 * Deduping at the call site removes the race outright rather than
 * hoping the two triggers never overlap (React 19 StrictMode's
 * double-invoked dev effects make "never" an unsafe bet).
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  return () => {
    if (inFlight) return inFlight;
    const p = fn().finally(() => {
      // Only clear if this call is still the current one — a stale
      // `.finally` from an already-superseded call must not wipe out a
      // newer in-flight promise.
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };
}
