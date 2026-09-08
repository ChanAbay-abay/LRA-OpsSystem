#!/usr/bin/env node
/**
 * LRA Global Ops :: post-migration verification
 *
 * Runs after Chan has applied `supabase/APPLY-TO-PRODUCTION.sql` (or
 * `npm run db:push`) to the linked project, and after he has appended
 * `core` and `ops` to Supabase -> Data API -> Exposed schemas. There is
 * no database password available to this environment, so this is the
 * Phase 0/1 acceptance check done entirely through PostgREST with the
 * service-role key -- the same mechanism that let the pre-rebuild
 * census happen without a Postgres connection string.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/verify-db.mjs
 *
 * or, with apps/api/.env already filled in:
 *   node -r dotenv/config scripts/verify-db.mjs dotenv_config_path=apps/api/.env
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    '[fatal] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n' +
      'Run with: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/verify-db.mjs'
  );
  process.exit(1);
}

const CORE_TABLES = ['people', 'users', 'memberships', 'notifications', 'notification_outbox', 'audit_logs'];
const OPS_TABLES = ['settings', 'weeks'];

async function checkTable(db, schema, table) {
  const client = db.schema(schema);
  const { count, error, status, statusText } = await client
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) {
    // PostgREST returns 406 with an empty body for a schema that has not
    // been added to Data API -> Exposed schemas, so the status/statusText
    // pair carries the real signal when error.message is blank.
    const detail = error.message || `HTTP ${status} ${statusText}`;
    return { schema, table, ok: false, error: detail };
  }
  return { schema, table, ok: true, count };
}

async function main() {
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  console.log('=== LRA Ops :: database verification ===\n');

  let anySchemaError = false;
  const results = [];
  for (const t of CORE_TABLES) results.push(await checkTable(db, 'core', t));
  for (const t of OPS_TABLES) results.push(await checkTable(db, 'ops', t));

  for (const r of results) {
    if (r.ok) {
      console.log(`  ok    ${r.schema}.${r.table.padEnd(20)} rows=${r.count}`);
    } else {
      anySchemaError = true;
      console.log(`  FAIL  ${r.schema}.${r.table.padEnd(20)} ${r.error}`);
    }
  }

  if (anySchemaError) {
    console.log(
      '\nOne or more tables were unreachable. If the error mentions the schema not being ' +
        'found ("The schema must be one of the following..."), Chan has not yet appended ' +
        '`core` and `ops` under Supabase -> Data API -> Exposed schemas (append, never ' +
        'replace -- `public` must stay listed). This is expected until that step is done ' +
        'and is not a code defect.'
    );
  }

  console.log('\n=== auth.users ===');
  const { data: au, error: auErr } = await db.auth.admin.listUsers();
  if (auErr) {
    console.log(`  FAIL  could not list auth.users: ${auErr.message}`);
  } else {
    console.log(`  auth.users count: ${au.users.length}`);
    for (const u of au.users) console.log(`    - ${u.email} (${u.id})`);
    if (au.users.length === 1 && au.users[0].email === 'chanabayabay@gmail.com') {
      console.log('  ok    exactly one account, and it is Chan\'s.');
    } else {
      console.log(
        '  NOTE  expected exactly 1 account (chanabayabay@gmail.com) per PLAN.md §0.1 -- ' +
          'got a different count or email. Investigate before treating Phase 0 as verified.'
      );
    }
  }

}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
