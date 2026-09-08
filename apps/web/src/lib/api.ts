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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  const body = await res.json().catch(() => null);

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
