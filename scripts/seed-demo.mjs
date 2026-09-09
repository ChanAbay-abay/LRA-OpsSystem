#!/usr/bin/env node
/**
 * LRA Global Ops :: seed-demo — solo test drive before the real invites
 *
 * Chan tonight: "im not about to invite them yet. i want to test this
 * out first. technically i will invite founder 1 (dad), sales, broker,
 * and GM once this is good." This script is the whole test drive: four
 * synthetic accounts covering every access role, and a realistic week
 * of tasks so the board, blockers, ledger states and carry-over are all
 * visibly exercised instead of an empty screen.
 *
 * The accounts use `@ops-demo.invalid` — `.invalid` is the RFC 2606
 * reserved TLD that is guaranteed to never resolve or belong to a real
 * person, so these can never be confused with the real GM/Sales/
 * Broker/Founder accounts that follow later. Credentials print to
 * stdout ONLY, never to a committed file, matching the same rule
 * `scripts/provision.md` already states for the manual fallback.
 *
 * Every write after account creation goes through each persona's OWN
 * signed-in client (anon key + their real access token), not the
 * service role — the whole point is to exercise `ops.tasks` RLS and the
 * state-machine trigger exactly as production traffic would, which
 * doubles this script as the "integration across a process boundary"
 * check PLAN.md §6 asks for, run against the live database instead of
 * a local one.
 *
 * Usage:
 *   node scripts/seed-demo.mjs            seed (idempotent-ish; re-running
 *                                          resets each demo account's
 *                                          password and repairs missing rows)
 *   node scripts/seed-demo.mjs --purge     remove the four accounts and
 *                                          every row they own, returning
 *                                          the database to its current
 *                                          clean state (1 real auth user)
 *
 * Reads Supabase credentials from apps/api/.env automatically so this
 * stays one command; falls back to already-exported environment
 * variables if that file is absent.
 */

import { createClient } from '@supabase/supabase-js';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', 'apps', 'api', '.env');
if (existsSync(envPath)) {
  const { config } = await import('dotenv');
  config({ path: envPath });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error(
    '[fatal] SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be set ' +
      '(apps/api/.env, or exported in the environment).'
  );
  process.exit(1);
}

const DEMO_DOMAIN = 'ops-demo.invalid';
const PURGE = process.argv.includes('--purge');
/** Opt-in. Without it, an existing account's password is never touched. */
const ROTATE = process.argv.includes('--rotate-passwords');

// Chan, 2026-09-09: three founder accounts, not one. LRA clears points;
// ERC and DCA are the other two brokerages and are strictly READ-ONLY —
// they exist so their principals can keep tabs on progress and change
// nothing. `readOnly` maps to `core.users.read_only`, which the database
// guards on every write policy, trigger and security-definer RPC.
// See OPEN-QUESTIONS.md #5.
const PERSONAS = [
  { key: 'founder', firstName: 'Founder', lastName: 'Demo', authority: 'founder', position: 'founder', isClearingFounder: true },
  { key: 'gm', firstName: 'GM', lastName: 'Demo', authority: 'gm', position: 'gm' },
  { key: 'sales', firstName: 'Sales', lastName: 'Demo', authority: 'staff', position: 'sales' },
  { key: 'broker', firstName: 'Broker', lastName: 'Demo', authority: 'staff', position: 'broker' },
  { key: 'erc', firstName: 'ERC', lastName: 'Demo', authority: 'founder', position: 'founder', readOnly: true },
  { key: 'dca', firstName: 'DCA', lastName: 'Demo', authority: 'founder', position: 'founder', readOnly: true },
].map((p) => ({ ...p, email: `${p.key}-demo@${DEMO_DOMAIN}` }));

/**
 * True once we have learned that `core.users.read_only` does not exist
 * yet. The read-only migration (20260910120100) is applied by hand in the
 * Supabase SQL editor, so this script has to run correctly on both sides
 * of it: it sets the flag when the column is there, and says loudly that
 * it could not when it is not. It must never fail silently — an ERC
 * account that looks provisioned but can still write is the exact defect
 * the flag exists to prevent.
 */
