#!/usr/bin/env node
/**
 * LRA Global Ops :: the disposable week — PLAN.md §12.9
 *
 * WHY THIS EXISTS. The Monday briefing's `open`/`close`, week close, and
 * every Verify/Clear had never been driven end to end against the real
 * database, because they are irreversible: `ops.close_briefing` locks a
 * week's commitments and audit-logs it, `ops.close_week` scores and rolls
 * over, and a `cleared` task is frozen forever. So the ritual the whole
 * system exists for was the one thing nobody could test.
 *
 * WHY A CLICK IS NOT ENOUGH (PLAN.md §12.7). Three of this project's worst
 * defects had a CORRECT RESPONSE and a BROKEN SIDE EFFECT: seven endpoints
 * returning 200 with dead buttons, a `204` on a delete the UI reported as a
 * failure, and a settings audit row that silently never wrote. "The endpoint
 * test passes" is therefore the wrong evidence for these transitions — and a
 * single successful click is exactly as blind, because it also only observes
 * the response. Opening a week stamps a briefing and generates recurring
 * tasks; closing it locks commitments and writes audit; clearing a task
 * writes a ledger row, stamps three columns and enqueues a notification.
 * Any of those can half-happen behind a 200.
 *
 * So every assertion in this file reads a ROW, not a status code. The HTTP
 * calls go through the real API on :3099 with each persona's own Supabase
 * JWT (the same server and the same tokens the browser uses); the
 * assertions then read the database back with the service role and compare
 * it against what PRD.md and the migrations say should be there.
 *
 * ISOLATION — see docs/DISPOSABLE-WEEK.md for the full argument.
 *   The week lives at `week_start >= 2099-01-01`. Every downstream
 *   aggregate that windows on weeks anchors on the CURRENT Manila week and
 *   filters `week_start <= current` (scoreboard month/quarter) or
 *   `week_start < current and state = 'closed'` (the reliability window),
 *   so a 2099 week is arithmetically outside all of them. The endpoints
 *   that are NOT week-scoped (`/api/points/ledger`, `/api/points/me` with
 *   no weekId, `/api/points/queue`, `/api/points/digest`, and the
 *   briefing's own open-blocks list) would see it, which is why the run
 *   ends in a full teardown and then PROVES the isolation empirically:
 *   scoreboard payloads are compared before/during/after, and the whole
 *   downstream surface is compared before/after teardown.
 *
 * CHEAP ENOUGH TO RUN TWICE. `run` tears down any leftover disposable week
 * before it starts and again when it finishes (even on failure), so the
 * second run costs exactly what the first did. Nothing outside
 * `week_start >= 2099-01-01` is ever written or deleted.
 *
 * THE ONE IRREVERSIBLE RESIDUE. `core.audit_logs` refuses DELETE to every
 * role including the service role, by design ("the audit trail outlives
 * even the data it describes"). `ops.close_briefing` writes one audit row
 * per run, and that row survives teardown pointing at a week id that no
 * longer exists. That is intended behaviour, not a leak, and it is one row
 * per run — but it does mean `/admin/audit` accumulates a
 * `ops.briefing.closed` row for a 2099 week each time this is run.
 *
 * USAGE (all commands run themselves; nothing here needs a password):
 *   node scripts/disposable-week.mjs run           seed, drive, assert, tear down
 *   node scripts/disposable-week.mjs run --keep    ... but leave the week in place
 *   node scripts/disposable-week.mjs teardown      remove every disposable week
 *   node scripts/disposable-week.mjs inspect       print current disposable + real state
 *   node scripts/disposable-week.mjs prove-red     the negative control (see below)
 *   node scripts/disposable-week.mjs simulate <n>       n>=4 consecutive disposable
 *                                                        weeks, driven end to end,
 *                                                        asserting what only emerges
 *                                                        ACROSS weeks (see `simulate`
 *                                                        below and docs/DISPOSABLE-WEEK.md)
 *   node scripts/disposable-week.mjs simulate-red <n>   simulate's own negative control
 *
 * PROVING THE HARNESS CAN GO RED. A green suite that cannot fail is worse
 * than no suite. `prove-red` creates the week and the tasks and then SKIPS
 * every transition — no generation, no briefing open/close, no
 * submit/verify/clear, no week close — while running the identical
 * assertion battery. Every side-effect assertion must then fail. It exits 0
 * only if each of the four side-effect groups (recurring, briefing,
 * lifecycle, close) actually reported at least one failure.
 */

import { createClient } from '@supabase/supabase-js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// `simulate` needs the ACTUAL reliability formula, not a restatement of
// it — this is the same built artifact apps/api/src/routes/scoreboard.ts
// imports (`packages/ops-scoring/dist`), reached here via the npm
// workspace symlink at the repo root. A wrong number here is a wrong
// number in production, not a harness bug.
import { reliability } from '@lra/ops-scoring';

// ---------------------------------------------------------------------
// Environment. Same convention as scripts/seed-demo.mjs: read
// apps/api/.env for the Supabase keys so this stays one command. The
// demo passwords come from apps/web/.env's VITE_DEMO_LOGINS, which is
// where the login screen's quick-switch buttons already get them.
// ---------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const { config } = await import('dotenv');
for (const rel of ['apps/api/.env', 'apps/web/.env']) {
  const p = path.join(ROOT, rel);
  if (existsSync(p)) config({ path: p });
}

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
const API = process.env.OPS_API_URL ?? process.env.VITE_API_URL ?? 'http://localhost:3099';

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error('[fatal] SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be set (apps/api/.env).');
  process.exit(1);
}

/** Anything on or after this date is a disposable week. Never a real one. */
const DISPOSABLE_EPOCH = '2099-01-01';
/** The Monday this run uses. 2099-01-05 is a Monday; asserted below, not assumed. */
const WEEK_START = process.env.DISPOSABLE_WEEK_START ?? '2099-01-05';

const MODE = process.argv[2] ?? 'run';
const KEEP = process.argv.includes('--keep');
const VERBOSE = process.argv.includes('--verbose');

/**
 * A transport failure is not a test result. Observed three times in one
 * session: the Supabase host briefly stopped resolving (`ENOTFOUND`),
 * which aborted an otherwise-green run mid-teardown. Retried at the
 * TRANSPORT layer only — a thrown fetch, never an HTTP status — so this
 * can never paper over a 4xx/5xx the product is responsible for. Every
 * retry prints, so it is never invisible.
 */
const TRANSPORT_ATTEMPTS = 5;

