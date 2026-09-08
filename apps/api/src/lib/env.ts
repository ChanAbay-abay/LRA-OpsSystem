/**
 * LRA Global Ops :: Environment
 *
 * Read lazily, never snapshotted at module load. LRA-HR's entire first
 * life was every authenticated request returning 500 while /health
 * stayed green, because Supabase keys were read into module-level
 * constants and import order decided whether `dotenv/config` had run
 * yet. Reading `process.env` inside these functions, at call time,
 * makes that bug structurally impossible here.
 */

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

export function env(name: (typeof REQUIRED)[number]): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. The API cannot reach Supabase without it.`
    );
  }
  return v;
}

/** Called at boot. Reports every missing variable at once, not just the first. */
export function assertEnv(): void {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(
      `\n[fatal] Missing required environment: ${missing.join(', ')}\n` +
        `Copy apps/api/.env.example to apps/api/.env and fill in the values\n` +
        `from your Supabase dashboard under Project Settings > API.\n`
    );
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL!;
  if (url.includes('/rest/v1')) {
    console.error(
      `\n[fatal] SUPABASE_URL must be the bare project URL.\n` +
        `  got:      ${url}\n` +
        `  expected: ${url.split('/rest/v1')[0]}\n` +
        `supabase-js appends /rest/v1 and /auth/v1 itself.\n`
    );
    process.exit(1);
  }
}
