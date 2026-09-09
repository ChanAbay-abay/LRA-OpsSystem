/**
 * LRA Global Ops :: the lifecycle integration test — a real HTTP boundary
 *
 * PLAN.md §6.3 / Definition of Done #4: a green unit suite coexisted
 * with HR's API returning 500 on every authenticated request, because
 * no test crossed a process boundary. This one does: `buildServer()` is
 * booted and actually LISTENS on a TCP port (not Fastify `inject`), and
 * every request below is a real `fetch()` over that socket, exactly the
 * path a browser or curl would take.
 *
 * It walks create -> commit -> submit -> verify -> clear as three real
 * personas signed in with real Supabase JWTs (not service-role
 * shortcuts), and asserts the two refusals PLAN.md §6.3 names by name:
 * a staff member cannot verify their own task, and a GM cannot clear
 * one.
 *
 * CREDENTIALS. This runs against the LIVE Supabase project (ref
 * ttrjzyyuktropkufkcoj) using the four throwaway `@ops-demo.invalid`
 * accounts `scripts/seed-demo.mjs` creates -- there is no local
 * `supabase start` stack for this suite (that is `supabase/tests/
 * rls_test.sql`'s job, against a throwaway Postgres). Two things must
 * both be true or this test SKIPS LOUDLY instead of silently passing:
 *
 *   1. `apps/api/.env` has SUPABASE_URL / SUPABASE_ANON_KEY /
 *      SUPABASE_SERVICE_ROLE_KEY (loaded by `dotenv/config`, which
 *      `../src/server.js` imports first, same as every other route).
 *   2. `apps/web/.env` has VITE_DEMO_LOGINS with working passwords for
 *      founder-demo / gm-demo / sales-demo, and founder-demo is the
 *      seated clearing founder (`node scripts/seed-demo.mjs` sets both;
 *      re-run it if a password was rotated since).
 *
 * The task this test creates is left in the database in its final
 * `cleared` state during the run, then removed via `serviceClient` in a
 * `finally` -- the one legitimate service-role write in this file,
 * because it is test cleanup of a task owned entirely by a throwaway
 * `.invalid` demo account, the exact case `ops_ledger_purge_exception`
 * exists for (see that migration's header). It is best-effort and never
 * fails the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { buildServer } from '../src/server.js';

interface DemoCreds {
  founder?: { email: string; password: string };
  gm?: { email: string; password: string };
  sales?: { email: string; password: string };
}

/** Best-effort parse of apps/web/.env's VITE_DEMO_LOGINS -- mirrors the
 * trust rule apps/web/src/lib/demo-logins.ts applies at runtime (only
 * an `@ops-demo.invalid` email is ever trusted), so this test can never
 * pick up a stray real credential even if one somehow landed in that
 * file. */
function loadDemoCreds(): DemoCreds | null {
  const envPath = path.resolve(process.cwd(), '..', 'web', '.env');
  if (!existsSync(envPath)) return null;

  const raw = readFileSync(envPath, 'utf8');
  const match = raw.match(/^VITE_DEMO_LOGINS=(.+)$/m);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    (e): e is [string, string] => typeof e[1] === 'string' && e[0].toLowerCase().endsWith('@ops-demo.invalid')
  );

  const find = (prefix: string) => {
    const hit = entries.find(([email]) => email.toLowerCase().startsWith(prefix));
    return hit ? { email: hit[0], password: hit[1] } : undefined;
  };

  return { founder: find('founder-demo'), gm: find('gm-demo'), sales: find('sales-demo') };
}