async function fetchWithRetry(input, init) {
  let lastErr;
  for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      const code = err?.cause?.code ?? err?.message;
      console.log(`  [retry ${attempt}/${TRANSPORT_ATTEMPTS}] transport failure talking to ${new URL(String(input)).host}: ${code}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
}

const svc = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
  global: { fetch: fetchWithRetry },
});
const ops = () => svc.schema('ops');
const core = () => svc.schema('core');

// ---------------------------------------------------------------------
// The assertion engine. Every check names a GROUP so `prove-red` can
// require that each group is capable of failing, and every failure
// carries the actual and expected values — a failure whose message does
// not show the row is a failure you cannot act on.
// ---------------------------------------------------------------------
const GROUPS = {
  week: 'week creation',
  recurring: 'recurring generation',
  commit: 'commitments',
  briefing: 'briefing open/close',
  lifecycle: 'submit / verify / clear',
  close: 'week close + rollover',
  isolation: 'isolation + teardown',
  carryover: 'cross-week: carry-over age',
  reliabilityX: 'cross-week: reliability / hit-rate',
  scoreboardAccum: 'cross-week: scoreboard accumulation',
  blocked: 'cross-week: blocked-time exoneration',
  heatmap: 'cross-week: per-day activity (heatmap data)',
};
const checks = [];

function record(group, name, ok, detail) {
  checks.push({ group, name, ok, detail });
  const tag = ok ? '  ok  ' : '  FAIL';
  console.log(`${tag} [${group}] ${name}${ok ? '' : `\n         ${detail}`}`);
  if (ok && VERBOSE && detail) console.log(`         ${detail}`);
}

/**
 * A third state, and it earns its keep here. Two other Claude sessions
 * are working this repo against the SAME live Supabase project, so a
 * before/after byte-comparison of a whole payload can move for reasons
 * that have nothing to do with the disposable week. Reporting that as a
 * pass would be a lie and reporting it as a fail would be a different
 * lie. `inconclusive` says what actually happened and names the
 * alternative explanation, and every causal assertion below stays
 * unconditional so the run is never left with nothing.
 */
/**
 * A defect this harness found, confirmed, and reported to the lane that
 * owns the file — so it is expected to be red until that lands. It does
 * not fail the run (a permanently-red suite is a suite nobody runs), but
 * if it ever PASSES that is real news and becomes a hard failure telling
 * whoever is reading to delete the exemption.
 */
function knownDefect(group, name, passes, ref, detail = '') {
  if (passes) {
    record(group, name, false, `THIS KNOWN DEFECT APPEARS FIXED (${ref}) — remove the knownDefect() exemption in scripts/disposable-week.mjs.`);
    return;
  }
  checks.push({ group, name, ok: true, known: true, detail: ref });
  console.log(`  xfail[${group}] ${name}\n         KNOWN DEFECT, still open — ${ref}${detail ? `\n         ${detail}` : ''}`);
}

function inconclusive(group, name, detail) {
  checks.push({ group, name, ok: true, inconclusive: true, detail });
  console.log(`  ??   [${group}] ${name}\n         INCONCLUSIVE — ${detail}`);
}

function ok(group, name, detail = '') {
  record(group, name, true, detail);
}

/**
 * Every differing path between two JSON-comparable values, as
 * `path: expected -> actual`. A whole-payload dump of a scoreboard is a
 * failure nobody can read, and an unreadable failure is one nobody acts
 * on — the same complaint §12.7 makes about `console.error`.
 */
function diffPaths(expected, actual, prefix = '', out = []) {
  if (out.length >= 12) return out;
  const bothObjects =
    expected && actual && typeof expected === 'object' && typeof actual === 'object' && Array.isArray(expected) === Array.isArray(actual);
  if (!bothObjects) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      out.push(`${prefix || '<root>'}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`);
    }
    return out;
  }
  if (Array.isArray(expected) && expected.length !== actual.length) {
    out.push(`${prefix || '<root>'}.length: ${expected.length} -> ${actual.length}`);
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    diffPaths(expected[key], actual[key], prefix ? `${prefix}.${key}` : key, out);
    if (out.length >= 12) break;
  }
  return out;
}

/** Deep-ish equality on JSON-comparable values. */
function eq(group, name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const detail =
    a.length + e.length > 300
      ? `differing paths (expected -> actual):\n         ${diffPaths(expected, actual).join('\n         ') || '(none — structural difference only)'}`
      : `expected ${e}\n         actual   ${a}`;
  record(group, name, a === e, detail);
}

function truthy(group, name, value, detail = '') {
  record(group, name, Boolean(value), detail || `expected a value, got ${JSON.stringify(value)}`);
}

function falsy(group, name, value, detail = '') {
  record(group, name, !value, detail || `expected null/false, got ${JSON.stringify(value)}`);
}

/** Runs `fn` and asserts it was refused with the given Postgres error code / message fragment. */
async function refused(group, name, fn, fragment) {
  try {
    await fn();
    record(group, name, false, `expected a refusal containing "${fragment}", but the call succeeded`);
  } catch (err) {
    const msg = String(err?.message ?? err);
    record(group, name, msg.toLowerCase().includes(fragment.toLowerCase()), `expected a refusal containing "${fragment}"\n         actual   ${msg}`);
  }
}

// ---------------------------------------------------------------------
// HTTP against the real API, with each persona's real JWT.
// ---------------------------------------------------------------------
const tokens = new Map();

function demoLogins() {
  const raw = process.env.VITE_DEMO_LOGINS;
  if (!raw) {
    console.error(
      '[fatal] VITE_DEMO_LOGINS is not set in apps/web/.env. The harness signs in as the demo\n' +
        '        personas to drive the real API; without their passwords it cannot run.\n' +
        '        `node scripts/seed-demo.mjs --rotate-passwords` prints fresh ones.'
    );
    process.exit(1);
  }
  return JSON.parse(raw);
}

async function signIn(key) {
  if (tokens.has(key)) return tokens.get(key);
  const logins = demoLogins();
  const email = `${key}-demo@ops-demo.invalid`;
  const password = logins[email];
  if (!password) {
    console.error(`[fatal] no password for ${email} in VITE_DEMO_LOGINS.`);
    process.exit(1);
  }
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false }, global: { fetch: fetchWithRetry } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) {
    console.error(`[fatal] could not sign in ${email}: ${error.message}`);
    process.exit(1);
  }
  const session = { token: data.session.access_token, userId: data.user.id };
  tokens.set(key, session);
  return session;
}

/** One API call as `key`. Throws on a non-2xx with the server's own message. */
async function call(key, method, urlPath, body) {
  const { token } = await signIn(key);
  const headers = { authorization: `Bearer ${token}` };
  // The exact rule lib/request-headers.ts enforces on the web client: no
  // Content-Type on a bodyless POST, or Fastify refuses it with
  // FST_ERR_CTP_EMPTY_JSON_BODY before the handler runs (PLAN.md §11.1).
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetchWithRetry(`${API}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${urlPath} -> ${res.status} ${json?.error?.message ?? json?.message ?? text}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json?.data ?? json;
}

// ---------------------------------------------------------------------
// Teardown. Deletes ONLY rows belonging to a week at or after
// DISPOSABLE_EPOCH. Order matters: ops.tasks.week_id has no cascade, and
// ops.point_ledger / ops.task_notes both refuse DELETE unless the caller
// is core.is_system_caller() — which the service role is.
// ---------------------------------------------------------------------
/**
 * PostgREST hands back a plain object, not an Error, so throwing it raw
 * prints `[object Object]` and tells you nothing. Reproduced live: a
 * transient schema-cache reload (another session applying a migration to
 * the shared project) surfaced as exactly that.
 */
function pgError(where, error) {
  return new Error(`${where}: ${error.code ?? '?'} ${error.message ?? JSON.stringify(error)}${error.hint ? ` (hint: ${error.hint})` : ''}`);
}

async function disposableWeekIds() {
  const { data, error } = await ops().from('weeks').select('id, week_start').gte('week_start', DISPOSABLE_EPOCH);
  if (error) throw pgError('reading ops.weeks', error);
  return data ?? [];
}

async function teardown({ quiet = false } = {}) {
  const weeks = await disposableWeekIds();
  if (!weeks.length) {
    if (!quiet) console.log('  teardown: nothing to remove.');
    return { weeks: 0, tasks: 0 };
  }
  const weekIds = weeks.map((w) => w.id);

  const { data: taskRows, error: tErr } = await ops().from('tasks').select('id').in('week_id', weekIds);
  if (tErr) throw pgError('reading the disposable week\'s tasks', tErr);
  const taskIds = (taskRows ?? []).map((t) => t.id);

  if (taskIds.length) {
    // Blocks, notes and edit requests reference tasks; ledger cascades
    // from the task but its own DELETE trigger still fires per row.
    for (const [schema, table, col] of [
      ['ops', 'task_blocks', 'task_id'],
      ['ops', 'task_notes', 'task_id'],
      ['ops', 'task_edit_requests', 'task_id'],
      ['ops', 'point_ledger', 'task_id'],
    ]) {
      const { error } = await svc.schema(schema).from(table).delete().in(col, taskIds);
      // A table that does not exist on this deployment is not an error
      // worth aborting a teardown for; a real refusal is.
      if (error && !/does not exist|Could not find the table/i.test(error.message ?? '')) throw pgError(`deleting ${schema}.${table}`, error);
    }
    const { error: delTasks } = await ops().from('tasks').delete().in('id', taskIds);
    if (delTasks) throw pgError('deleting ops.tasks', delTasks);
  }

  // Outbox rows enqueued for the disposable tasks. Matched by entity_id
  // so nothing real is ever in range.
  if (taskIds.length) {
    const { error } = await core().from('notification_outbox').delete().in('entity_id', taskIds);
    if (error) throw error;
    const { error: nErr } = await core().from('notifications').delete().in('entity_id', taskIds);
    if (nErr && !/does not exist|Could not find/i.test(nErr.message)) throw nErr;
  }

  const { error: delWeeks } = await ops().from('weeks').delete().in('id', weekIds);
  if (delWeeks) throw pgError('deleting ops.weeks', delWeeks);

  if (!quiet) {
    console.log(`  teardown: removed ${weeks.length} disposable week(s) (${weeks.map((w) => w.week_start).join(', ')}) and ${taskIds.length} task(s).`);
  }
  return { weeks: weeks.length, tasks: taskIds.length };
}

// ---------------------------------------------------------------------
// The downstream surface. Snapshotted before, during and after so
// isolation is proven against real payloads instead of asserted from
// reading the query builders.
// ---------------------------------------------------------------------
async function downstreamSnapshot() {
  const snap = {};
  // One call: /api/scoreboard returns all four period windows in every
  // response, so fetching it per period would only compare it to itself.
  snap['scoreboard'] = await call('founder', 'GET', '/api/scoreboard');
  snap['points/me:founder'] = await call('founder', 'GET', '/api/points/me');
  snap['points/me:sales'] = await call('sales', 'GET', '/api/points/me');
  snap['points/me:broker'] = await call('broker', 'GET', '/api/points/me');
  snap['ledger'] = await call('founder', 'GET', '/api/points/ledger');
  snap['queue:gm'] = await call('gm', 'GET', '/api/points/queue');
  snap['queue:founder'] = await call('founder', 'GET', '/api/points/queue');
  snap['digest'] = await call('founder', 'GET', '/api/points/digest');
  snap['now:sales'] = await call('sales', 'GET', '/api/now');
  return snap;
}

/**
 * The scoreboard, reduced to everything that IS anchored on the current
 * Manila week. `periods.all` is dropped because scoreboard.ts states
 * plainly that it is not re-anchored on purpose.
 */
function anchoredScoreboard(sb) {
  if (!sb) return sb;
  return {
    weekId: sb.weekId,
    weekStart: sb.weekStart,
    visibility: sb.visibility,
    rows: (sb.rows ?? []).map((r) => ({
      userId: r.userId,
      currentWeek: r.currentWeek,
      lastClosedWeek: r.lastClosedWeek,
      reliability: r.reliability,
      // `cycleTime` is deliberately NOT here. scoreboard.ts computes it
      // over "every task this person has ever cleared... not scoped to
      // the reliability window", so a cleared disposable task moves it
      // by design. Asserting it unchanged would be asserting against the
      // documented behaviour. It is covered by the after-teardown
      // whole-payload comparison instead.
      week: r.periods?.week,
      month: r.periods?.month,
      quarter: r.periods?.quarter,
    })),
  };
}

/** Every snapshot goes through this before any comparison. */
function comparable(value) {
  return stripVolatile(value);
}

function allTimeScoreboard(sb) {
  return (sb?.rows ?? []).map((r) => ({ userId: r.userId, all: r.periods?.all }));
}

/**
 * A fingerprint of everything OUTSIDE the disposable range. If this moves
 * between two snapshots, something other than this harness wrote to the
 * shared project and a byte-comparison of payloads cannot be trusted
 * either way.
 */
async function fingerprintNonDisposable() {
  const disposable = (await disposableWeekIds()).map((w) => w.id);
  const { count: weeks } = await ops().from('weeks').select('*', { count: 'exact', head: true }).lt('week_start', DISPOSABLE_EPOCH);
  let tasksQ = ops().from('tasks').select('*', { count: 'exact', head: true });
  let ledgerQ = ops().from('point_ledger').select('*', { count: 'exact', head: true });
  let blocksQ = ops().from('task_blocks').select('*', { count: 'exact', head: true });
  if (disposable.length) {
    tasksQ = tasksQ.not('week_id', 'in', `(${disposable.join(',')})`);
    ledgerQ = ledgerQ.not('week_id', 'in', `(${disposable.join(',')})`);
  }
  const { count: tasks } = await tasksQ;
  const { count: ledger } = await ledgerQ;
  const { count: blocks } = await blocksQ;
  const { count: settingsUpdated } = await ops().from('settings').select('*', { count: 'exact', head: true });
  return { weeks, tasks, ledger, blocks, settingsUpdated };
}

/**
 * Compare two payload snapshots, but only claim a verdict if the shared
 * project held still. `causal` assertions elsewhere do not need this
 * escape hatch; whole-payload equality does.
 */
function compareOrExcuse(group, name, actual, expected, fpBefore, fpAfter) {
  const moved = JSON.stringify(fpBefore) !== JSON.stringify(fpAfter);
  if (!moved) {
    eq(group, name, actual, expected);
    return;
  }
  const differs = JSON.stringify(actual) !== JSON.stringify(expected);
  if (!differs) {
    ok(group, name, 'identical despite concurrent writes elsewhere in the project');
    return;
  }
  inconclusive(
    group,
    name,
    `another session wrote to the shared project during this run, so a payload diff proves nothing.\n` +
      `         non-disposable fingerprint ${JSON.stringify(fpBefore)} -> ${JSON.stringify(fpAfter)}\n` +
      `         differing paths: ${diffPaths(expected, actual).join('; ')}`
  );
}

/**
 * Keys whose value is derived from `now()` against an UNRESOLVED row, so
 * they tick upward on their own while the harness is running and would
 * make a byte-comparison flake. Reproduced (not guessed): a run that
 * took six minutes reported `hoursBlockedByThem: 25.7 -> 25.8` for a
 * block that has been open since long before this harness existed.
 *
 * Stripping them loses a little coverage, so the loss is paid back
 * directly: `no task_block references a disposable task` is asserted
 * causally below, which is the only way this harness could have moved
 * any of these numbers in the first place.
 */
const VOLATILE_KEYS = new Set([
  'hoursBlockedByThem', // scoreboard: open blocks measured to `now`
  'hoursTheyWereBlocked',
  'hoursOpen', // briefing / digest: age of an open block
  'ageHours', // digest: age of an open task
  'blockedHours',
  'hours', // briefing: hours-by-blocker
  'time', // /health-style timestamps, if ever snapshotted
]);

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

function diffKeys(a, b) {
  const out = [];
  for (const k of Object.keys(a)) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  return out;
}

// ---------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------
async function inspect() {
  const { data: weeks } = await ops()
    .from('weeks')
    .select('id, week_start, week_end, state, briefing_opened_at, briefing_closed_at, closed_at, rolled_over_at')
    .order('week_start');
  console.log('ops.weeks:');
  for (const w of weeks ?? []) {
    const disposable = w.week_start >= DISPOSABLE_EPOCH ? '  <-- DISPOSABLE' : '';
    console.log(`  ${w.week_start} .. ${w.week_end}  ${w.state.padEnd(8)} briefing=${w.briefing_opened_at ? 'opened' : '-'}/${w.briefing_closed_at ? 'closed' : '-'} closed=${w.closed_at ? 'y' : '-'} rolled=${w.rolled_over_at ? 'y' : '-'}${disposable}`);
  }

  const { data: templates } = await ops().from('recurring_templates').select('id, position, title, task_type_id, is_active');
  console.log(`\nops.recurring_templates (${templates?.length ?? 0}):`);
  for (const t of templates ?? []) console.log(`  ${t.is_active ? 'active  ' : 'inactive'} ${t.position.padEnd(8)} ${t.title}`);

  const { data: members } = await core().from('memberships').select('user_id, position, module, is_active');
  const { data: users } = await core().from('users').select('id, email, authority, is_active, read_only');
  const byId = new Map((users ?? []).map((u) => [u.id, u]));
  console.log(`\ncore.memberships (ops, active):`);
  for (const m of (members ?? []).filter((m) => m.module === 'ops' && m.is_active)) {
    const u = byId.get(m.user_id);
    console.log(`  ${m.position.padEnd(8)} ${u?.email ?? m.user_id} authority=${u?.authority} active=${u?.is_active} read_only=${u?.read_only}`);
  }

  const counts = {};
  for (const [schema, table] of [
    ['ops', 'weeks'], ['ops', 'tasks'], ['ops', 'point_ledger'], ['ops', 'task_notes'],
    ['ops', 'task_blocks'], ['core', 'audit_logs'], ['core', 'notification_outbox'],
  ]) {
    const { count } = await svc.schema(schema).from(table).select('*', { count: 'exact', head: true });
    counts[`${schema}.${table}`] = count;
  }
  console.log('\nrow counts:', counts);
}

// ---------------------------------------------------------------------
// The run itself.
// ---------------------------------------------------------------------
async function run({ red = false } = {}) {
  // In the negative control every transition is SKIPPED, but no
  // expectation is softened: `act` gates the calls, never the expected
  // values. An earlier version threaded `act` into the expectations too,
  // and the control came back green — an assertion that adapts to the
  // mode cannot fail, which is the exact opposite of the point.
  const act = !red;

  console.log(`=== disposable week ${WEEK_START} ${red ? '(RED CONTROL — transitions skipped on purpose)' : ''} ===`);
  console.log(`API ${API}\n`);

  // A date typo would silently create a week on the wrong day; ops.weeks
  // has a check for isodow = 1 but a clear message here beats a 23514.
  const dow = new Date(`${WEEK_START}T00:00:00Z`).getUTCDay();
  if (dow !== 1) {
    console.error(`[fatal] ${WEEK_START} is not a Monday (getUTCDay=${dow}). ops.weeks requires isodow = 1.`);
    process.exit(1);
  }
  if (WEEK_START < DISPOSABLE_EPOCH) {
    console.error(`[fatal] ${WEEK_START} is before the disposable epoch ${DISPOSABLE_EPOCH}. Refusing to touch a week that could be real.`);
    process.exit(1);
  }

  console.log('--- pre-run teardown (so the second run costs what the first did) ---');
  await teardown();

  console.log('\n--- baseline snapshot of every downstream read ---');
  const baseline = await downstreamSnapshot();
  const fpBaseline = await fingerprintNonDisposable();
  const { count: auditBefore } = await core().from('audit_logs').select('*', { count: 'exact', head: true });
  const { count: ledgerBefore } = await ops().from('point_ledger').select('*', { count: 'exact', head: true });
  console.log(`  audit_logs=${auditBefore} point_ledger=${ledgerBefore}`);
  console.log(`  non-disposable fingerprint ${JSON.stringify(fpBaseline)}`);

  try {
    // -----------------------------------------------------------------
    // 1. Create the week.
    // -----------------------------------------------------------------
    console.log('\n--- 1. create the week ---');
    const week = await call('founder', 'POST', '/api/weeks', { weekStart: WEEK_START });
    const weekId = week.id;
    const { data: weekRow } = await ops().from('weeks').select('*').eq('id', weekId).single();
    eq(GROUPS.week, 'week_start is the requested Monday', weekRow.week_start, WEEK_START);
    eq(GROUPS.week, 'week_end is week_start + 6 (generated column)', weekRow.week_end, isoPlus(WEEK_START, 6));
    eq(GROUPS.week, 'a new week starts in planning', weekRow.state, 'planning');
    falsy(GROUPS.week, 'briefing_opened_at is null on a fresh week', weekRow.briefing_opened_at);
    falsy(GROUPS.week, 'briefing_closed_at is null on a fresh week', weekRow.briefing_closed_at);
    falsy(GROUPS.week, 'closed_at is null on a fresh week', weekRow.closed_at);
    falsy(GROUPS.week, 'rolled_over_at is null on a fresh week', weekRow.rolled_over_at);

    // Idempotency of creation: the same weekStart returns the same row,
    // never a second week (the unique constraint does the real work).
    const weekAgain = await call('founder', 'POST', '/api/weeks', { weekStart: WEEK_START });
    eq(GROUPS.week, 'creating the same week twice returns the same row', weekAgain.id, weekId);
    const { count: weekCount } = await ops().from('weeks').select('*', { count: 'exact', head: true }).eq('week_start', WEEK_START);
    eq(GROUPS.week, 'still exactly one row for that week_start', weekCount, 1);

    // -----------------------------------------------------------------
    // 2. Recurring generation — the expected set, computed from the same
    //    inputs the SQL function joins on, then compared row by row.
    // -----------------------------------------------------------------
    console.log('\n--- 2. recurring generation ---');
    const expectedPairs = await expectedRecurringPairs();
    let created = null;
    if (act) {
      created = await call('gm', 'POST', `/api/weeks/${weekId}/generate-recurring`);
    }
    const genCount = Array.isArray(created) ? (created[0]?.created_count ?? null) : (created?.created_count ?? null);
    eq(GROUPS.recurring, 'generate-recurring reports the number of rows it actually inserted', genCount, expectedPairs.length);

    const { data: recurringTasks } = await ops()
      .from('tasks')
      .select('id, owner_user_id, recurring_template_id, task_type_id, title, description, status, is_recurring, catalog_points, created_by, first_week_id, carry_over_count, is_committed')
      .eq('week_id', weekId)
      .eq('is_recurring', true);
    const actualPairs = (recurringTasks ?? [])
      .map((t) => `${t.owner_user_id}|${t.recurring_template_id}`)
      .sort();
    eq(GROUPS.recurring, 'exactly one task per (active template x active member holding that position)', actualPairs, expectedPairs.map((p) => p.key).sort());
    // A set difference in uuids is unreadable. Name the people, because
    // "who did not get their recurring work" is the actual question.
    const missing = expectedPairs.filter((p) => !actualPairs.includes(p.key));
    const extra = actualPairs.filter((k) => !expectedPairs.some((p) => p.key === k));
    if (missing.length || extra.length) {
      console.log(`         MISSING: ${missing.map((p) => `${p.email} / "${p.title}" (read_only=${p.readOnly})`).join('; ') || 'none'}`);
      console.log(`         UNEXPECTED: ${extra.join('; ') || 'none'}`);
    }

    const gmSession = await signIn('gm');
    for (const t of recurringTasks ?? []) {
      const exp = expectedPairs.find((p) => p.key === `${t.owner_user_id}|${t.recurring_template_id}`);
      if (!exp) continue;
      const label = `${exp.email} / "${exp.title}"`;
      eq(GROUPS.recurring, `title copied from the template — ${label}`, t.title, exp.title);
      eq(GROUPS.recurring, `description copied from the template — ${label}`, t.description, exp.description);
      eq(GROUPS.recurring, `task_type_id copied from the template — ${label}`, t.task_type_id, exp.taskTypeId);
      eq(GROUPS.recurring, `status is todo — ${label}`, t.status, 'todo');
      eq(GROUPS.recurring, `catalog_points snapshotted from the task type — ${label}`, t.catalog_points, exp.defaultPoints);
      eq(GROUPS.recurring, `created_by is the CALLER, not the owner (20260909140000) — ${label}`, t.created_by, gmSession.userId);
      eq(GROUPS.recurring, `first_week_id stamped to this week — ${label}`, t.first_week_id, weekId);
      eq(GROUPS.recurring, `carry_over_count starts at 0 — ${label}`, t.carry_over_count, 0);
      eq(GROUPS.recurring, `generation never pre-commits a task — ${label}`, t.is_committed, false);
    }

    // Generation writes no ledger row: nothing has transitioned yet.
    const { count: genLedger } = await ops().from('point_ledger').select('*', { count: 'exact', head: true }).eq('week_id', weekId);
    eq(GROUPS.recurring, 'generation writes no ledger rows', genLedger, 0);

    // IDEMPOTENCY, two ways. First the retried call...
    if (act) {
      const retry = await call('gm', 'POST', `/api/weeks/${weekId}/generate-recurring`);
      const retryCount = Array.isArray(retry) ? (retry[0]?.created_count ?? null) : (retry?.created_count ?? null);
      eq(GROUPS.recurring, 'a retried generation creates nothing', retryCount, 0);
      const { data: afterRetry } = await ops().from('tasks').select('id').eq('week_id', weekId).eq('is_recurring', true);
      eq(GROUPS.recurring, 'and the task ids are unchanged after the retry', (afterRetry ?? []).map((t) => t.id).sort(), (recurringTasks ?? []).map((t) => t.id).sort());

      // ...then the index itself, because ON CONFLICT DO NOTHING is only
      // as good as the index it names. A duplicate insert on the service
      // path (no ON CONFLICT clause) must raise 23505.
      const victim = (recurringTasks ?? [])[0];
      if (victim) {
        await refused(
          GROUPS.recurring,
          'uq_ops_tasks_recurring genuinely refuses a duplicate (owner, week, template)',
          async () => {
            const { error } = await ops().from('tasks').insert({
              week_id: weekId,
              owner_user_id: victim.owner_user_id,
              task_type_id: victim.task_type_id,
              title: victim.title,
              status: 'todo',
              is_recurring: true,
              recurring_template_id: victim.recurring_template_id,
              created_by: victim.owner_user_id,
            });
            if (error) throw new Error(`${error.code} ${error.message}`);
          },
          'duplicate key'
        );
      } else {
        ok(GROUPS.recurring, 'no recurring template exists, so there is no duplicate to test', 'SKIPPED — see report');
      }
    }

    // -----------------------------------------------------------------
    // 3. Ad-hoc tasks + commitments.
    // -----------------------------------------------------------------
    console.log('\n--- 3. commit tasks to the week ---');
    const pricedType = await pickPricedTaskType();
    const salesSession = await signIn('sales');
    const brokerSession = await signIn('broker');

    const salesTask = await call('sales', 'POST', '/api/tasks', {
      weekId,
      title: '[disposable] sales week target',
      description: 'Created by scripts/disposable-week.mjs. Safe to delete.',
      taskTypeId: pricedType?.id,
    });
    const brokerTask = await call('broker', 'POST', '/api/tasks', {
      weekId,
      title: '[disposable] broker week target',
      taskTypeId: pricedType?.id,
    });

    const { data: salesRow0 } = await ops().from('tasks').select('*').eq('id', salesTask.id).single();
    eq(GROUPS.commit, 'a new task is owned by its creator', salesRow0.owner_user_id, salesSession.userId);
    eq(GROUPS.commit, 'catalog_points is snapshotted at creation, not read live', salesRow0.catalog_points, pricedType?.default_points ?? null);
    eq(GROUPS.commit, 'first_week_id is stamped at creation', salesRow0.first_week_id, weekId);
    eq(GROUPS.commit, 'a new task is not committed', salesRow0.is_committed, false);

    if (act) {
      await call('sales', 'POST', `/api/tasks/${salesTask.id}/commit`);
      await call('broker', 'POST', `/api/tasks/${brokerTask.id}/commit`);
    }
    const { data: salesRow1 } = await ops().from('tasks').select('*').eq('id', salesTask.id).single();
    eq(GROUPS.commit, 'commit sets is_committed', salesRow1.is_committed, act);
    eq(GROUPS.commit, 'commit derives committed_week_id from the task, not the client', salesRow1.committed_week_id, weekId);
    eq(GROUPS.commit, 'commit derives committed_points from the catalog snapshot', salesRow1.committed_points, (pricedType?.default_points ?? null));
    eq(GROUPS.commit, 'commit does not move the status', salesRow1.status, 'todo');
    const { count: commitLedger } = await ops().from('point_ledger').select('*', { count: 'exact', head: true }).eq('task_id', salesTask.id);
    eq(GROUPS.commit, 'a commitment writes NO ledger row (it is not a point-bearing transition)', commitLedger, 0);

    // The briefing endpoint the screen actually reads must bucket it.
    const briefing = await call('founder', 'GET', `/api/briefing/${weekId}`);
    const committedIds = Object.values(briefing.committed ?? {}).flat().map((t) => t.id);
    const candidateIds = Object.values(briefing.commitCandidates ?? {}).flat().map((t) => t.id);
    record(
      GROUPS.commit,
      'GET /api/briefing/:weekId puts a committed task in `committed`, not `commitCandidates`',
      committedIds.includes(salesTask.id) && !candidateIds.includes(salesTask.id),
      `committed=${JSON.stringify(committedIds)}\n         candidates=${JSON.stringify(candidateIds)}`
    );
    eq(GROUPS.commit, 'a week with no predecessor reports an empty scorecard rather than inventing one', briefing.previousWeek, null);

    // -----------------------------------------------------------------
    // 4. open_briefing — a screen stamp and NOTHING else.
    // -----------------------------------------------------------------
    console.log('\n--- 4. open the briefing ---');
    if (act) await call('founder', 'POST', `/api/weeks/${weekId}/briefing/open`);
    const { data: afterOpen } = await ops().from('weeks').select('*').eq('id', weekId).single();
    truthy(GROUPS.briefing, 'open stamps briefing_opened_at', afterOpen.briefing_opened_at);
    eq(GROUPS.briefing, 'open leaves the week in planning (PRD §3.1 — the week opens when the briefing CLOSES)', afterOpen.state, 'planning');
    falsy(GROUPS.briefing, 'open does not stamp briefing_closed_at', afterOpen.briefing_closed_at);
    falsy(GROUPS.briefing, 'open does not stamp briefing_closed_by', afterOpen.briefing_closed_by);
    const { count: auditAfterOpen } = await core().from('audit_logs').select('*', { count: 'exact', head: true }).eq('entity_id', weekId);
    eq(GROUPS.briefing, 'open writes no audit row (it is not the privileged act)', auditAfterOpen, 0);

    if (act) {
      // Idempotency: a retried open must not move the timestamp, or the
      // "when did the meeting start" record drifts on every stray click.
      await call('founder', 'POST', `/api/weeks/${weekId}/briefing/open`);
      const { data: afterOpen2 } = await ops().from('weeks').select('briefing_opened_at').eq('id', weekId).single();
      eq(GROUPS.briefing, 'a retried open does not move briefing_opened_at', afterOpen2.briefing_opened_at, afterOpen.briefing_opened_at);
    }

    // A commitment must still be possible while the week is in planning.
    if (act) {
      await call('broker', 'DELETE', `/api/tasks/${brokerTask.id}/commit`);
      await call('broker', 'POST', `/api/tasks/${brokerTask.id}/commit`);
      const { data: brokerRow } = await ops().from('tasks').select('is_committed').eq('id', brokerTask.id).single();
      eq(GROUPS.briefing, 'commitments still change while the briefing is open but the week is planning', brokerRow.is_committed, true);
    }

    // -----------------------------------------------------------------
    // 5. close_briefing — the lock moment. State, stamps, ONE audit row,
    //    and the lock actually engaged.
    // -----------------------------------------------------------------
    console.log('\n--- 5. close the briefing (the lock moment) ---');
    const founderSession = await signIn('founder');
    if (act) await call('founder', 'POST', `/api/weeks/${weekId}/briefing/close`);
    const { data: afterClose } = await ops().from('weeks').select('*').eq('id', weekId).single();
    eq(GROUPS.briefing, 'close moves the week planning -> open', afterClose.state, 'open');
    truthy(GROUPS.briefing, 'close stamps briefing_closed_at', afterClose.briefing_closed_at);
    eq(GROUPS.briefing, 'close stamps briefing_closed_by with the acting founder', afterClose.briefing_closed_by, founderSession.userId);
    eq(GROUPS.briefing, 'close preserves the original briefing_opened_at rather than overwriting it', afterClose.briefing_opened_at, afterOpen.briefing_opened_at);

    const { data: auditRows } = await core()
      .from('audit_logs')
      .select('*')
      .eq('entity_id', weekId)
      .order('created_at', { ascending: true });
    eq(GROUPS.briefing, 'close writes EXACTLY ONE audit row (§12.7: the settings audit row silently never wrote)', (auditRows ?? []).length, 1);
    const audit = (auditRows ?? [])[0];
    if (audit) {
      eq(GROUPS.briefing, 'audit action is ops.briefing.closed', audit.action, 'ops.briefing.closed');
      eq(GROUPS.briefing, 'audit entity_type is ops.week', audit.entity_type, 'ops.week');
      eq(GROUPS.briefing, 'audit actor_id is the acting founder', audit.actor_id, founderSession.userId);
      eq(GROUPS.briefing, 'audit carries the actor email, not just an id', audit.actor_email, 'founder-demo@ops-demo.invalid');
      eq(GROUPS.briefing, 'audit carries the actor authority', audit.actor_authority, 'founder');
      eq(GROUPS.briefing, 'audit new_values records which week was locked', audit.new_values, { week_id: weekId, week_start: WEEK_START });
    }

    if (act) {
      // Idempotency: the migration promises a retried close is a no-op
      // that returns the row as-is. A second audit row would be a false
      // record of a second privileged act.
      await call('founder', 'POST', `/api/weeks/${weekId}/briefing/close`);
      const { data: afterClose2 } = await ops().from('weeks').select('*').eq('id', weekId).single();
      eq(GROUPS.briefing, 'a retried close does not move briefing_closed_at', afterClose2.briefing_closed_at, afterClose.briefing_closed_at);
      const { count: auditAfter2 } = await core().from('audit_logs').select('*', { count: 'exact', head: true }).eq('entity_id', weekId);
      eq(GROUPS.briefing, 'a retried close writes no second audit row', auditAfter2, 1);

      // THE POINT OF CLOSING: the lock is engaged. This is the assertion
      // that a click can never make — the response to a click is the same
      // 200 whether or not the guard now bites.
      await refused(
        GROUPS.briefing,
        'the commitment lock now refuses the OWNER (this is what closing is FOR)',
        () => call('broker', 'DELETE', `/api/tasks/${brokerTask.id}/commit`),
        'commitments are locked for this week'
      );
      // Must be a real column CHANGE. Guard 2a fires on
      // `is distinct from`, so re-POSTing /commit on an already-
      // committed task changes nothing, never reaches the week-state
      // check, and returns 200 — the first version of this assertion
      // did exactly that and produced a false red. An uncommit is a
      // genuine change, so it is the honest test of the lock.
      await refused(
        GROUPS.briefing,
        'the commitment lock refuses OVERSIGHT too, not just staff',
        () => call('gm', 'DELETE', `/api/tasks/${salesTask.id}/commit`),
        'commitments are locked for this week'
      );
      // Recorded rather than asserted as a defect: on a locked week a
      // re-POST of an existing commitment answers 200 having changed
      // nothing, because the guard keys on a column actually changing.
      // Harmless (the state is already what the caller asked for) but
      // it is a 200 that does not mean "I just did that".
      const noop = await call('gm', 'POST', `/api/tasks/${salesTask.id}/commit`);
      record(
        GROUPS.briefing,
        'a no-op re-commit on a locked week is allowed and changes nothing (guard 2a keys on a column changing)',
        noop.is_committed === true && noop.committed_week_id === weekId,
        `is_committed=${noop.is_committed}, committed_week_id=${noop.committed_week_id}`
      );
      const { data: brokerStill } = await ops().from('tasks').select('is_committed, committed_points').eq('id', brokerTask.id).single();
      eq(GROUPS.briefing, 'and the refused uncommit changed nothing', brokerStill.is_committed, true);
    }

    // -----------------------------------------------------------------
    // 6. The lifecycle: submit -> verify -> clear, one row at a time.
    // -----------------------------------------------------------------
    console.log('\n--- 6. submit -> verify -> clear ---');
    if (act) {
      await call('sales', 'POST', `/api/tasks/${salesTask.id}/status`, { to: 'in_progress' });
    }
    const { data: inProg } = await ops().from('tasks').select('*').eq('id', salesTask.id).single();
    eq(GROUPS.lifecycle, 'in_progress is reached', inProg.status, 'in_progress');
    truthy(GROUPS.lifecycle, 'first_in_progress_at is stamped on the first real move into in_progress (cycle time)', inProg.first_in_progress_at);
    const { count: ipLedger } = await ops().from('point_ledger').select('*', { count: 'exact', head: true }).eq('task_id', salesTask.id);
    eq(GROUPS.lifecycle, 'todo -> in_progress writes no ledger row', ipLedger, 0);

    if (act) await call('sales', 'POST', `/api/tasks/${salesTask.id}/status`, { to: 'submitted' });
    const submitted = await ledgerFor(salesTask.id);
    eq(GROUPS.lifecycle, 'submit writes exactly one ledger row', submitted.length, 1);
    if (submitted[0]) {
      const r = submitted[0];
      eq(GROUPS.lifecycle, 'submit ledger: state', r.state, 'submitted');
      eq(GROUPS.lifecycle, 'submit ledger: from_status/to_status', [r.from_status, r.to_status], ['in_progress', 'submitted']);
      eq(GROUPS.lifecycle, 'submit ledger: points is 0 (nothing is awarded before clearing)', r.points, 0);
      eq(GROUPS.lifecycle, 'submit ledger: week_id', r.week_id, weekId);
      eq(GROUPS.lifecycle, 'submit ledger: user_id is the owner', r.user_id, salesSession.userId);
      eq(GROUPS.lifecycle, 'submit ledger: actor_id is who acted', r.actor_id, salesSession.userId);
      eq(GROUPS.lifecycle, 'submit ledger: is_committed snapshotted', r.is_committed, true);
    }
    const gmOutbox = await outboxFor(salesTask.id, 'ops.task.submitted');
    eq(GROUPS.lifecycle, 'submit enqueues one notification per active GM', gmOutbox.length, await countActiveByAuthority('gm'));

    // The pending balance moves before anything clears — this is the
    // "money waiting to clear" figure the home screen shows.
    const balAfterSubmit = await balanceFor(salesSession.userId, weekId);
    eq(GROUPS.lifecycle, 'v_point_balances.pending_with_gm reflects the submission', balAfterSubmit?.pending_with_gm ?? 0, (pricedType?.default_points ?? 0));

    if (act) await call('gm', 'POST', `/api/tasks/${salesTask.id}/status`, { to: 'verified' });
    const { data: verifiedRow } = await ops().from('tasks').select('*').eq('id', salesTask.id).single();
    eq(GROUPS.lifecycle, 'verify reaches verified', verifiedRow.status, 'verified');
    // FOUND BY THIS HARNESS. `ops.tasks.gm_id` / `gm_acted_at` exist, are
    // forgery-guarded ("only a GM may set gm_id/gm_acted_at") and are
    // refused at insert ("a new task cannot be pre-stamped") — but the
    // trigger's `verified` branch stamps nothing, and no route in
    // apps/api sends either column. Grep confirms nothing anywhere writes
    // them. The `cleared` branch three lines further down DOES stamp its
    // founder equivalents. So the GM half of the two-step approval record
    // is permanently null: the response to Verify is a correct 200, and
    // the side effect half-happened. Exactly the §12.7 shape.
    // Reported, not fixed here — supabase/** belongs to another lane.
    const gmStampRef = 'ops.tasks.gm_id/gm_acted_at are never written by anything; the verified branch of ops.enforce_task_transition stamps nothing. Reported 2026-09-10.';
    if (act) {
      knownDefect(GROUPS.lifecycle, 'verify stamps gm_id with the verifying GM (trigger-set, never client-set)', verifiedRow.gm_id === gmSession.userId, gmStampRef, `gm_id=${JSON.stringify(verifiedRow.gm_id)}`);
      knownDefect(GROUPS.lifecycle, 'verify stamps gm_acted_at', Boolean(verifiedRow.gm_acted_at), gmStampRef, `gm_acted_at=${JSON.stringify(verifiedRow.gm_acted_at)}`);
    } else {
      falsy(GROUPS.lifecycle, 'no verify happened, so gm_id is null', verifiedRow.gm_id);
      falsy(GROUPS.lifecycle, 'no verify happened, so gm_acted_at is null', verifiedRow.gm_acted_at);
    }
    // The accountability is not entirely lost: the ledger row for the
    // verify transition carries the acting GM. Asserted below, and it is
    // why this is reported as Minor rather than Major.
    falsy(GROUPS.lifecycle, 'verify does NOT award points', verifiedRow.points_awarded);
    const verLedger = await ledgerFor(salesTask.id);
    eq(GROUPS.lifecycle, 'verify writes a second ledger row', verLedger.length, 2);
    if (verLedger[1]) {
      eq(GROUPS.lifecycle, 'verify ledger: state/from/to', [verLedger[1].state, verLedger[1].from_status, verLedger[1].to_status], ['verified', 'submitted', 'verified']);
      eq(GROUPS.lifecycle, 'verify ledger: actor is the GM', verLedger[1].actor_id, gmSession.userId);
      eq(GROUPS.lifecycle, 'verify ledger: still 0 points', verLedger[1].points, 0);
    }
    eq(GROUPS.lifecycle, 'verify enqueues one notification per active founder', (await outboxFor(salesTask.id, 'ops.task.verified')).length, await countActiveByAuthority('founder'));
    const balAfterVerify = await balanceFor(salesSession.userId, weekId);
    eq(GROUPS.lifecycle, 'the balance moves from pending_with_gm to pending_with_founder', [balAfterVerify?.pending_with_gm ?? 0, balAfterVerify?.pending_with_founder ?? 0], [0, pricedType?.default_points ?? 0]);

    if (act) {
      // A GM may not clear: only the clearing founder. Refusal first, so
      // the clear that follows is proof of authority, not of luck.
      await refused(GROUPS.lifecycle, 'a GM cannot clear a verified task', () => call('gm', 'POST', `/api/tasks/${salesTask.id}/status`, { to: 'cleared' }), 'only the clearing founder may clear');
      await call('founder', 'POST', `/api/tasks/${salesTask.id}/status`, { to: 'cleared' });
    }
    const { data: clearedRow } = await ops().from('tasks').select('*').eq('id', salesTask.id).single();
    eq(GROUPS.lifecycle, 'clear reaches cleared', clearedRow.status, 'cleared');
    eq(GROUPS.lifecycle, 'clear awards points_override ?? catalog_points, computed by the trigger', clearedRow.points_awarded, (pricedType?.default_points ?? 0));
    eq(GROUPS.lifecycle, 'clear stamps founder_id', clearedRow.founder_id, founderSession.userId);
    truthy(GROUPS.lifecycle, 'clear stamps founder_acted_at', clearedRow.founder_acted_at);
    truthy(GROUPS.lifecycle, 'clear stamps cleared_at', clearedRow.cleared_at);
    const clrLedger = await ledgerFor(salesTask.id);
    eq(GROUPS.lifecycle, 'clear writes a third ledger row', clrLedger.length, 3);
    if (clrLedger[2]) {
      eq(GROUPS.lifecycle, 'clear ledger: state/from/to', [clrLedger[2].state, clrLedger[2].from_status, clrLedger[2].to_status], ['cleared', 'verified', 'cleared']);
      eq(GROUPS.lifecycle, 'clear ledger: points equals points_awarded — the ONLY row that carries value', clrLedger[2].points, pricedType?.default_points ?? 0);
      eq(GROUPS.lifecycle, 'clear ledger: actor is the clearing founder', clrLedger[2].actor_id, founderSession.userId);
    }
    eq(GROUPS.lifecycle, 'clear notifies the owner, and only the owner', (await outboxFor(salesTask.id, 'ops.task.cleared')).map((o) => o.recipient_id), [salesSession.userId]);
    const balCleared = await balanceFor(salesSession.userId, weekId);
    eq(GROUPS.lifecycle, 'v_point_balances credits cleared_points and empties both pending buckets', [balCleared?.cleared_points ?? 0, balCleared?.pending_with_gm ?? 0, balCleared?.pending_with_founder ?? 0], [pricedType?.default_points ?? 0, 0, 0]);

    if (act) {
      await refused(GROUPS.lifecycle, 'a cleared task is frozen — even the clearing founder cannot re-title it', () => call('founder', 'PATCH', `/api/tasks/${salesTask.id}`, { title: 'rewriting history' }), 'frozen');
      await refused(GROUPS.lifecycle, 'a cleared task cannot be moved back to verified', () => call('founder', 'POST', `/api/tasks/${salesTask.id}/status`, { to: 'verified' }), 'frozen');
    }

    // -----------------------------------------------------------------
    // 7. Isolation DURING the run: the scoreboard must not have moved.
    // -----------------------------------------------------------------
    console.log('\n--- 7. isolation while the disposable week is live ---');
    const during = await downstreamSnapshot();
    const fpDuring = await fingerprintNonDisposable();

    // ---- The causal assertions. These do not compare against a
    // baseline at all, so no amount of concurrent activity from another
    // session can make them lie: they ask directly whether a disposable
    // week id or a 2099 week_start has been attributed anywhere it
    // should not be.
    const dispIds = new Set((await disposableWeekIds()).map((w) => w.id));
    const sb = during.scoreboard;
    record(GROUPS.isolation, 'the scoreboard reports the real current week, not the disposable one', !dispIds.has(sb.weekId) && sb.weekStart < DISPOSABLE_EPOCH, `weekId=${sb.weekId} weekStart=${sb.weekStart}`);
    const badCurrent = (sb.rows ?? []).filter((r) => dispIds.has(r.currentWeek?.weekId));
    eq(GROUPS.isolation, "no roster row's `this week` figure points at a disposable week", badCurrent.map((r) => r.userId), []);
    const badLastClosed = (sb.rows ?? []).filter((r) => r.lastClosedWeek && r.lastClosedWeek.weekStart >= DISPOSABLE_EPOCH);
    eq(GROUPS.isolation, "no roster row's `last closed week` is a disposable week", badLastClosed.map((r) => r.userId), []);
    const badReliability = (sb.rows ?? []).filter((r) => (r.reliability?.weeklyBreakdown ?? []).some((w) => w.weekStart >= DISPOSABLE_EPOCH));
    eq(GROUPS.isolation, 'no reliability window contains a disposable week (it is closed AND scored, so this is the real test)', badReliability.map((r) => r.userId), []);

    // weekCount is the window's own count of weeks, recomputed here from
    // ops.weeks rather than remembered from the baseline, so a peer
    // creating a real week cannot turn this red.
    const { data: realWeeks } = await ops().from('weeks').select('week_start').lt('week_start', DISPOSABLE_EPOCH).lte('week_start', sb.weekStart);
    const realAnchored = (realWeeks ?? []).length;
    for (const [key, nominal] of [['month', 4], ['quarter', 13]]) {
      const counts = [...new Set((sb.rows ?? []).map((r) => r.periods?.[key]?.weekCount))];
      eq(GROUPS.isolation, `scoreboard \`${key}\` counts only real weeks at or before the current one`, counts, [Math.min(realAnchored, nominal)]);
    }

    // Paying back what stripVolatile() costs. The only way this harness
    // could move a blocked-hours figure is by raising a block, and
    // blocked hours are windowed by the block's `created_at`, not by its
    // week — so a block raised inside a disposable week WOULD land on a
    // real person's reliability score. This harness raises none, and
    // that is asserted rather than promised.
    const dispTaskIds = (await ops().from('tasks').select('id').in('week_id', [...dispIds])).data ?? [];
    const { count: dispBlocks } = dispTaskIds.length
      ? await ops().from('task_blocks').select('*', { count: 'exact', head: true }).in('task_id', dispTaskIds.map((t) => t.id))
      : { count: 0 };
    eq(GROUPS.isolation, 'no task_block exists on any disposable task (blocked hours are windowed by created_at, not by week)', dispBlocks, 0);

    // The week-anchored half of the scoreboard — this week, last 4, last
    // 13, reliability, the last closed week, cycle time, blocked hours —
    // must be untouched, because every one of those windows filters
    // `week_start <= current` or `< current and closed`, and a 2099 week
    // is outside all of them. This is the assertion that makes the
    // choice of a far-future week a mechanism rather than a hope.
    compareOrExcuse(
      GROUPS.isolation,
      'the week-anchored scoreboard (this week / 4 / 13, reliability, blocked hours) is unchanged while a disposable week is live and scored',
      comparable(anchoredScoreboard(during.scoreboard)),
      comparable(anchoredScoreboard(baseline.scoreboard)),
      fpBaseline,
      fpDuring
    );

    // The honest other half. `all` is documented in scoreboard.ts as
    // deliberately NOT re-anchored ("every week that exists, including
    // any after the reference week"), and /points, /queue, /digest and
    // /now are not week-scoped at all. They DO see the disposable week
    // while it exists. Recorded as a fact, not argued away — teardown is
    // what closes it, and section 10 proves that.
    const allTimeMoved = JSON.stringify(allTimeScoreboard(during.scoreboard)) !== JSON.stringify(allTimeScoreboard(baseline.scoreboard));
    const leaked = diffKeys(comparable(baseline), comparable(during)).filter((k) => k !== 'scoreboard');
    record(
      GROUPS.isolation,
      "the reads that are NOT week-anchored do see it: scoreboard `all` plus /points, /queue, /digest, /now — documented, not claimed away",
      allTimeMoved && leaked.length > 0,
      `scoreboard.periods.all moved: ${allTimeMoved}; other reads changed: ${JSON.stringify(leaked)}`
    );

    // -----------------------------------------------------------------
    // 8. close_week — state, rollover, carry-over, idempotency.
    // -----------------------------------------------------------------
    console.log('\n--- 8. close the week ---');
    const { data: preClose } = await ops().from('tasks').select('id, status, carry_over_count, first_week_id').eq('week_id', weekId);
    const unfinished = (preClose ?? []).filter((t) => ['todo', 'in_progress', 'submitted', 'verified', 'rejected'].includes(t.status));
    const finished = (preClose ?? []).filter((t) => !['todo', 'in_progress', 'submitted', 'verified', 'rejected'].includes(t.status));

    let closeResult = null;
    if (act) closeResult = await call('founder', 'POST', `/api/weeks/${weekId}/close`);
    const cr = Array.isArray(closeResult) ? closeResult[0] : closeResult;
    eq(GROUPS.close, 'close_week reports the number of tasks it actually carried', cr?.carried_count ?? null, unfinished.length);

    const { data: closedWeek } = await ops().from('weeks').select('*').eq('id', weekId).single();
    eq(GROUPS.close, 'the week is closed', closedWeek.state, 'closed');
    truthy(GROUPS.close, 'closed_at is stamped', closedWeek.closed_at);
    eq(GROUPS.close, 'closed_by is the acting founder', closedWeek.closed_by, founderSession.userId);
    truthy(GROUPS.close, 'rolled_over_at is stamped (the rollover half actually ran)', closedWeek.rolled_over_at);

    const nextStart = isoPlus(WEEK_START, 7);
    const { data: nextWeek } = await ops().from('weeks').select('*').eq('week_start', nextStart).maybeSingle();
    truthy(GROUPS.close, `close created the next week (${nextStart}) to receive the carry-over`, nextWeek);
    if (nextWeek) {
      eq(GROUPS.close, 'the next week is created in planning', nextWeek.state, 'planning');
      eq(GROUPS.close, 'close_week returns the id of the week it created', cr?.next_week_id, nextWeek.id);
    }

    const { data: postClose } = await ops().from('tasks').select('id, status, week_id, carry_over_count, first_week_id').in('id', (preClose ?? []).map((t) => t.id));
    const movedIds = (postClose ?? []).filter((t) => t.week_id !== weekId).map((t) => t.id).sort();
    eq(GROUPS.close, 'exactly the unfinished tasks moved to the next week', movedIds, unfinished.map((t) => t.id).sort());
    for (const t of postClose ?? []) {
      const was = (preClose ?? []).find((p) => p.id === t.id);
      const carried = movedIds.includes(t.id);
      if (carried) {
        eq(GROUPS.close, `carry_over_count incremented for the carried task ${t.id.slice(0, 8)}`, t.carry_over_count, was.carry_over_count + 1);
        eq(GROUPS.close, `first_week_id PRESERVED on carry-over ${t.id.slice(0, 8)} (PRD §3.7)`, t.first_week_id, weekId);
      }
    }
    for (const t of finished) {
      const now = (postClose ?? []).find((p) => p.id === t.id);
      eq(GROUPS.close, `a ${t.status} task does NOT roll over (${t.id.slice(0, 8)})`, now?.week_id, weekId);
    }

    // The committed record of the closed week survives the rollover
    // untouched — PRD §3.7's "the original week's commitment record stays
    // exactly as it was". This is the assertion a click cannot make.
    const { data: brokerAfterRoll } = await ops().from('tasks').select('week_id, committed_week_id, is_committed, committed_points').eq('id', brokerTask.id).single();
    eq(GROUPS.close, "a carried task keeps the OLD week's commitment record", brokerAfterRoll.committed_week_id, weekId);
    record(GROUPS.close, 'a carried task now lives in the NEXT week', brokerAfterRoll.week_id !== weekId, `week_id=${brokerAfterRoll.week_id}, disposable week=${weekId}`);

    if (act) {
      // Idempotency of the whole close, and of the rollover half
      // independently — a second close must not carry anything twice.
      const again = await call('founder', 'POST', `/api/weeks/${weekId}/close`);
      const ar = Array.isArray(again) ? again[0] : again;
      eq(GROUPS.close, 'a retried close carries nothing a second time', ar?.carried_count, 0);
      eq(GROUPS.close, 'a retried close returns the same next week', ar?.next_week_id, nextWeek?.id ?? null);
      const { data: closed2 } = await ops().from('weeks').select('closed_at, rolled_over_at').eq('id', weekId).single();
      eq(GROUPS.close, 'a retried close does not re-stamp closed_at', closed2.closed_at, closedWeek.closed_at);
      eq(GROUPS.close, 'a retried close does not re-stamp rolled_over_at', closed2.rolled_over_at, closedWeek.rolled_over_at);
      const { data: doubleCheck } = await ops().from('tasks').select('carry_over_count').eq('id', brokerTask.id).single();
      eq(GROUPS.close, 'and no task was carried twice', doubleCheck.carry_over_count, 1);

      // A closed week refuses new work — enforcement, not UI cooperation.
      await refused(
        GROUPS.close,
        'a closed week refuses an INSERT (20260910170000 part 2)',
        () => call('sales', 'POST', '/api/tasks', { weekId, title: '[disposable] into a closed week' }),
        'closed'
      );
    }

    // -----------------------------------------------------------------
    // 9. What closing does NOT do. Recorded because the plan's own
    //    wording ("closing scores everyone") is looser than the code.
    // -----------------------------------------------------------------
    const { data: closeAudit } = await core().from('audit_logs').select('action').eq('entity_id', weekId);
    eq(GROUPS.close, 'ops.close_week writes no audit row of its own (only close_briefing does)', (closeAudit ?? []).map((a) => a.action), ['ops.briefing.closed']);
    const { data: weekLedger } = await ops().from('point_ledger').select('id').eq('week_id', weekId);
    eq(GROUPS.close, 'closing writes no scoring rows: the score is DERIVED from tasks, never stored', (weekLedger ?? []).length, 3);
  } finally {
    // -----------------------------------------------------------------
    // 10. Teardown, and the empirical proof of isolation.
    // -----------------------------------------------------------------
    if (KEEP) {
      console.log('\n--- 10. teardown SKIPPED (--keep) ---');
      console.log(`  the disposable week ${WEEK_START} is still in the database. Run`);
      console.log('  `node scripts/disposable-week.mjs teardown` when finished with it.');
      console.log('');
      console.log('  WARNING — --keep is safe for hours, not days. The reliability modifiers');
      console.log('  read off ALL currently-open tasks with no week filter, so once a');
      console.log("  disposable task's last_activity_at passes ops.settings.stale_after_days");
      console.log("  (default 3) it starts counting as staleness against a real person's");
      console.log('  reliability score. Also: never raise a task_block in a disposable week —');
      console.log('  blocked hours are windowed by the block\'s created_at, not by its week.');
    } else {
      console.log('\n--- 10. teardown, then prove nothing downstream moved ---');
      // Teardown is the safety-critical step, and the observed failure
      // mode in this environment is a burst of DNS failures against the
      // Supabase host lasting tens of seconds. `fetchWithRetry` covers a
      // blip; this covers a burst. If it still cannot get through, say so
      // loudly and name the exact command — a run that silently leaves a
      // disposable week behind is the one outcome that must never be
      // quiet, because the reliability modifiers will start counting its
      // open tasks as staleness after `stale_after_days`.
      let tornDown = false;
      for (let attempt = 1; attempt <= 3 && !tornDown; attempt++) {
        try {
          await teardown();
          tornDown = true;
        } catch (err) {
          console.log(`  [teardown attempt ${attempt}/3 failed] ${err?.message ?? err}`);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 15_000));
        }
      }
      if (!tornDown) {
        console.log('\n  !!! THE DISPOSABLE WEEK IS STILL IN THE DATABASE !!!');
        console.log('  Run this until it succeeds:  node scripts/disposable-week.mjs teardown');
        record(GROUPS.isolation, 'teardown completed', false, 'teardown could not reach the database after 3 attempts');
        return;
      }
      const after = await downstreamSnapshot();
      const fpAfter = await fingerprintNonDisposable();
      for (const key of Object.keys(baseline)) {
        compareOrExcuse(GROUPS.isolation, `after teardown, ${key} is identical to baseline`, comparable(after[key]), comparable(baseline[key]), fpBaseline, fpAfter);
      }
      const { count: ledgerAfter } = await ops().from('point_ledger').select('*', { count: 'exact', head: true });
      compareOrExcuse(GROUPS.isolation, 'ops.point_ledger is back at its baseline row count', ledgerAfter, ledgerBefore, fpBaseline, fpAfter);
      // Causal, and immune to a peer session: nothing this harness
      // named is still in the database.
      const { count: dispTasks } = await ops().from('tasks').select('*', { count: 'exact', head: true }).like('title', '[disposable]%');
      eq(GROUPS.isolation, 'no task this harness created survives teardown', dispTasks, 0);
      const { count: auditAfter } = await core().from('audit_logs').select('*', { count: 'exact', head: true });
      record(
        GROUPS.isolation,
        'core.audit_logs grew by at most one row — the ops.briefing.closed row, which is append-only BY DESIGN and survives teardown',
        auditAfter - auditBefore <= 1,
        `baseline ${auditBefore} -> ${auditAfter}`
      );
      const { count: weeksLeft } = await ops().from('weeks').select('*', { count: 'exact', head: true }).gte('week_start', DISPOSABLE_EPOCH);
      eq(GROUPS.isolation, 'no disposable week row is left behind', weeksLeft, 0);
    }
  }
}