let readOnlyColumnMissing = false;

const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** Meets the project's tightened password policy: 10+ chars, lower+upper+digit. */
function generatePassword() {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = lower + upper + digits;
  const pick = (set) => set[randomInt(set.length)];
  let pw = pick(lower) + pick(upper) + pick(digits);
  for (let i = pw.length; i < 16; i++) pw += pick(all);
  return pw;
}

async function findAuthUserByEmail(email) {
  // No `getUserByEmail` in supabase-js admin API; page through listUsers.
  // Four demo accounts will never need more than one page in practice.
  const { data, error } = await svc.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  return data.users.find((u) => u.email === email) ?? null;
}

async function purge() {
  console.log(`=== LRA Ops :: purging demo accounts (@${DEMO_DOMAIN}) ===\n`);

  const authUsers = [];
  for (const persona of PERSONAS) {
    const existing = await findAuthUserByEmail(persona.email);
    if (existing) authUsers.push(existing);
  }

  if (!authUsers.length) {
    console.log('Nothing to purge — no demo accounts found.');
    return;
  }

  const userIds = authUsers.map((u) => u.id);

  // 1. Blocks referencing demo tasks/users on either side.
  const { data: demoTasks } = await svc.schema('ops').from('tasks').select('id').in('owner_user_id', userIds);
  const taskIds = (demoTasks ?? []).map((t) => t.id);

  if (taskIds.length) {
    await svc.schema('ops').from('task_blocks').delete().in('task_id', taskIds);
    await svc.schema('ops').from('task_blocks').delete().in('blocking_task_id', taskIds);
  }
  await svc.schema('ops').from('task_blocks').delete().in('blocking_user_id', userIds);
  await svc.schema('ops').from('task_blocks').delete().in('created_by', userIds);

  // 2. Ledger rows -- DELETE is permitted here only because this script
  //    runs as a direct service-role connection (core.is_system_caller())
  //    and only for exactly this purge. See
  //    ops_ledger_purge_exception.sql for why that exception exists and
  //    why core.audit_logs gets no equivalent.
  if (taskIds.length) {
    await svc.schema('ops').from('point_ledger').delete().in('task_id', taskIds);
  }
  await svc.schema('ops').from('point_ledger').delete().in('user_id', userIds);

  // 3. Tasks.
  if (taskIds.length) {
    await svc.schema('ops').from('tasks').delete().in('id', taskIds);
  }

  // 4. People (memberships/notifications/outbox cascade from core.users
  //    itself; people does not, so it needs an explicit delete).
  await svc.schema('core').from('people').delete().in('email', PERSONAS.map((p) => p.email));

  // 4b. Notes, memberships, notifications and outbox rows, then the
  //     core.users rows themselves.
  //
  //     This used to rely on `delete auth.users` cascading down to
  //     core.users. That cascade is GONE: migration 20260910090000
  //     deliberately dropped the core.users -> auth.users FK so the
  //     14-day purge can delete a login while keeping the person's
  //     history attributed. The consequence for THIS script is that
  //     deleting the auth user now orphans core.users instead of
  //     removing it -- which is exactly what happened: four logins were
  //     deleted while five core.users rows and fourteen tasks survived,
  //     leaving accounts that could not be signed into and a ledger
  //     emptied out from under still-'cleared' tasks. Delete explicitly.
  if (taskIds.length) {
    await svc.schema('ops').from('task_notes').delete().in('task_id', taskIds);
  }
  await svc.schema('core').from('memberships').delete().in('user_id', userIds);
  await svc.schema('core').from('notifications').delete().in('user_id', userIds);
  await svc.schema('core').from('notification_outbox').delete().in('recipient_id', userIds);
  await svc.schema('core').from('users').delete().in('id', userIds);

  // 5. The auth logins. core.audit_logs rows naming these actors are
  //    left in place on purpose: it is append-only by design, and a
  //    `.invalid` email in a history table is harmless.
  for (const u of authUsers) {
    const { error } = await svc.auth.admin.deleteUser(u.id);
    if (error) console.error(`  [warn] could not delete auth user ${u.email}: ${error.message}`);
    else console.log(`  removed ${u.email}`);
  }

  console.log('\nDone. The database should now have exactly the accounts it had before this script ran.');
}

