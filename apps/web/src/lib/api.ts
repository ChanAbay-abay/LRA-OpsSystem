/**
 * LRA Global Ops :: hand-written API client
 *
 * No React Query in the MVP (PLAN.md §4) — plain `fetch` with the
 * caller's current Supabase access token attached. Every response is
 * `{ data }` on success or `{ error: { message, code } }` on failure,
 * mirroring the API's own contract exactly so callers never have to
 * guess a shape.
 */
import { supabase } from './supabase';

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    // `fetch` itself throws on a network failure (connection refused,
    // DNS failure, CORS preflight failure) or on our own abort above --
    // both mean "the server cannot be reached", never "there is no
    // data to show".
    const timedOut = err instanceof DOMException && err.name === 'AbortError';
    throw new ApiUnreachableError(
      timedOut
        ? 'The LRA Ops server did not respond in time.'
        : 'Could not reach the LRA Ops server. Check your connection.'
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => null);

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

  return body.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
