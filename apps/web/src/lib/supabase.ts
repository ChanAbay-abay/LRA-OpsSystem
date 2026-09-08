/**
 * LRA Global Ops :: browser Supabase client
 *
 * Auth only. Data reads/writes go through the API (`lib/api.ts`), which
 * forwards the caller's JWT so RLS applies server-side. The browser
 * client's only job is `signInWithPassword` / `signOut` / holding the
 * session so `lib/api.ts` has a fresh access token to attach.
 */
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  // Fail loudly at import time rather than a confusing runtime error on
  // first sign-in — the same lesson LRA-HR's server-side env.ts encodes.
  console.error(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. ' +
      'Copy apps/web/.env.example to apps/web/.env and fill in the values.'
  );
}

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