test('lifecycle across a real HTTP boundary: create -> commit -> submit -> verify -> clear', async (t) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !anonKey || !serviceKey) {
    t.skip('apps/api/.env is missing SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY -- cannot reach the live project.');
    return;
  }

  const creds = loadDemoCreds();
  if (!creds?.founder || !creds.gm || !creds.sales) {
    t.skip(
      'apps/web/.env has no usable VITE_DEMO_LOGINS for founder-demo/gm-demo/sales-demo. ' +
        'Run `node scripts/seed-demo.mjs` to create the throwaway demo accounts, then retry.'
    );
    return;
  }

  const anon = () => createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = async (email: string, password: string) => {
    const client = anon();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    return { data, error };
  };

  const [founderAuth, gmAuth, salesAuth] = await Promise.all([
    signIn(creds.founder.email, creds.founder.password),
    signIn(creds.gm.email, creds.gm.password),
    signIn(creds.sales.email, creds.sales.password),
  ]);

  if (founderAuth.error || gmAuth.error || salesAuth.error) {
    t.skip(
      'one or more demo accounts could not sign in -- ' +
        [
          founderAuth.error && `founder-demo: ${founderAuth.error.message}`,
          gmAuth.error && `gm-demo: ${gmAuth.error.message}`,
          salesAuth.error && `sales-demo: ${salesAuth.error.message}`,
        ]
          .filter(Boolean)
          .join('; ') +
        '. Passwords may have rotated -- re-run `node scripts/seed-demo.mjs --rotate-passwords` ' +
        'and update apps/web/.env.'
    );
    return;
  }

  const founderToken = founderAuth.data.session!.access_token;
  const gmToken = gmAuth.data.session!.access_token;
  const salesToken = salesAuth.data.session!.access_token;
  const salesUserId = salesAuth.data.user!.id;

  const app = buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('server did not report a TCP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let createdWeekId: string | null = null;
  let createdTaskId: string | undefined;

  try {
    const call = async (token: string, method: string, urlPath: string, body?: unknown) => {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json: { data?: unknown; error?: { message: string; code?: string } } | undefined;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      return { status: res.status, ok: res.ok, body: json };
    };

    // founder-demo must actually hold the one clearing-founder seat, or
    // the "founder clears" step below is guaranteed to fail for a
    // reason that has nothing to do with this test.
    const me = await call(founderToken, 'GET', '/api/me');
    if (!me.ok || !(me.body?.data as { isClearingFounder?: boolean } | undefined)?.isClearingFounder) {
      t.skip(
        'founder-demo is not the seated clearing founder in this database. ' +
          'Run `node scripts/seed-demo.mjs` (it sets this) and retry.'
      );
      return;
    }

    // An ISOLATED week of this test's own, not the current one.
    //
    // This used to call `POST /api/weeks`, which returns the *current*
    // week -- and the test then silently depended on that week still
    // being in `planning`. The moment anyone closes the Monday briefing
    // (an ordinary Monday action, and exactly what the commitment lock
    // exists to do) the week moves to `open`, commits are refused, and
    // this test fails with "commitments are locked for this week"
    // through no fault of the code it is testing. There is deliberately
    // no reopen path (PRD.md §6.2), so that failure would persist until
    // the following Monday.
    //
    // That is the same bug class this project has hit twice before --
    // see docs/AGENT-LESSONS.md: a fixture must never depend on live,
    // mutable state. So the test now owns its week outright.
    //
    // Service role is correct here: this is fixture setup, not the
    // behaviour under test. Everything actually being asserted below
    // still goes over real HTTP as real personas.
    //
    // The date is deliberately historical and fixed, so it can never
    // collide with a real week, and it is looked up before insert so a
    // run whose cleanup was interrupted heals itself instead of dying
    // on the unique constraint.
    const svcSetup = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const TEST_WEEK_START = '2020-01-06'; // a Monday, long before LRA Ops existed
    const { data: existingWeek } = await svcSetup
      .schema('ops')
      .from('weeks')
      .select('id')
      .eq('week_start', TEST_WEEK_START)
      .maybeSingle();

    let weekId: string;
    if (existingWeek) {
      weekId = existingWeek.id as string;
    } else {
      const { data: madeWeek, error: weekErr } = await svcSetup
        .schema('ops')
        .from('weeks')
        .insert({ week_start: TEST_WEEK_START, state: 'planning' }) // week_end is GENERATED
        .select('id')
        .single();
      assert.ok(!weekErr, `could not create the isolated test week: ${weekErr?.message}`);
      weekId = madeWeek!.id as string;
      createdWeekId = weekId;
    }

    // A priced, active catalog type -- 'Client follow-up' is seeded at
    // a known placeholder value (2 points, migration 20260909180000),
    // which lets the balance assertion at the end be exact rather than
    // "some positive number".
    const catalogRes = await call(salesToken, 'GET', '/api/catalog');
    assert.equal(catalogRes.status, 200, `GET /api/catalog: ${JSON.stringify(catalogRes.body)}`);
    const types = catalogRes.body!.data as Array<{ id: string; name: string; default_points: number | null; is_active: boolean }>;
    const taskType =
      types.find((t2) => t2.name === 'Client follow-up' && t2.is_active) ??
      types.find((t2) => t2.default_points !== null && t2.is_active);
    assert.ok(taskType, 'no active, priced task type found in the catalog -- seed migration may not have applied');

    // Balance before, so the "resulting balance" assertion at the end
    // is a DELTA -- sales-demo already owns other cleared tasks from
    // `scripts/seed-demo.mjs`'s realistic week, so an absolute figure
    // would be a coincidence, not a proof.
    const balanceBefore = await call(founderToken, 'GET', `/api/points/me?weekId=${weekId}&userId=${salesUserId}`);
    assert.equal(balanceBefore.status, 200, `GET /api/points/me (before): ${JSON.stringify(balanceBefore.body)}`);
    const clearedBefore =
      ((balanceBefore.body!.data as Array<{ cleared_points: number }>)[0]?.cleared_points as number | undefined) ?? 0;

    // --- create -----------------------------------------------------
    const title = `[integration-test] lifecycle ${Date.now()}`;
    const createRes = await call(salesToken, 'POST', '/api/tasks', {
      weekId,
      taskTypeId: taskType!.id,
      title,
    });
    assert.equal(createRes.status, 200, `POST /api/tasks: ${JSON.stringify(createRes.body)}`);
    const task = createRes.body!.data as { id: string; status: string; owner_user_id: string };
    createdTaskId = task.id;
    assert.equal(task.status, 'todo');
    assert.equal(task.owner_user_id, salesUserId);

    // --- commit -------------------------------------------------------
    const commitRes = await call(salesToken, 'POST', `/api/tasks/${task.id}/commit`);
    assert.equal(commitRes.status, 200, `POST /api/tasks/:id/commit: ${JSON.stringify(commitRes.body)}`);
    assert.equal((commitRes.body!.data as { is_committed: boolean }).is_committed, true);

    // --- submit -------------------------------------------------------
    const submitRes = await call(salesToken, 'POST', `/api/tasks/${task.id}/status`, { to: 'submitted' });
    assert.equal(submitRes.status, 200, `submit: ${JSON.stringify(submitRes.body)}`);
    assert.equal((submitRes.body!.data as { status: string }).status, 'submitted');

    // --- REFUSAL: the owner may not verify their own task ------------
    const selfVerifyRes = await call(salesToken, 'POST', `/api/tasks/${task.id}/status`, { to: 'verified' });
    assert.notEqual(selfVerifyRes.status, 200, 'staff verifying their own task should be refused, was accepted');
    assert.ok(selfVerifyRes.status >= 400 && selfVerifyRes.status < 500, `expected a 4xx refusal, got ${selfVerifyRes.status}`);

    // --- verify (GM) ----------------------------------------------------
    const verifyRes = await call(gmToken, 'POST', `/api/tasks/${task.id}/status`, { to: 'verified' });
    assert.equal(verifyRes.status, 200, `verify: ${JSON.stringify(verifyRes.body)}`);
    assert.equal((verifyRes.body!.data as { status: string }).status, 'verified');

    // --- REFUSAL: a GM may not clear ---------------------------------
    const gmClearRes = await call(gmToken, 'POST', `/api/tasks/${task.id}/status`, { to: 'cleared' });
    assert.notEqual(gmClearRes.status, 200, 'GM clearing a task should be refused, was accepted');
    assert.ok(gmClearRes.status >= 400 && gmClearRes.status < 500, `expected a 4xx refusal, got ${gmClearRes.status}`);

    // --- clear (founder) --------------------------------------------
    const clearRes = await call(founderToken, 'POST', `/api/tasks/${task.id}/status`, { to: 'cleared' });
    assert.equal(clearRes.status, 200, `clear: ${JSON.stringify(clearRes.body)}`);
    const cleared = clearRes.body!.data as { status: string; points_awarded: number };
    assert.equal(cleared.status, 'cleared');
    assert.equal(cleared.points_awarded, taskType!.default_points, 'points_awarded should equal the catalog snapshot, no override was set');

    // --- three ledger rows --------------------------------------------
    const ledgerRes = await call(founderToken, 'GET', `/api/points/ledger?userId=${salesUserId}&weekId=${weekId}`);
    assert.equal(ledgerRes.status, 200, `GET /api/points/ledger: ${JSON.stringify(ledgerRes.body)}`);
    const ledgerRows = (ledgerRes.body!.data as Array<{ task_id: string; state: string; created_at: string }>)
      .filter((r) => r.task_id === task.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    assert.equal(ledgerRows.length, 3, `expected 3 ledger rows for this task, got ${ledgerRows.length}: ${JSON.stringify(ledgerRows)}`);
    assert.deepEqual(
      ledgerRows.map((r) => r.state),
      ['submitted', 'verified', 'cleared']
    );

    // --- the resulting balance -----------------------------------------
    const balanceAfter = await call(founderToken, 'GET', `/api/points/me?weekId=${weekId}&userId=${salesUserId}`);
    assert.equal(balanceAfter.status, 200, `GET /api/points/me (after): ${JSON.stringify(balanceAfter.body)}`);
    const clearedAfter =
      ((balanceAfter.body!.data as Array<{ cleared_points: number }>)[0]?.cleared_points as number | undefined) ?? 0;
    assert.equal(
      clearedAfter - clearedBefore,
      cleared.points_awarded,
      `expected cleared_points to grow by exactly points_awarded (${cleared.points_awarded})`
    );
  } finally {
    // Best-effort cleanup, never fails the test. See file header for
    // why a direct service-role delete is the right call here.
    if (createdTaskId) {
      const svc = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await svc.schema('ops').from('tasks').delete().eq('id', createdTaskId);
      if (error) {
        // eslint has no opinion here; this is test hygiene, not a
        // production path -- log and move on.
        console.warn(`[lifecycle-integration] cleanup of task ${createdTaskId} failed: ${error.message}`);
      }
    }
    // The isolated week goes last: its tasks reference it. Only remove a
    // week THIS run created, so a concurrent run is never pulled out
    // from under itself.
    if (createdWeekId) {
      const svc = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await svc.schema('ops').from('weeks').delete().eq('id', createdWeekId);
      if (error) {
        console.warn(`[lifecycle-integration] cleanup of week ${createdWeekId} failed: ${error.message}`);
      }
    }
    await app.close();
  }
});