// ---------------------------------------------------------------------
// simulate — several consecutive disposable weeks, end to end, to
// surface what only emerges ACROSS weeks: carry-over age, reliability
// computed over a real window, blocked-time exoneration surviving a
// rollover, accumulation that respects closed-vs-open, and the per-day
// clear counts the contribution heatmap will read.
//
// `run` proves a single Monday works. `simulate` proves the calendar
// works — it never rebuilds anything `run` already covers (recurring
// generation, audit-row shape, ledger rows per transition, idempotency)
// and drives NO recurring generation at all: an uncommitted recurring
// task would sit in `todo` forever and carry every week exactly like
// this harness's own deliberately-missed task, contaminating the one
// set of carry-overs this file needs to reason about by hand.
//
// THE SCENARIO (fixed, not randomised, so a human can follow the log
// and the hand-computed expectations below can be exact):
//   - `sales` NEVER misses: a fresh task, committed and cleared, every
//     single week — including the last, still-open one.
//   - `broker` is blocked in week 0 (an external block, declared before
//     week 0 ends), gets that block RESOLVED in week 1 — proving a
//     block resolves across the week boundary — but the task is
//     deliberately never cleared afterward. That is not an oversight:
//     `ops.tasks.status === 'cleared'` is checked BEFORE the block
//     lookback in the exoneration query (scoreboard.ts / mirrored
//     below), so clearing it later would silently convert week 0 from
//     an exonerated miss into an ordinary hit and this harness would
//     have nothing left to assert. `broker` also picks up a FRESH,
//     ordinary task every other closed week (a perfect hit), so their
//     reliability is a real, non-degenerate RATED score, not UNRATED.
//   - `gm` commits exactly once, in week 0, to a task that is never
//     touched again — the control case: no block, so no exoneration,
//     a plain miss that keeps carrying every week after.
//   - Both `broker`'s week-0 task and `gm`'s task are therefore
//     carry-overs from week 1 onward, their age growing by exactly 1
//     every week — "something carries over twice" happens automatically
//     once n >= 4.
//   - The LAST week is deliberately left open (briefing opened and
//     closed, so commitments lock, but `ops.close_week` is never
//     called) so requirement 3 — a still-open week must not contribute
//     where only closed weeks should — has something real to exclude.
//
// n must be >= 4: 3 closed weeks is the minimum for anyone to leave
// UNRATED (`ops.settings.min_weeks_for_rating`, default 3), and a 4th,
// open week is what proves the closed/open boundary.
// ---------------------------------------------------------------------
async function simulate(n, { red = false } = {}) {
  const act = !red;
  if (!Number.isInteger(n) || n < 4) {
    console.error(`[fatal] simulate needs n >= 4 (got ${n}): 3 closed weeks to clear min_weeks_for_rating, plus one still-open week to prove closed-only aggregates exclude it.`);
    process.exit(1);
  }

  console.log(`=== simulate ${n} consecutive disposable weeks from ${WEEK_START} ${red ? '(RED CONTROL — transitions skipped on purpose)' : ''} ===`);
  console.log(`API ${API}\n`);

  console.log('--- pre-run teardown ---');
  await teardown();

  console.log('\n--- baseline snapshot of every downstream read ---');
  const baseline = await downstreamSnapshot();
  const fpBaseline = await fingerprintNonDisposable();
  const { count: auditBefore } = await core().from('audit_logs').select('*', { count: 'exact', head: true });
  console.log(`  audit_logs=${auditBefore}`);

  const { data: settingsRow } = await ops().from('settings').select('*').eq('id', true).single();
  const halfLifeWeeks = settingsRow?.reliability_half_life_weeks ?? 3;
  const minWeeksForRating = settingsRow?.min_weeks_for_rating ?? 3;
  console.log(`  ops.settings: reliability_half_life_weeks=${halfLifeWeeks} min_weeks_for_rating=${minWeeksForRating}`);

  const pricedType = await pickPricedTaskType();
  const P = pricedType?.default_points ?? 0;
  const sales = await signIn('sales');
  const broker = await signIn('broker');
  const gm = await signIn('gm');
  await signIn('founder');
  console.log(`  priced task type: ${pricedType?.name ?? '(none)'} (${P} pts)`);

  // Causal, immune to peer noise: the REAL demo personas' own live
  // reliability modifiers, captured before this run touches anything.
  // chronicCarryOverByUser in scoreboard.ts reads EVERY currently-open
  // task with no week filter, so once a disposable task's
  // carry_over_count reaches 3 (guaranteed here once n >= 4, because the
  // last week is left open on purpose) it is structurally
  // indistinguishable from a real chronic carry-over for whichever real
  // account owns it — this is the same residue docs/DISPOSABLE-WEEK.md
  // already names for `--keep`, just reachable now WITHOUT `--keep`,
  // from inside a single run, because `simulate` is the first caller to
  // push carry_over_count past 3 before its own teardown.
  async function liveReliabilityFor(userId) {
    const sb = await call('founder', 'GET', '/api/scoreboard');
    const row = (sb.rows ?? []).find((r) => r.userId === userId);
    return { chronicCarryOver: row?.reliability?.modifiers?.chronicCarryOver ?? null, score: row?.reliability?.score ?? null };
  }
  const brokerBefore = await liveReliabilityFor(broker.userId);
  const gmBefore = await liveReliabilityFor(gm.userId);

  const weeks = []; // { index, weekStart, weekId }
  const salesTasks = []; // { weekIndex, id }
  const brokerTasks = []; // { weekIndex, id }
  let gmTask = null;
  const clears = []; // { who, id, weekIndex, clearedAt }

  try {
    for (let i = 0; i < n; i++) {
      const weekStart = isoPlus(WEEK_START, i * 7);
      const isLast = i === n - 1;
      console.log(`\n--- week ${i}: ${weekStart}${isLast ? ' (stays OPEN — close_week is never called)' : ''} ---`);

      // Week creation, like task creation below, is not a "transition" —
      // it happens in both modes, exactly like run()'s section 1. In RED
      // mode this is also the ONLY way week i+1 ever exists, because
      // nothing ever closes to create it automatically.
      const week = await call('founder', 'POST', '/api/weeks', { weekStart });
      const weekId = week.id;
      weeks.push({ index: i, weekStart, weekId });

      // --- carry-over check, BEFORE this week's own new work, so it
      // reflects only what rolled in from the PREVIOUS week's close.
      if (i >= 1) {
        const briefing = await call('founder', 'GET', `/api/briefing/${weekId}`);
        const carryMap = new Map((briefing.carryOvers ?? []).map((c) => [c.id, c]));
        if (act) {
          const b0 = brokerTasks.find((t) => t.weekIndex === 0);
          for (const [label, task] of [
            ["broker's blocked wk0 task", b0],
            ["gm's never-touched wk0 task", gmTask],
          ]) {
            truthy(GROUPS.carryover, `week ${i}: ${label} is a carry-over`, task && carryMap.has(task.id));
            if (task && carryMap.has(task.id)) {
              eq(GROUPS.carryover, `week ${i}: ${label}'s carry-over age is exactly ${i} (grew by 1 from last week)`, carryMap.get(task.id).carryOverCount, i);
            }
          }
        } else {
          eq(GROUPS.carryover, `week ${i}: RED — nothing ever closed, so there are no carry-overs`, (briefing.carryOvers ?? []).length, 0);
        }
      }

      // --- this week's ad-hoc work -------------------------------------
      const sTask = await call('sales', 'POST', '/api/tasks', {
        weekId,
        title: `[disposable] simulate wk${i} sales`,
        description: 'scripts/disposable-week.mjs simulate. Safe to delete.',
        taskTypeId: pricedType?.id,
      });
      salesTasks.push({ weekIndex: i, id: sTask.id });
      if (act) await call('sales', 'POST', `/api/tasks/${sTask.id}/commit`);

      const bTask = await call('broker', 'POST', '/api/tasks', {
        weekId,
        title: `[disposable] simulate wk${i} broker${i === 0 ? ' (will be blocked, never cleared)' : ''}`,
        description: 'scripts/disposable-week.mjs simulate. Safe to delete.',
        taskTypeId: pricedType?.id,
      });
      brokerTasks.push({ weekIndex: i, id: bTask.id });
      if (act) await call('broker', 'POST', `/api/tasks/${bTask.id}/commit`);

      if (i === 0) {
        gmTask = await call('gm', 'POST', '/api/tasks', {
          weekId,
          title: '[disposable] simulate wk0 gm (never finished, never recommitted)',
          description: 'scripts/disposable-week.mjs simulate — a genuine, un-exonerated miss. Safe to delete.',
          taskTypeId: pricedType?.id,
        });
        if (act) await call('gm', 'POST', `/api/tasks/${gmTask.id}/commit`);
      }

      if (act) {
        await call('founder', 'POST', `/api/weeks/${weekId}/briefing/open`);
        await call('founder', 'POST', `/api/weeks/${weekId}/briefing/close`);
      }

      // --- week 0: broker's task goes in_progress, then blocked, before
      // the week ends. Never resolved or touched again within week 0.
      if (act && i === 0) {
        await call('broker', 'POST', `/api/tasks/${bTask.id}/status`, { to: 'in_progress' });
        await call('broker', 'POST', `/api/tasks/${bTask.id}/blocks`, {
          target: 'external',
          blockingExternal: 'Bureau of Customs release',
          reason: 'simulated by scripts/disposable-week.mjs — declared before week 0 ends, on purpose.',
        });
      }

      // --- week 1: resolve the week-0 block (crossing the boundary),
      // but do NOT clear the task — see the file header for why.
      if (act && i === 1) {
        const b0 = brokerTasks.find((t) => t.weekIndex === 0);
        const blocks = await call('broker', 'GET', `/api/tasks/${b0.id}/blocks`);
        const open = (blocks ?? []).find((b) => !b.resolved_at);
        truthy(GROUPS.blocked, 'week 1: the week-0 block is still open going in, as expected', open);
        if (open) await call('broker', 'POST', `/api/blocks/${open.id}/resolve`);
        const { data: resolved } = await ops().from('task_blocks').select('resolved_at').eq('id', open?.id).maybeSingle();
        truthy(GROUPS.blocked, "week 1: resolving it stamps resolved_at — a block genuinely closing across the week boundary", resolved?.resolved_at);
      }

      // --- sales clears every single week, including the open one.
      if (act) {
        await call('sales', 'POST', `/api/tasks/${sTask.id}/status`, { to: 'in_progress' });
        await call('sales', 'POST', `/api/tasks/${sTask.id}/status`, { to: 'submitted' });
        await call('gm', 'POST', `/api/tasks/${sTask.id}/status`, { to: 'verified' });
        await call('founder', 'POST', `/api/tasks/${sTask.id}/status`, { to: 'cleared' });
        const { data: row } = await ops().from('tasks').select('cleared_at').eq('id', sTask.id).single();
        clears.push({ who: 'sales', id: sTask.id, weekIndex: i, clearedAt: row.cleared_at });
      }

      // --- broker's OWN week's task clears the same week too, EXCEPT
      // week 0 (that is the one being blocked) and the last, open week
      // (left mid-flight, on purpose — an open week's own commitment
      // must not look finished before the week is).
      if (act && i > 0 && !isLast) {
        await call('broker', 'POST', `/api/tasks/${bTask.id}/status`, { to: 'in_progress' });
        await call('broker', 'POST', `/api/tasks/${bTask.id}/status`, { to: 'submitted' });
        await call('gm', 'POST', `/api/tasks/${bTask.id}/status`, { to: 'verified' });
        await call('founder', 'POST', `/api/tasks/${bTask.id}/status`, { to: 'cleared' });
        const { data: row } = await ops().from('tasks').select('cleared_at').eq('id', bTask.id).single();
        clears.push({ who: 'broker', id: bTask.id, weekIndex: i, clearedAt: row.cleared_at });
      }

      if (act && !isLast) {
        const closeResult = await call('founder', 'POST', `/api/weeks/${weekId}/close`);
        const cr = Array.isArray(closeResult) ? closeResult[0] : closeResult;
        console.log(`  closed week ${i}; carried ${cr?.carried_count ?? '?'} task(s) into week ${i + 1}`);
      }
    }

    // -------------------------------------------------------------
    // Week states: n-1 closed, exactly 1 (the last) still open.
    // -------------------------------------------------------------
    console.log('\n--- cross-week assertions ---');
    const { data: weekRows } = await ops()
      .from('weeks')
      .select('id, week_start, week_end, state')
      .in('id', weeks.map((w) => w.weekId))
      .order('week_start');
    const closedWeekRows = (weekRows ?? []).filter((w) => w.state === 'closed');
    const openWeekRows = (weekRows ?? []).filter((w) => w.state !== 'closed');
    eq(GROUPS.scoreboardAccum, `exactly ${act ? n - 1 : 0} of the ${n} simulated weeks are closed`, closedWeekRows.length, act ? n - 1 : 0);
    if (act) {
      eq(GROUPS.scoreboardAccum, 'the LAST simulated week is the one still open', openWeekRows.map((w) => w.id), [weeks[n - 1].weekId]);
    }

    // -------------------------------------------------------------
    // Reliability / hit-rate over the closed weeks, hand-computed
    // TWICE independently of packages/ops-scoring/src/reliability.ts:
    //  1. weight-invariant identities (0/x = 0, x/x = 1) that any
    //     correct implementation must satisfy regardless of the
    //     weighting scheme, so they catch a broken exclusion or a
    //     flipped numerator/denominator.
    //  2. an independent re-transcription of PRD.md §5.2's own formula
    //     (handComputeBase below), so a WEIGHTING bug — recency wrong,
    //     lambda wrong, wrong window order — is caught too. It does not
    //     import anything from reliability.ts.
    // -------------------------------------------------------------
    console.log('\n--- reliability, hand-computed against the real closed weeks ---');
    const closedWeekIds = closedWeekRows.map((w) => w.id);
    const weekEndById = new Map(closedWeekRows.map((w) => [w.id, w.week_end]));

    const trackedTaskIds = [...salesTasks.map((t) => t.id), ...brokerTasks.map((t) => t.id), ...(gmTask ? [gmTask.id] : [])];
    const { data: committedTasks } = trackedTaskIds.length
      ? await ops().from('tasks').select('id, owner_user_id, status, committed_points, committed_week_id').in('id', trackedTaskIds)
      : { data: [] };
    const { data: blocksOnTracked } = trackedTaskIds.length
      ? await ops().from('task_blocks').select('task_id, created_at').in('task_id', trackedTaskIds)
      : { data: [] };
    const earliestBlockByTask = new Map();
    for (const b of blocksOnTracked ?? []) {
      const cur = earliestBlockByTask.get(b.task_id);
      if (!cur || b.created_at < cur) earliestBlockByTask.set(b.task_id, b.created_at);
    }

    /**
     * A re-transcription of scoreboard.ts's `weeksByUser` construction
     * (lines ~426-460), independent of that file, scoped to just the
     * closed disposable weeks. If scoreboard.ts's real query ever
     * diverges from this, the two would disagree on the SAME rows —
     * except scoreboard.ts's real query can never see 2099 at all
     * (that is the isolation this whole harness rests on), which is
     * exactly why this exists: it is the only way to prove the
     * exoneration rule against real, driven rows.
     */
    function weeksFor(userId) {
      // Most-recent-closed-first, matching packages/ops-scoring's `i=0
      // is most recent`.
      return [...closedWeekRows].reverse().map((w) => {
        const tasks = (committedTasks ?? []).filter((t) => t.owner_user_id === userId && t.committed_week_id === w.id);
        let committedPoints = 0;
        let clearedCommittedPoints = 0;
        let exoneratedPoints = 0;
        for (const t of tasks) {
          const pts = t.committed_points ?? 0;
          committedPoints += pts;
          if (t.status === 'cleared') {
            clearedCommittedPoints += pts;
            continue;
          }
          const firstBlock = earliestBlockByTask.get(t.id);
          if (firstBlock && firstBlock <= w.week_end) exoneratedPoints += pts;
        }
        return { weekId: w.id, weekStart: w.week_start, committedPoints, clearedCommittedPoints, exoneratedPoints };
      });
    }

    /** Independent re-transcription of PRD.md §5.2's arithmetic, not a call into reliability.ts. */
    function handComputeBase(weeksMostRecentFirst) {
      const lambda = Math.pow(0.5, 1 / halfLifeWeeks);
      let num = 0;
      let den = 0;
      weeksMostRecentFirst.forEach((w, i) => {
        const denom = Math.max(0, w.committedPoints - w.exoneratedPoints);
        if (denom <= 0) return;
        const weight = Math.pow(lambda, i);
        num += weight * w.clearedCommittedPoints;
        den += weight * denom;
      });
      return den > 0 ? num / den : 0;
    }

    for (const [label, userId, expectBase, expectRatedWeeks] of [
      ['sales (never misses)', sales.userId, 1, act ? n - 1 : 0],
      ['broker (exonerated wk0 + perfect hits after)', broker.userId, 1, act ? n - 1 : 0],
      ['gm (one un-exonerated miss, never recommitted)', gm.userId, 0, act ? 1 : 0],
    ]) {
      const weeksArr = weeksFor(userId);
      const rel = reliability(weeksArr, {}, { halfLifeWeeks, minWeeksForRating });
      const handBase = handComputeBase(weeksArr);
      eq(GROUPS.reliabilityX, `${label}: ratedWeeks`, rel.ratedWeeks, expectRatedWeeks);
      if (act) {
        record(
          GROUPS.reliabilityX,
          `${label}: reliability.ts's base (${rel.base.toFixed(4)}) matches an INDEPENDENT re-transcription of PRD.md §5.2 (${handBase.toFixed(4)})`,
          Math.abs(rel.base - handBase) < 1e-9,
          `library base=${rel.base} hand-computed base=${handBase}`
        );
        eq(GROUPS.reliabilityX, `${label}: base is exactly ${expectBase} (weight-invariant — every INCLUDED week is either 0/x or x/x)`, Number(rel.base.toFixed(6)), expectBase);
        const shouldBeRated = expectRatedWeeks >= minWeeksForRating;
        eq(GROUPS.reliabilityX, `${label}: ${shouldBeRated ? 'RATED' : 'UNRATED'} (ratedWeeks=${expectRatedWeeks}, threshold=${minWeeksForRating})`, rel.score === null, !shouldBeRated);
      } else {
        eq(GROUPS.reliabilityX, `${label}: RED — nothing was ever committed or cleared, so ratedWeeks is 0 and the score is UNRATED`, [rel.ratedWeeks, rel.score], [0, null]);
      }
    }

    // The money assertion for "blocked time exonerates a miss, plain misses don't" —
    // broker and gm's week-0 rows, side by side.
    if (act) {
      const brokerW0 = weeksFor(broker.userId).find((w) => w.weekId === weeks[0].weekId);
      const gmW0 = weeksFor(gm.userId).find((w) => w.weekId === weeks[0].weekId);
      eq(GROUPS.blocked, "broker's week-0 commitment is FULLY exonerated (blocked before week end, still never cleared)", brokerW0?.exoneratedPoints, P);
      eq(GROUPS.blocked, "...so it contributes nothing to the ratio, hit or miss", [brokerW0?.committedPoints, brokerW0?.clearedCommittedPoints], [P, 0]);
      eq(GROUPS.blocked, "gm's week-0 commitment has NO block, so exoneratedPoints is 0", gmW0?.exoneratedPoints, 0);
      eq(GROUPS.blocked, "...so it IS counted — a real, un-exonerated miss", [gmW0?.committedPoints, gmW0?.clearedCommittedPoints], [P, 0]);
    }

    // -------------------------------------------------------------
    // Scoreboard accumulation: closed weeks vs. the one still open.
    // Formulas, not queries echoing queries:
    //   sales clears once a week for all n weeks (n-1 in closed weeks, 1 in the open one).
    //   broker clears once a week for weeks 1..n-2 (n-2 clears, all in closed weeks).
    //   gm never clears anything.
    // -------------------------------------------------------------
    console.log('\n--- points accumulation: closed weeks vs. the still-open one ---');
    const clearedTaskIds = clears.map((c) => c.id);
    const { data: clearedLedgerRows } = clearedTaskIds.length
      ? await ops().from('point_ledger').select('task_id, week_id, points').in('task_id', clearedTaskIds).eq('state', 'cleared')
      : { data: [] };
    const closedWeekIdSet = new Set(closedWeekIds);
    const closedOnlyPoints = (clearedLedgerRows ?? []).filter((r) => closedWeekIdSet.has(r.week_id)).reduce((s, r) => s + r.points, 0);
    const openWeekPoints = (clearedLedgerRows ?? []).filter((r) => !closedWeekIdSet.has(r.week_id)).reduce((s, r) => s + r.points, 0);
    const totalPoints = closedOnlyPoints + openWeekPoints;

    const expectedClosedOnly = P * (act ? (n - 1) + (n - 2) : 0); // sales(n-1 closed) + broker(n-2 closed)
    const expectedOpenWeek = P * (act ? 1 : 0); // sales's clear in the still-open last week
    eq(GROUPS.scoreboardAccum, "closed-weeks-only points (the shape reliability/month/quarter use) — hand formula P*((n-1)+(n-2))", closedOnlyPoints, expectedClosedOnly);
    eq(GROUPS.scoreboardAccum, "the still-open week's own cleared points (P*1, sales only) — real, but must sit OUTSIDE a closed-only aggregate", openWeekPoints, expectedOpenWeek);
    eq(GROUPS.scoreboardAccum, 'total = closed-only + the open week (identity, but confirms nothing else leaked in)', totalPoints, expectedClosedOnly + expectedOpenWeek);
    if (act) {
      truthy(GROUPS.scoreboardAccum, "the still-open week's points are real (not a rejected/zeroed write) — it just must not enter a closed-only window", openWeekPoints > 0);
    }

    // -------------------------------------------------------------
    // Per-day activity: the data the contribution heatmap will read.
    // Every cleared task's `cleared_at`, grouped by UTC calendar day,
    // must equal exactly what THIS run caused — no more, no less.
    // -------------------------------------------------------------
    console.log('\n--- per-day cleared counts (heatmap data) ---');
    const { data: clearedTaskRows } = clearedTaskIds.length
      ? await ops().from('tasks').select('id, cleared_at').in('id', clearedTaskIds)
      : { data: [] };
    const actualByDay = new Map();
    for (const t of clearedTaskRows ?? []) {
      const day = String(t.cleared_at).slice(0, 10);
      actualByDay.set(day, (actualByDay.get(day) ?? 0) + 1);
    }
    const expectedByDay = new Map();
    for (const c of clears) {
      const day = String(c.clearedAt).slice(0, 10);
      expectedByDay.set(day, (expectedByDay.get(day) ?? 0) + 1);
    }
    eq(
      GROUPS.heatmap,
      'per-day cleared-task counts match exactly what this run caused (grouped by UTC calendar day of cleared_at)',
      Object.fromEntries([...actualByDay.entries()].sort()),
      Object.fromEntries([...expectedByDay.entries()].sort())
    );
    eq(GROUPS.heatmap, `total cleared tasks across the run is ${act ? 2 * n - 2 : 0} (sales n + broker n-2)`, clearedTaskRows?.length ?? 0, act ? 2 * n - 2 : 0);
    if ([...actualByDay.keys()].length <= 1) {
      console.log('         NOTE: every clear landed on the same UTC calendar day — expected for a run that');
      console.log('         completes in minutes. The grouping query is proven correct; a real multi-day');
      console.log('         spread was not (and cannot be) exercised by a single sitting of this harness.');
    }

    // -------------------------------------------------------------
    // The residue this run's own carry-over growth can leave on a REAL
    // demo persona's LIVE reliability, before teardown — a genuine
    // isolation gap this harness is positioned to prove, not assume.
    // -------------------------------------------------------------
    console.log('\n--- residue check: does a disposable carry_over_count >= 3 leak into a real persona\'s live reliability? ---');
    if (act) {
      const brokerDuring = await liveReliabilityFor(broker.userId);
      const gmDuring = await liveReliabilityFor(gm.userId);
      for (const [label, before, during] of [
        ['broker-demo', brokerBefore, brokerDuring],
        ['gm-demo', gmBefore, gmDuring],
      ]) {
        eq(
          GROUPS.isolation,
          `${label}'s LIVE reliability.modifiers.chronicCarryOver is unaffected by the disposable week's carry-over count while this run is live`,
          during.chronicCarryOver,
          before.chronicCarryOver
        );
        eq(GROUPS.isolation, `${label}'s LIVE reliability.score is unaffected`, during.score, before.score);
      }
    }

    // -------------------------------------------------------------
    // The same anchored-scoreboard proof `run` does, over a longer,
    // multi-week session.
    // -------------------------------------------------------------
    const during = await downstreamSnapshot();
    const fpDuring = await fingerprintNonDisposable();
    compareOrExcuse(
      GROUPS.isolation,
      'the week-anchored scoreboard (this week / 4 / 13, reliability, blocked hours) is unchanged after simulating several disposable weeks',
      comparable(anchoredScoreboard(during.scoreboard)),
      comparable(anchoredScoreboard(baseline.scoreboard)),
      fpBaseline,
      fpDuring
    );
  } finally {
    if (KEEP) {
      console.log('\n--- teardown SKIPPED (--keep) ---');
      console.log(`  ${n} disposable weeks are still in the database. Run \`node scripts/disposable-week.mjs teardown\` when done.`);
    } else {
      console.log('\n--- teardown, then prove nothing downstream moved ---');
      let tornDown = false;
      for (let attempt = 1; attempt <= 3 && !tornDown; attempt++) {
        try {
          await teardown();
          tornDown = true;
        } catch (err) {
          console.log(`  [teardown attempt ${attempt}/3 failed] ${err?.message ?? err}`);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 15_000));
        }
      }
      if (!tornDown) {
        console.log('\n  !!! DISPOSABLE WEEKS ARE STILL IN THE DATABASE !!!');
        console.log('  Run this until it succeeds:  node scripts/disposable-week.mjs teardown');
        record(GROUPS.isolation, 'teardown completed', false, 'teardown could not reach the database after 3 attempts');
        return;
      }
      const after = await downstreamSnapshot();
      const fpAfter = await fingerprintNonDisposable();
      for (const key of Object.keys(baseline)) {
        compareOrExcuse(GROUPS.isolation, `after teardown, ${key} is identical to baseline`, comparable(after[key]), comparable(baseline[key]), fpBaseline, fpAfter);
      }
      const { count: dispTasks } = await ops().from('tasks').select('*', { count: 'exact', head: true }).like('title', '[disposable]%');
      eq(GROUPS.isolation, 'no task this harness created survives teardown', dispTasks, 0);
      const { count: auditAfter } = await core().from('audit_logs').select('*', { count: 'exact', head: true });
      const expectedAuditGrowth = act ? n : 0; // one ops.briefing.closed row per week's briefing close
      record(
        GROUPS.isolation,
        `core.audit_logs grew by exactly ${expectedAuditGrowth} row(s) — one ops.briefing.closed per week's briefing close, append-only BY DESIGN`,
        auditAfter - auditBefore === expectedAuditGrowth,
        `baseline ${auditBefore} -> ${auditAfter} (expected +${expectedAuditGrowth})`
      );
      const { count: weeksLeft } = await ops().from('weeks').select('*', { count: 'exact', head: true }).gte('week_start', DISPOSABLE_EPOCH);
      eq(GROUPS.isolation, 'no disposable week row is left behind', weeksLeft, 0);
      const brokerAfter = await liveReliabilityFor(broker.userId);
      const gmAfter = await liveReliabilityFor(gm.userId);
      eq(GROUPS.isolation, "after teardown, broker-demo's live reliability is back to its pre-run baseline", brokerAfter, brokerBefore);
      eq(GROUPS.isolation, "after teardown, gm-demo's live reliability is back to its pre-run baseline", gmAfter, gmBefore);
    }
  }
}