async function upsertPerson(persona) {
  const { data: existing } = await svc.schema('core').from('people').select('id').eq('email', persona.email).maybeSingle();
  if (existing) return existing.id;

  const { data, error } = await svc
    .schema('core')
    .from('people')
    .insert({
      person_code: `DEMO-${persona.key.toUpperCase()}`,
      first_name: persona.firstName,
      last_name: persona.lastName,
      display_name: `${persona.firstName} (demo)`,
      email: persona.email,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

/** Postgres 42703 / PostgREST PGRST204: the column is not there. */
function isMissingColumn(error) {
  if (!error) return false;
  return error.code === '42703' || error.code === 'PGRST204' || /read_only/.test(error.message ?? '');
}

async function upsertCoreUser(authUserId, personId, persona) {
  const base = {
    authority: persona.authority,
    person_id: personId,
    is_active: true,
    is_clearing_founder: Boolean(persona.isClearingFounder),
  };
  const { data: existing } = await svc.schema('core').from('users').select('id').eq('id', authUserId).maybeSingle();

  // Try WITH read_only first, and fall back only on a missing column —
  // never on any other error, which would hide a real failure.
  const attempt = async (payload) =>
    existing
      ? svc.schema('core').from('users').update(payload).eq('id', authUserId)
      : svc.schema('core').from('users').insert({ id: authUserId, email: persona.email, ...payload });

  let { error } = await attempt({ ...base, read_only: Boolean(persona.readOnly) });
  if (isMissingColumn(error)) {
    readOnlyColumnMissing = true;
    ({ error } = await attempt(base));
  }
  if (error) throw error;
}

async function upsertMembership(authUserId, persona) {
  const { data: existing } = await svc
    .schema('core')
    .from('memberships')
    .select('id')
    .eq('user_id', authUserId)
    .eq('module', 'ops')
    .maybeSingle();
  if (existing) {
    await svc.schema('core').from('memberships').update({ position: persona.position, is_active: true }).eq('id', existing.id);
    return;
  }
  const { error } = await svc
    .schema('core')
    .from('memberships')
    .insert({ user_id: authUserId, module: 'ops', position: persona.position });
  if (error) throw error;
}

async function seed() {
  console.log(`=== LRA Ops :: seeding ${PERSONAS.length} demo accounts (@${DEMO_DOMAIN}) ===\n`);

  const credentials = [];
  const clients = {};
  let anyRotated = false;

  for (const persona of PERSONAS) {
    let authUser = await findAuthUserByEmail(persona.email);
    let password = null;   // only known for accounts this run actually created

    if (!authUser) {
      password = generatePassword();
      const { data, error } = await svc.auth.admin.createUser({
        email: persona.email,
        password,
        email_confirm: true,
      });
      if (error) throw error;
      authUser = data.user;
      console.log(`  created ${persona.email}`);
    } else if (ROTATE) {
      password = generatePassword();
      const { error } = await svc.auth.admin.updateUserById(authUser.id, { password });
      if (error) throw error;
      anyRotated = true;
      console.log(`  found ${persona.email}, password ROTATED (--rotate-passwords)`);
    } else {
      console.log(`  found ${persona.email}, password left alone`);
    }

    const personId = await upsertPerson(persona);
    await upsertCoreUser(authUser.id, personId, persona);
    await upsertMembership(authUser.id, persona);

    if (password) credentials.push({ role: persona.key, email: persona.email, password });

    // Seeding runs as each persona so it exercises RLS exactly as production
    // traffic does -- which needs a session. Earlier this script reset the
    // password on every run purely to obtain one, silently invalidating any
    // credentials already handed out. Three separate people lost access that
    // way. The admin API can mint a session WITHOUT touching the password,
    // so a re-run no longer costs anyone their login.
    const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    if (password) {
      const { error: signInError } = await anon.auth.signInWithPassword({ email: persona.email, password });
      if (signInError) throw new Error(`could not sign in as ${persona.email}: ${signInError.message}`);
    } else {
      const { data: link, error: linkError } = await svc.auth.admin.generateLink({
        type: 'magiclink',
        email: persona.email,
      });
      if (linkError) throw new Error(`could not mint a session for ${persona.email}: ${linkError.message}`);
      const { error: otpError } = await anon.auth.verifyOtp({
        token_hash: link.properties.hashed_token,
        type: 'magiclink',
      });
      if (otpError) throw new Error(`could not verify session for ${persona.email}: ${otpError.message}`);
    }
    clients[persona.key] = anon;
  }

  // A re-run silently invalidates any credentials shared earlier (Slack
  // message, screenshot, whatever) -- every existing persona gets its
  // password reset above. That is an easy trap if it is buried in the
  // same quiet "found X, password reset" line as everything else, so
  // make it loud and impossible to miss in stdout.
  if (anyRotated) {
    const banner = '!'.repeat(78);
    console.log(`\n${banner}`);
    console.log('  PASSWORDS ROTATED: this was a re-run, not a first seed.');
    console.log('  Every demo account that already existed just got a NEW password.');
    console.log('  Any credentials you shared before this run (Slack, screenshot, etc.)');
    console.log('  are now WRONG. Only the table printed below is current.');
    console.log(banner);
  }

  console.log('\n=== Credentials (printed once, never written to disk) ===');
  console.table(credentials);

  await seedWeek(clients);

  console.log(
    '\nSeeded. Log in at the web app with any of the credentials above, or run ' +
      '`node scripts/seed-demo.mjs --purge` when you are done testing.'
  );
}

async function taskTypeId(name) {
  const { data, error } = await svc.schema('ops').from('task_types').select('id').eq('name', name).single();
  if (error) throw new Error(`catalog type "${name}" not found -- has ops_seed_catalog.sql been applied? (${error.message})`);
  return data.id;
}

async function currentWeekId() {
  // Mirrors ops.week_start_for()/manilaWeekStart() in plain JS rather
  // than calling into Postgres for it: reuse this week's row if it
  // already exists, else create it.
  const manilaNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const dow = manilaNow.getUTCDay() || 7; // 1=Mon..7=Sun
  const monday = new Date(manilaNow);
  monday.setUTCDate(manilaNow.getUTCDate() - (dow - 1));
  const weekStart = monday.toISOString().slice(0, 10);

  const { data: existing } = await svc.schema('ops').from('weeks').select('id, week_start').eq('week_start', weekStart).maybeSingle();
  if (existing) return { id: existing.id, weekStart };

  const { data: created, error: createError } = await svc.schema('ops').from('weeks').insert({ week_start: weekStart }).select('id').single();
  if (createError) throw createError;
  return { id: created.id, weekStart };
}

// The demo title (`[DEMO] <title>`) plus `week_id` uniquely identifies
// each hand-seeded task -- every title in `seedWeek` below is distinct
// and only ever created once per week. Re-running the script now looks
// for that row first instead of inserting a duplicate, which is the
// actual bug: `seedWeek` never checked before, so a second run doubled
// every board column and inflated every point total with no error, even
// though the script's own doc comment claimed it "repairs missing rows".
async function findExistingTask(client, weekId, title) {
  const { data, error } = await client
    .schema('ops')
    .from('tasks')
    .select('*')
    .eq('week_id', weekId)
    .eq('title', `[DEMO] ${title}`)
    .maybeSingle();
  if (error) throw new Error(`findExistingTask("${title}") failed: ${error.message}`);
  return data;
}

async function createTask(client, { weekId, ownerUserId, taskTypeId, title, description }) {
  const existing = await findExistingTask(client, weekId, title);
  if (existing) {
    console.log(`  [skip] task "${title}" already exists this week, reusing it`);
    return existing;
  }

  const { data, error } = await client
    .schema('ops')
    .from('tasks')
    .insert({
      week_id: weekId,
      owner_user_id: ownerUserId,
      task_type_id: taskTypeId,
      title: `[DEMO] ${title}`,
      description: description ?? null,
      status: 'todo',
      created_by: ownerUserId,
    })
    .select()
    .single();
  if (error) throw new Error(`createTask("${title}") failed: ${error.message}`);
  return data;
}

// Idempotent by construction: a no-op update (`to` already the current
// status) is skipped rather than re-sent, since the state-machine
// trigger treats a same-state transition as illegal, not a no-op --
// without this guard, reusing an existing task via `createTask` above
// would throw the moment `seedWeek` tried to replay its transitions.
// Forward-only ladder. A re-run replays the same script against tasks that
// have ALREADY advanced, so an exact-match check is not enough: asking a
// `verified` task to go to `submitted` is a real backwards transition and the
// trigger rightly refuses it ("only a founder may send a verified task back to
// the GM"). Anything already at or past the target -- or parked in a terminal
// side state -- is left exactly where it is.
const LADDER = { todo: 0, in_progress: 1, submitted: 2, verified: 3, cleared: 4 };

async function transition(client, taskId, to, extra = {}) {
  const { data: current, error: readError } = await client.schema('ops').from('tasks').select('status').eq('id', taskId).single();
  if (readError) throw new Error(`transition ${taskId} -> ${to}: could not read current status: ${readError.message}`);
  if (current.status === to) return current;

  const here = LADDER[current.status];
  const there = LADDER[to];
  if (here === undefined) {
    // rejected / cancelled / pending_cancellation: already at its demo resting state.
    console.log(`  [skip] task ${taskId} is ${current.status}, leaving it there`);
    return current;
  }
  if (there !== undefined && here >= there) {
    console.log(`  [skip] task ${taskId} is already ${current.status}, past ${to}`);
    return current;
  }

  const { data, error } = await client.schema('ops').from('tasks').update({ status: to, ...extra }).eq('id', taskId).select().single();
  if (error) throw new Error(`transition ${taskId} -> ${to} failed: ${error.message}`);
  return data;
}

// Cancellation is a separate two-rung ladder, not another step on
// `LADDER` above (ops_cancellation_approval.sql): a workable status ->
// `pending_cancellation` (GM/founder flags, reason required), then
// `pending_cancellation` -> `cancelled` (clearing founder approves) or
// -> whatever status it held before (clearing founder refuses, reason
// required). `transition()` treats `pending_cancellation` as a terminal
// resting state on purpose, which is correct for a task left flagged
// and undecided but wrong for the flag-then-decide pair these two
// helpers make back to back -- reusing `transition()` for the decision
// call would silently no-op instead of deciding it. Each helper reads
// current status first so a re-run of this script is idempotent without
// replaying a decision that already happened.
async function flagCancellation(client, taskId, reason) {
  const { data: current, error } = await client.schema('ops').from('tasks').select('status').eq('id', taskId).single();
  if (error) throw new Error(`flagCancellation ${taskId}: could not read current status: ${error.message}`);
  // Skip by the database's own rule, not by a list of states that
  // happened to come up. `ops.freeze_cleared_task` refuses ANY update to
  // a cleared or cancelled task -- the record is closed and the ledger is
  // append-only -- so flagging one for cancellation is not "already done",
  // it is illegal. Enumerating only pending_cancellation/cancelled here
  // meant a re-run against a cleared task died with a fatal error partway
  // through seeding.
  const TERMINAL = new Set(['cleared', 'cancelled']);
  if (TERMINAL.has(current.status)) {
    console.log(`  [skip] task ${taskId} is ${current.status} and frozen; cannot be flagged for cancellation`);
    return current;
  }
  if (current.status === 'pending_cancellation') {
    console.log(`  [skip] task ${taskId} is already ${current.status}, leaving the cancellation flag as-is`);
    return current;
  }
  const { data, error: updateError } = await client
    .schema('ops')
    .from('tasks')
    .update({ status: 'pending_cancellation', cancellation_reason: reason })
    .eq('id', taskId)
    .select()
    .single();
  if (updateError) throw new Error(`flagCancellation ${taskId} failed: ${updateError.message}`);
  return data;
}

async function decideCancellation(client, taskId, decision, reason) {
  const { data: current, error } = await client
    .schema('ops')
    .from('tasks')
    .select('status, pre_cancellation_status')
    .eq('id', taskId)
    .single();
  if (error) throw new Error(`decideCancellation ${taskId}: could not read current status: ${error.message}`);
  if (current.status !== 'pending_cancellation') {
    console.log(`  [skip] task ${taskId} is ${current.status}, not awaiting a cancellation decision`);
    return current;
  }
  const to = decision === 'approve' ? 'cancelled' : current.pre_cancellation_status;
  const extra = decision === 'approve' ? {} : { cancellation_decision_reason: reason };
  const { data, error: updateError } = await client
    .schema('ops')
    .from('tasks')
    .update({ status: to, ...extra })
    .eq('id', taskId)
    .select()
    .single();
  if (updateError) throw new Error(`decideCancellation ${taskId} failed: ${updateError.message}`);
  return data;
}

// Each demo task in this script gets at most one block, so "a block
// already exists for this task" is enough to say the row was already
// seeded -- same re-run bug as the tasks themselves (task_blocks has no
// upsert key of its own to check against, but this task/block pairing
// is 1:1 by construction here).
async function ensureTaskBlock(client, taskId, row) {
  const { data: existing, error: readError } = await client
    .schema('ops')
    .from('task_blocks')
    .select('id')
    .eq('task_id', taskId)
    .maybeSingle();
  if (readError) throw new Error(`ensureTaskBlock(${taskId}): could not check for an existing block: ${readError.message}`);
  if (existing) {
    console.log(`  [skip] task ${taskId} already has a block, reusing it`);
    return existing;
  }

  const { data, error } = await client.schema('ops').from('task_blocks').insert(row).select().single();
  if (error) throw new Error(`ensureTaskBlock(${taskId}) failed: ${error.message}`);
  return data;
}

async function seedWeek(clients) {
  console.log('\n=== Seeding a realistic week ===');

  const { id: weekId, weekStart } = await currentWeekId();
  const uid = (key) => clients[key].auth.getUser().then((r) => r.data.user.id);
  const [founderId, gmId, salesId, brokerId] = await Promise.all([uid('founder'), uid('gm'), uid('sales'), uid('broker')]);

  const [quoteType, followUpType, fileEntryType, holdType, truckingType] = await Promise.all([
    taskTypeId('Quotation turnaround within SLA'),
    taskTypeId('Client follow-up'),
    taskTypeId('Prepare and file import entry'),
    taskTypeId('Resolve a hold or discrepancy'),
    taskTypeId('Arrange trucking for a released shipment'),
  ]);

  // In progress, uncleared -- shows in the "In progress" column.
  const t1 = await createTask(clients.sales, {
    weekId, ownerUserId: salesId, taskTypeId: quoteType,
    title: 'Quotation for XYZ Trading Corp', description: 'New inbound lead, needs pricing today.',
  });
  await transition(clients.sales, t1.id, 'in_progress');

  // Submitted -> verified, left waiting on the founder -- the "pending"
  // balance PRD §3.5 is built around.
  const t2 = await createTask(clients.sales, {
    weekId, ownerUserId: salesId, taskTypeId: followUpType,
    title: 'Follow up with ABC Logistics on renewal',
  });
  await transition(clients.sales, t2.id, 'submitted');
  await transition(clients.gm, t2.id, 'verified');

  // Full lifecycle to cleared, with a points override -- the catalog is
  // priced (placeholder Fibonacci values, see
  // 20260909180000_placeholder_points_and_admin_clearing.sql), so this
  // is a founder overriding that default for a specific task, not
  // standing in for a missing one -- exercises the ledger, the
  // clearing-founder guard, and the outbox in one go.
  const t3 = await createTask(clients.broker, {
    weekId, ownerUserId: brokerId, taskTypeId: fileEntryType,
    title: 'File import entry for shipment #DEMO-1234',
  });
  await transition(clients.broker, t3.id, 'submitted');
  await transition(clients.gm, t3.id, 'verified');
  // Only on the first run: once this task reaches `cleared` the freeze trigger
  // closes the record for good, so replaying the override on a re-run is both
  // pointless and correctly refused ("a cleared or cancelled task is frozen").
  const { data: t3now } = await clients.founder
    .schema('ops').from('tasks').select('status').eq('id', t3.id).single();
  if (t3now?.status !== 'cleared' && t3now?.status !== 'cancelled') {
    const { error: overrideError } = await clients.founder
      .schema('ops')
      .from('tasks')
      .update({
        points_override: 8,
        points_override_reason: 'This entry had an unusual documentary discrepancy that took most of a day to resolve with BOC -- bumping above the standard 5 to reflect the actual work.',
      })
      .eq('id', t3.id);
    if (overrideError) throw new Error(`points override on ${t3.id} failed: ${overrideError.message}`);
  } else {
    console.log(`  [skip] task ${t3.id} is already ${t3now.status}; override and clear left alone`);
  }
  await transition(clients.founder, t3.id, 'cleared');

  // Rejected -- shows the "Returned" ledger state.
  const t4 = await createTask(clients.sales, {
    weekId, ownerUserId: salesId, taskTypeId: quoteType,
    title: 'Quotation for a lead that went cold',
  });
  await transition(clients.sales, t4.id, 'submitted');
  await transition(clients.gm, t4.id, 'rejected', { rejected_reason: 'Client confirmed they went with another broker -- close this out.' });

  // Blocked by an external party -- the block type PRD §3.8 says matters
  // most in this trade.
  const t5 = await createTask(clients.broker, {
    weekId, ownerUserId: brokerId, taskTypeId: holdType,
    title: 'Resolve BOC alert on shipment #DEMO-5678',
  });
  await ensureTaskBlock(clients.broker, t5.id, {
    task_id: t5.id, target: 'external', blocking_external: 'Bureau of Customs',
    reason: 'Waiting on BOC to lift an alert before the shipment can be released.', created_by: brokerId,
  });

  // Blocked by a person -- exonerates the broker, names the sales rep.
  const t6 = await createTask(clients.broker, {
    weekId, ownerUserId: brokerId, taskTypeId: truckingType,
    title: 'Arrange trucking for shipment #DEMO-9012',
  });
  await ensureTaskBlock(clients.broker, t6.id, {
    task_id: t6.id, target: 'person', blocking_user_id: salesId,
    reason: 'Need the client-confirmed delivery address from sales before booking a truck.', created_by: brokerId,
  });

  // Three cancellation scenarios -- a Cebu brokerage's actual reasons
  // for flagging a task, not test narration, so a fresh purge+reseed
  // demonstrates the whole flow (board's at-risk treatment, the
  // founder's decision banner) without anyone hand-flagging a task.

  // Flagged, then the clearing founder APPROVES it -- the client
  // cancelled the booking outright, so the trucking arrangement is
  // genuinely dead work.
  const t7 = await createTask(clients.broker, {
    weekId, ownerUserId: brokerId, taskTypeId: truckingType,
    title: 'Arrange trucking for shipment #DEMO-3210',
  });
  await transition(clients.broker, t7.id, 'in_progress');
  await flagCancellation(
    clients.gm,
    t7.id,
    'Client cancelled the booking before pickup; there is no shipment left to truck.'
  );
  await decideCancellation(clients.founder, t7.id, 'approve');

  // Flagged, then the clearing founder REFUSES it -- BOC released the
  // shipment on its own overnight, which looked like the hold resolved
  // itself, but the broker still owes the client the discrepancy
  // write-up and the release paperwork isn't closed out yet.
  const t8 = await createTask(clients.broker, {
    weekId, ownerUserId: brokerId, taskTypeId: holdType,
    title: 'Resolve BOC alert on shipment #DEMO-6655',
  });
  await transition(clients.broker, t8.id, 'in_progress');
  await flagCancellation(
    clients.gm,
    t8.id,
    'BOC released the shipment on its own overnight; this looks like it resolved itself.'
  );
  await decideCancellation(
    clients.founder,
    t8.id,
    'refuse',
    'The discrepancy still needs to be written up and the release paperwork closed out -- keep this open.'
  );

  // Flagged and left undecided -- the client has said they are not
  // renewing, but the founder has not ruled on it yet. This is the
  // at-risk board treatment and the founder's decision banner, both
  // deliberately left visible rather than resolved.
  const t9 = await createTask(clients.sales, {
    weekId, ownerUserId: salesId, taskTypeId: followUpType,
    title: 'Follow up with a client on their standing arrangement',
  });
  await transition(clients.sales, t9.id, 'in_progress');
  await flagCancellation(
    clients.gm,
    t9.id,
    'Client told sales they are not renewing next quarter; confirm before we stop billing them.'
  );

  // A carry-over -- simulated directly (system client) as already having
  // rolled over once from last week, so the board's age badge has
  // something to show without actually closing the live current week.
  // Same duplicate-on-rerun bug as the six tasks above: this bypassed
  // `createTask` entirely (it inserts through `svc`, not a persona
  // client, because there's no real-world actor for a simulated carry-
  // over), so it needs its own existence check rather than inheriting
  // `createTask`'s.
  const lastMonday = new Date(new Date(weekStart).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: lastWeek } = await svc.schema('ops').from('weeks').select('id').eq('week_start', lastMonday).maybeSingle();
  const firstWeekId = lastWeek?.id ?? weekId;
  const existingCarryOver = await findExistingTask(svc, weekId, 'Weekly billing follow-up (carried over)');
  if (existingCarryOver) {
    console.log('  [skip] carry-over task already exists this week, reusing it');
  } else {
    await svc.schema('ops').from('tasks').insert({
      week_id: weekId, owner_user_id: gmId, task_type_id: followUpType,
      title: '[DEMO] Weekly billing follow-up (carried over)',
      status: 'todo', is_recurring: true, carry_over_count: 1, first_week_id: firstWeekId,
      created_by: gmId,
    });
  }

  // Recurring generation for the week, run for real through the
  // oversight-guarded RPC -- exercises Phase 5 exactly as production
  // would call it.
  const { data: gen, error: genError } = await clients.gm.schema('ops').rpc('generate_recurring_tasks', { p_week_id: weekId });
  if (genError) console.error(`  [warn] generate_recurring_tasks failed: ${genError.message}`);
  else console.log(`  generated ${gen?.[0]?.created_count ?? 0} recurring task(s) for week ${weekStart}`);

  console.log(
    `  week ${weekStart}: 9 hand-seeded tasks (in progress / pending-founder / cleared / rejected / ` +
      '2 blocked / cancelled / refused-cancellation / pending-cancellation) + 1 simulated carry-over'
  );
}

try {
  if (PURGE) await purge();
  else await seed();
  if (readOnlyColumnMissing) {
    console.warn(
      '\n[WARNING] core.users.read_only does not exist on this database yet, so the\n' +
        '          ERC and DCA accounts were created WITHOUT the read-only flag. They\n' +
        '          currently have full founder write access, which is NOT what they are\n' +
        '          for. Apply supabase/APPLY-READONLY-AND-CATALOG-POINTS.sql in the\n' +
        '          Supabase SQL editor, then re-run this script to set the flag.'
    );
  }
} catch (err) {
  console.error('\n[fatal]', err.message ?? err);
  process.exit(1);
}
