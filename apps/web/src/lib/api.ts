/**
 * LRA Global Ops :: hand-written API client
 *
 * No React Query in the MVP (PLAN.md §4) — plain `fetch` with the
 * caller's current Supabase access token attached. Every response is
 * `{ data }` on success or `{ error: { message, code } }` on failure,
 * mirroring the API's own contract exactly so callers never have to
 * guess a shape.
 */
import { getAccessTokenSync } from './session-store';
import { buildHeaders, isNoContent } from './request-headers';

const API_URL = (import.meta.env.VITE_API_URL as string) || 'http://localhost:3001';

// A request that hangs (dropped connection, box down, DNS black hole)
// must not sit in "loading" forever and it must not read as "empty" --
// both are the exact defect Chan reported ("for the infinite loading...
// it should tell the visitor as so"). 10s is generous for a same-region
// API on a normal connection but short enough that a genuinely dead
// server surfaces within the length of a coffee sip, not a meeting.
const REQUEST_TIMEOUT_MS = 10_000;

export class ApiClientError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The API could not be reached at all, or answered with a 5xx — as far
 * as the user is concerned these are the same story ("the system is
 * down"), and neither is the same story as a 4xx ("your request was
 * refused"). `useResource` (lib/use-resource.ts) is the one place this
 * distinction turns into a screen state, so every page gets the same
 * unreachable/error/empty split for free instead of re-deriving it.
 */
export class ApiUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiUnreachableError';
  }
}

/**
 * Every route this client calls requires a signed-in caller (PLAN.md
 * §1) -- there is no public GET in this API. Reproduced defect this
 * class fixes: sending a request with no `Authorization` header at all
 * during a sign-in transition, which the server correctly 401s, but
 * which looks to the caller exactly like a rejected session instead of
 * what it actually is -- a request fired before there was anything to
 * attach. Refuse to send it instead of sending it unauthenticated.
 * `useResource` (lib/use-resource.ts) is the one place that should ever
 * see this, and only as a last-resort guard -- it already waits for a
 * settled session before calling in.
 */
export class ApiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiAuthError';
  }
}

interface RequestOptions {
  signal?: AbortSignal;
}


async function request<T>(path: string, init: RequestInit = {}, external?: AbortSignal): Promise<T> {
  // Read from the one session-store subscription (lib/session-store.ts)
  // instead of calling `supabase.auth.getSession()` here. That call used
  // to race a concurrent sign-in/sign-out: it could resolve with the
  // *previous* attempt's session, or none, because it isn't served from
  // the same lock that committed the transition. The store's value is
  // always the session the SDK itself just committed.
  const token = getAccessTokenSync();
  if (!token) {
    throw new ApiAuthError('Not signed in.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  external?.addEventListener('abort', onExternalAbort);
  if (external?.aborted) controller.abort();

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: buildHeaders(init.body, token, init.headers),
    });
  } catch (err) {
    // A caller-initiated abort (the component unmounted, or a newer
    // request superseded this one -- see `useResource`) is not a server
    // problem and must not render as one; let it propagate as the plain
    // `AbortError` it is so the caller's own `signal.aborted` check
    // swallows it.
    if (external?.aborted) throw err;
    // Otherwise `fetch` threw on a network failure (connection refused,
    // DNS failure, CORS preflight failure) or on our own timeout abort
    // above -- both mean "the server cannot be reached", never "there is
    // no data to show".
    const timedOut = err instanceof DOMException && err.name === 'AbortError';
    throw new ApiUnreachableError(
      timedOut
        ? 'The LRA Ops server did not respond in time.'
        : 'Could not reach the LRA Ops server. Check your connection.'
    );
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }

  const body = await res.json().catch(() => null);

  // A 204 carries no body, and `body.data` on `null` throws a TypeError that
  // the caller's `catch` then dresses up as a DOMAIN failure.
  //
  // Reproduced (2026-09-10): deleting an unused catalog type answers
  // `204 No Content`, `res.json()` rejects, `body` is null, `body.data` throws
  // -- and `/catalog`'s delete dialog reported "Could not delete this — it may
  // already have been used by a task." The type was already permanently gone.
  // A destructive action that succeeds while telling the person it failed is
  // worse than one that fails: they will try again, or believe the record is
  // still there.
  //
  // Same shape as the `Content-Type` defect in `request-headers.ts` (PLAN.md
  // §11.1) -- the client assuming every response looks like the common case.
  // Checked BEFORE `res.ok`, since 204 is a success and must not fall through
  // to the error branches below.
  if (isNoContent(res.status)) {
    return undefined as T;
  }

  if (res.status >= 500) {
    throw new ApiUnreachableError(body?.error?.message ?? `The server returned an error (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    throw new ApiClientError(
      body?.error?.message ?? `Request failed with status ${res.status}`,
      res.status,
      body?.error?.code
    );
  }

  // A 2xx that is not one of the no-content statuses above is expected to
  // carry `{ data }` -- that is this API's contract for every such route
  // (see the file header). An empty body here is a genuine contract
  // violation, so it must not be silently coerced to `undefined`: that
  // would turn a broken endpoint into a screen showing nothing, which is
  // the hardest kind of bug to find from the outside.
  if (body == null || !('data' in body)) {
    throw new ApiUnreachableError(
      `The server answered ${res.status} without the expected body. This is a bug in the API, not in your request.`
    );
  }

  return body.data as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>(path, { method: 'GET' }, opts?.signal),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }, opts?.signal),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }, opts?.signal),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>(path, { method: 'DELETE' }, opts?.signal),
};
