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
const OPS_TABLES = [
  'settings', 'weeks',
  // Phase 3/4/5 additions -- present only after supabase/APPLY-PHASE-3-4-5.sql
  // has been pasted into the SQL editor. A FAIL on these before that is
  // expected, not a regression.
  'task_types', 'task_type_revisions', 'recurring_templates', 'tasks', 'task_blocks', 'point_ledger',
];

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

  console.log('\n=== Phase 3/4/5 spot checks ===');

  const { error: clearingFounderErr } = await db.schema('core').from('users').select('is_clearing_founder').limit(1);
  console.log(
    clearingFounderErr
      ? `  FAIL  core.users.is_clearing_founder column: ${clearingFounderErr.message}`
      : '  ok    core.users.is_clearing_founder column exists'
  );

  const { data: draftTypes, error: draftErr } = await db
    .schema('ops')
    .from('task_types')
    .select('name, default_points')
    .is('default_points', null);
  if (draftErr) {
    console.log(`  FAIL  could not read ops.task_types: ${draftErr.message}`);
  } else {
    console.log(`  ok    ${draftTypes.length} DRAFT (unpriced) catalog types -- expected until the founder prices them`);
  }

  // Live RLS spot check with the ANON key (unauthenticated) -- should
  // see zero rows, never an error and never real rows. This is the one
  // negative RLS check this script CAN do without a signed-in session;
  // the full 27-attack suite still needs supabase/tests/rls_test.sql
  // against a real Postgres connection (no Docker available here).
  if (process.env.SUPABASE_ANON_KEY) {
    const anon = createClient(url, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: anonTasks, error: anonErr } = await anon.schema('ops').from('tasks').select('id');
    if (anonErr) {
      console.log(`  ok    anon key cannot read ops.tasks at all (${anonErr.message})`);
    } else {
      console.log(
        anonTasks.length === 0
          ? '  ok    anon key sees zero ops.tasks rows (RLS is filtering, not just erroring)'
          : `  FAIL  anon key saw ${anonTasks.length} ops.tasks row(s) -- RLS is not filtering unauthenticated reads`
      );
    }
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