// ---------------------------------------------------------------------
// Small readers, kept out of the narrative above.
// ---------------------------------------------------------------------
function isoPlus(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function ledgerFor(taskId) {
  const { data } = await ops().from('point_ledger').select('*').eq('task_id', taskId).order('created_at', { ascending: true });
  return data ?? [];
}

async function outboxFor(entityId, eventType) {
  const { data } = await core().from('notification_outbox').select('*').eq('entity_id', entityId).eq('event_type', eventType);
  return data ?? [];
}

async function balanceFor(userId, weekId) {
  const { data } = await ops().from('v_point_balances').select('*').eq('user_id', userId).eq('week_id', weekId).maybeSingle();
  return data;
}

async function countActiveByAuthority(authority) {
  const { data: users } = await core().from('users').select('id, is_active, authority').eq('authority', authority).eq('is_active', true);
  const ids = (users ?? []).map((u) => u.id);
  if (!ids.length) return 0;
  const { data: members } = await core().from('memberships').select('user_id').eq('module', 'ops').eq('is_active', true).in('user_id', ids);
  return new Set((members ?? []).map((m) => m.user_id)).size;
}

/**
 * The expected recurring set, derived from the same four joins
 * `ops.generate_recurring_tasks` performs: active template, active task
 * type, active ops membership at that position, active user. Computed
 * independently so the assertion is a real comparison and not a
 * restatement of whatever the function happened to do.
 */
async function expectedRecurringPairs() {
  const { data: templates } = await ops().from('recurring_templates').select('id, position, title, description, task_type_id, is_active');
  const { data: types } = await ops().from('task_types').select('id, is_active, default_points');
  const { data: members } = await core().from('memberships').select('user_id, position, module, is_active');
  const { data: users } = await core().from('users').select('id, email, is_active, read_only');
  const typeById = new Map((types ?? []).map((t) => [t.id, t]));
  const userById = new Map((users ?? []).map((u) => [u.id, u]));

  const pairs = [];
  for (const rt of (templates ?? []).filter((t) => t.is_active)) {
    const type = typeById.get(rt.task_type_id);
    if (!type?.is_active) continue;
    for (const m of (members ?? []).filter((m) => m.module === 'ops' && m.is_active && m.position === rt.position)) {
      const u = userById.get(m.user_id);
      if (!u?.is_active) continue;
      // `and not u.read_only` — 20260910120100_core_read_only_accounts.sql
      // redefines ops.generate_recurring_tasks to skip read-only members,
      // because a read-only founder cannot move a task and generating one
      // would both clutter their board and pollute their reliability score
      // with commitments they are structurally unable to act on. The first
      // version of this harness omitted the filter and reported two false
      // reds (erc-demo, dca-demo) — the harness was wrong, not the product.
      if (u.read_only) continue;
      pairs.push({
        key: `${m.user_id}|${rt.id}`,
        email: u.email,
        readOnly: u.read_only,
        title: rt.title,
        description: rt.description,
        taskTypeId: rt.task_type_id,
        defaultPoints: type.default_points,
      });
    }
  }
  return pairs;
}

/** A priced, active, non-recurring type, so the point assertions are not all about null. */
async function pickPricedTaskType() {
  const { data } = await ops()
    .from('task_types')
    .select('id, name, default_points, is_active, is_recurring')
    .eq('is_active', true)
    .not('default_points', 'is', null)
    .order('default_points', { ascending: true });
  return (data ?? []).find((t) => !t.is_recurring) ?? (data ?? [])[0] ?? null;
}

// ---------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------
function report({ red, requiredGroups }) {
  const failed = checks.filter((c) => !c.ok);
  const unclear = checks.filter((c) => c.inconclusive);
  const known = checks.filter((c) => c.known);
  const byGroup = new Map();
  for (const c of checks) {
    const g = byGroup.get(c.group) ?? { pass: 0, fail: 0, unclear: 0, known: 0 };
    if (!c.ok) g.fail++;
    else if (c.inconclusive) g.unclear++;
    else if (c.known) g.known++;
    else g.pass++;
    byGroup.set(c.group, g);
  }

  console.log('\n=== summary ===');
  for (const [group, g] of byGroup) {
    console.log(
      `  ${group.padEnd(26)} ${g.pass} pass, ${g.fail} fail` +
        `${g.unclear ? `, ${g.unclear} inconclusive` : ''}${g.known ? `, ${g.known} known-defect` : ''}`
    );
  }
  console.log(
    `  ${'TOTAL'.padEnd(26)} ${checks.length - failed.length - unclear.length - known.length} pass, ` +
      `${failed.length} fail, ${unclear.length} inconclusive, ${known.length} known-defect`
  );
  if (known.length) {
    console.log('\nKNOWN DEFECTS still open (found by this harness, reported, not fixed here):');
    for (const k of known) console.log(`  x [${k.group}] ${k.name}`);
  }
  if (unclear.length) {
    console.log('\nINCONCLUSIVE (another session wrote to the shared project mid-run):');
    for (const u of unclear) console.log(`  ? [${u.group}] ${u.name}`);
  }

  if (!red) {
    if (failed.length) {
      console.log('\nFAILED:');
      for (const f of failed) console.log(`  - [${f.group}] ${f.name}`);
      return 1;
    }
    return 0;
  }

  // Negative control: every side-effect group must have proven it can
  // fail. A group that stayed green with the transitions skipped is a
  // group whose assertions are not reading the side effect at all.
  const required = requiredGroups ?? [GROUPS.recurring, GROUPS.briefing, GROUPS.lifecycle, GROUPS.close, GROUPS.commit];
  console.log('\n=== RED CONTROL ===');
  console.log('  Every transition was skipped, so every side-effect assertion MUST fail.');
  let bad = 0;
  for (const g of required) {
    const stats = byGroup.get(g) ?? { pass: 0, fail: 0 };
    const good = stats.fail > 0;
    console.log(`  ${good ? 'ok  ' : 'BAD '} ${g.padEnd(26)} ${stats.fail} of ${stats.fail + stats.pass} assertions went red`);
    if (!good) bad++;
  }
  if (bad) {
    console.log('\n  A group that could not go red is a group that is not reading its side effect.');
    return 1;
  }
  console.log('\n  All side-effect groups can go red. The green run above is therefore meaningful.');
  return 0;
}

// ---------------------------------------------------------------------
try {
  if (MODE === 'inspect') {
    await inspect();
    process.exit(0);
  } else if (MODE === 'teardown') {
    await teardown();
    process.exit(0);
  } else if (MODE === 'run' || MODE === 'prove-red') {
    const red = MODE === 'prove-red';
    await run({ red });
    process.exit(report({ red }));
  } else if (MODE === 'simulate' || MODE === 'simulate-red') {
    const red = MODE === 'simulate-red';
    const n = Number(process.argv[3] ?? 4);
    await simulate(n, { red });
    process.exit(
      report({
        red,
        requiredGroups: red ? [GROUPS.carryover, GROUPS.reliabilityX, GROUPS.blocked, GROUPS.scoreboardAccum, GROUPS.heatmap] : undefined,
      })
    );
  } else {
    console.error(`unknown command "${MODE}". Try: run | run --keep | teardown | inspect | prove-red | simulate <n> | simulate-red <n>`);
    process.exit(2);
  }
} catch (err) {
  console.error(`\n[fatal] ${err?.stack ?? err?.message ?? JSON.stringify(err)}`);
  if (err?.payload) console.error(JSON.stringify(err.payload, null, 2));
  process.exit(1);
}
