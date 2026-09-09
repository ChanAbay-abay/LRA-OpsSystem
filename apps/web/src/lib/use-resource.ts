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
 */
import * as React from 'react';
import { ApiClientError, ApiUnreachableError } from './api';

export type ResourceStatus = 'loading' | 'unreachable' | 'error' | 'ready';

export interface Resource<T> {
  status: ResourceStatus;
  data: T | null;
  message: string | null;
  /** Re-run the loader without remounting the screen. */
  reload: () => void;
}

export function useResource<T>(loader: () => Promise<T>, deps: React.DependencyList = []): Resource<T> {
  const [status, setStatus] = React.useState<ResourceStatus>('loading');
  const [data, setData] = React.useState<T | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const loaderRef = React.useRef(loader);
  loaderRef.current = loader;

  React.useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setMessage(null);

    loaderRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiUnreachableError) {
          setStatus('unreachable');
          setMessage(err.message);
        } else {
          setStatus('error');
          setMessage(err instanceof ApiClientError ? err.message : 'Something went wrong.');
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { status, data, message, reload: () => setTick((t) => t + 1) };
}
