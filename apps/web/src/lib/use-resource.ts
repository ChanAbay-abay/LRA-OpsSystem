/**
 * LRA Global Ops :: useResource — one loading contract for every screen
 *
 * Chan reproduced this with the API down: `/board` showed "Loading…"
 * forever with no error, and every other route hand-rolled its own
 * `useState<T | null>` + a bare `.catch(() => toast.error(...))` that
 * left the page stuck in the exact same state. This hook is the single
 * place that distinguishes the four honest states a data fetch can be
 * in, so no route has to re-derive the difference between "nothing
 * back yet" and "never coming back":
 *
 *   loading      — the request is in flight.
 *   unreachable  — the API could not be reached, or answered 5xx
 *                  (ApiUnreachableError, lib/api.ts). Not the user's
 *                  fault; offer Retry and how to reach the developer.
 *   error        — the API was reached and refused the request (4xx).
 *   ready        — data came back. Emptiness ("no rows") is a property
 *                  of the data, not a fifth status — callers decide
 *                  what "empty" looks like for their own screen.
 *
 * A request that never resolves cannot get stuck in `loading` forever
 * either: `lib/api.ts`'s own request timeout (10s) always settles the
 * promise one way or the other, so this hook never has to implement a
 * second timeout of its own.
 *
 * Reproduced defect this file fixes (the sign-in bounce, case B): a
 * protected screen mounts the instant `AuthProvider`'s `session` goes
 * non-null, which can be *before* `lib/session-store.ts` and the rest of
 * the app have finished settling that sign-in. Firing the loader in that
 * window 401s the request through no fault of the token, and because the
 * old code treated a 401 from *any* route the same way it treated a
 * dead session, that spurious failure bounced a perfectly good sign-in
 * back to `/login`. Fixed once, here, instead of per route: the hook
 * waits for `useAuth()` to report a settled session before ever calling
 * the loader, and a resource-route 401 now only ever renders this
 * screen's own `error` state (`ResourceView`, ui/resource-state.tsx) --
 * it can no longer force a sign-out. Only `AuthProvider.fetchMe`'s own
 * repeated-401 check on `/api/me` is allowed to decide the session is
 * dead.
 *
 * The loader also receives an `AbortSignal`, aborted on cleanup. This is
 * what actually stops the double `GET` that React 19 StrictMode's
 * mount → cleanup → remount dance used to produce in dev: the first
 * mount's request is now genuinely cancelled, not just ignored, so the
 * network never sees it complete.
 */
import * as React from 'react';
import { ApiAuthError, ApiClientError, ApiUnreachableError } from './api';
import { useAuth } from './auth-context';

export type ResourceStatus = 'loading' | 'unreachable' | 'error' | 'ready';

export interface Resource<T> {
  status: ResourceStatus;
  data: T | null;
  message: string | null;
  /** Re-run the loader without remounting the screen. */
  reload: () => void;
}

export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: React.DependencyList = []
): Resource<T> {
  const [status, setStatus] = React.useState<ResourceStatus>('loading');
  const [data, setData] = React.useState<T | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const loaderRef = React.useRef(loader);
  loaderRef.current = loader;

  // Every screen that calls this hook lives behind `ProtectedRoute`
  // (App.tsx), which only ever renders its children once auth has
  // finished loading -- but "finished loading" is about the *first*
  // page load, not a fresh sign-in that just landed on this route.
  // `authReady` is the actual precondition for firing a request: auth
  // is no longer initializing, and there is a session to attach.
  const { session, loading: authLoading } = useAuth();
  const authReady = !authLoading && session != null;

  React.useEffect(() => {
    if (!authReady) return;

    const controller = new AbortController();
    setStatus('loading');
    setMessage(null);

    loaderRef
      .current(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiUnreachableError) {
          setStatus('unreachable');
          setMessage(err.message);
        } else {
          setStatus('error');
          setMessage(
            err instanceof ApiClientError || err instanceof ApiAuthError ? err.message : 'Something went wrong.'
          );
        }
      });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, authReady]);

  return { status, data, message, reload: () => setTick((t) => t + 1) };
}
