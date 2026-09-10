/**
 * LRA Global Ops :: the service-role read-only invariant, mechanically
 *
 * `middleware/auth.ts`'s `refuseReadOnlyWrites` carries this rule in a comment:
 * *any new router that writes on `serviceClient` must add this hook.* A peer
 * session made the sharp observation that **the invariant was a comment, and a
 * comment is exactly what silently failed** — it held in `routes/admin.ts` and
 * quietly did not in `routes/jobs.ts`, whose writes live one import away in
 * `services/`, which is why a per-file read of admin.ts never surfaced it.
 *
 * So it is checked here instead of asserted in prose.
 *
 * WHY THE RULE EXISTS. Every write policy in
 * 20260910120100_core_read_only_accounts.sql carries `not core.is_read_only()`,
 * which covers every write that goes through `userClient`. It cannot cover a
 * service-role connection: `core.is_read_only()` reads `core.auth_user_id()`,
 * null as the service role, so it returns false for everyone. A router exposing
 * a service-role write has no read-only guard unless it registers the hook.
 *
 * WHAT THIS TEST DOES NOT DO. It does not judge whether a service-role write is
 * *justified* — that is a human decision, recorded per-handler in the route
 * files. It checks two mechanical things: that the set of modules performing
 * such a write is exactly the set we have reviewed, and that every router able
 * to trigger one registers the hook. A new service-role write anywhere fails
 * this test until somebody classifies it, which is the point.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// `dist/test/*.test.js` at runtime (see this package's test script), so the
// source tree is two levels up. Read the SOURCE, not the build output: the
// build strips nothing relevant but the source is what a human edits and what
// a reviewer would be looking at.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../src');

const WRITE_VERBS = ['insert', 'update', 'upsert', 'delete', 'rpc'] as const;

/**
 * Modules that perform a write on a `serviceClient()` connection, with the
 * reason each is acceptable. **This table is the audit.** If the detector below
 * finds a module that is not here, the test fails and somebody has to decide
 * which case it is rather than inheriting a silent bypass.
 */
const DECLARED_SERVICE_ROLE_WRITES: Record<string, string> = {
  'routes/admin.ts':
    'The provisioning surface (invite/patch/delete/restore/purge) inherently needs the service role — it creates the very rows RLS would scope. Guarded: the router registers refuseReadOnlyWrites.',
  'services/outbox.ts':
    'The notification drain is a system job with no human caller of its own. Reachable only via routes/jobs.ts, which is guarded.',
  'lib/supabase.ts':
    'INFRASTRUCTURE, two of them: writeAudit() inserts core.audit_logs and enqueueNotification() inserts core.notification_outbox. Both run as the service role BY DESIGN, regardless of caller, and both only ever run downstream of an action RLS has already authorised — an audit row must be written even for a caller with no right to write the audit table, which is the entire point of an audit table. They record a consequence; they are not the caller performing their own write through a bypass, which is what refuseReadOnlyWrites exists to stop. Excluded from PRIMARY below: including them would drag in every router that logs an audit row (12 of them, since userClient lives in this module too) and a check that flags everything is exactly as useless as one that flags nothing.',
};

/**
 * The subset whose write IS the primary effect of an HTTP request, and which
 * therefore obliges any router that can reach it to register the hook.
 * `lib/supabase.ts` is deliberately excluded — see its entry above.
 */
const PRIMARY: string[] = ['routes/admin.ts', 'services/outbox.ts'];

/** Direct local imports of one module, as source-relative paths. */
function localImports(rel: string): string[] {
  let src: string;
  try {
    src = readFileSync(join(SRC, rel), 'utf8');
  } catch {
    return []; // a type-only or package import that does not resolve to a file here
  }
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
    // The API compiles to ESM, so imports carry a `.js` extension that maps
    // back to the `.ts` on disk.
    const target = m[1].replace(/\.js$/, '.ts');
    const parts = rel.split('/');
    parts.pop();
    out.push(join(parts.join('/'), target).replace(/^\/+/, ''));
  }
  return out;
}

/**
 * Everything a router can reach, transitively.
 *
 * Not capped at one hop, deliberately. A fixed depth is arbitrary and the shape
 * that defeats it is already in this tree: `routes/jobs.ts` reaches
 * `services/stale.ts` in one hop, and `stale.ts` itself imports
 * `enqueueNotification` from `lib/supabase.ts`. Full closure is free here and
 * cannot over-report, because what it is matched against (`PRIMARY`) is a
 * reviewed list of two, not "any module containing a service-role write".
 */
function reachableFrom(rel: string): Set<string> {
  const seen = new Set<string>([rel]);
  const queue = [rel];
  while (queue.length) {
    for (const next of localImports(queue.pop()!)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * Modules performing a write on a service-role connection.
 *
 * Deliberately scoped to variables bound ONLY to `serviceClient()` in that
 * file. `db` means the service role in `routes/admin.ts` and the caller's own
 * client in `routes/tasks.ts`, so a name-blind scan would report the wrong
 * files — and a false positive here is worse than none, because it would train
 * whoever hits it to add the declaration rather than look.
 */
function serviceRoleWrites(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const dir of ['routes', 'services', 'lib', 'middleware']) {
    for (const file of readdirSync(join(SRC, dir))) {
      if (!file.endsWith('.ts')) continue;
      const rel = `${dir}/${file}`;
      const src = readFileSync(join(SRC, rel), 'utf8');

      const binds = new Map<string, Set<string>>();
      for (const m of src.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(serviceClient|userClient)\s*\(/g)) {
        const set = binds.get(m[1]) ?? new Set<string>();
        set.add(m[2]);
        binds.set(m[1], set);
      }
      const serviceOnly = new Set(
        [...binds.entries()].filter(([, k]) => k.size === 1 && k.has('serviceClient')).map(([v]) => v)
      );
      if (serviceOnly.size === 0) continue;

      for (const m of src.matchAll(/\b(\w+)\s*\n?\s*\.schema\(/g)) {
        if (!serviceOnly.has(m[1])) continue;
        // The chain after `.schema('x')` is where the verb sits. A generous
        // window: these chains are formatted across several lines.
        const at = m.index! + m[0].length;
        const tail = src.slice(at, at + 400);
        if (!WRITE_VERBS.some((v) => tail.includes(`.${v}(`))) continue;
        const set = found.get(rel) ?? new Set<string>();
        set.add(enclosingExport(src, m.index!));
        found.set(rel, set);
      }
    }
  }
  return found;
}

/**
 * The exported function a write sits inside, by walking backwards from its
 * position to the nearest `export function` / `export async function`.
 *
 * Positional, not semantic — no AST, no dataflow, the same regex pass plus one
 * lookup. That is the whole point: it is cheap enough that there is no excuse
 * for attributing at module granularity instead, and module granularity is what
 * lets a declaration go stale.
 */
function enclosingExport(src: string, index: number): string {
  const before = src.slice(0, index);
  const matches = [...before.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)];
  return matches.length ? matches[matches.length - 1][1] : '<module scope>';
}

function serviceRoleWriteModules(): string[] {
  return [...serviceRoleWrites().keys()].sort();
}

describe('service-role write guard', () => {
  // A detector that silently matches nothing would pass this file forever and
  // prove nothing. This project has already been burned once today by trusting
  // a tool that was not measuring what it claimed to (a Playwright refusal read
  // as an application refusal, which produced a false Major finding), so the
  // detector is made to prove it can see before anything is concluded from it.
  test('the detector actually detects — positive control', () => {
    const found = serviceRoleWriteModules();
    assert.ok(found.length > 0, 'detector found no service-role writes at all, so every assertion below is void');
    assert.ok(found.includes('routes/admin.ts'), 'detector missed routes/admin.ts, which certainly does write as the service role');
    assert.ok(found.includes('services/outbox.ts'), 'detector missed services/outbox.ts, which inserts core.notifications');
  });

  /**
   * The positive control proves the detector is not dead. Only a negative
   * control proves it is not indiscriminate — and for a check like this,
   * matching EVERYTHING is the likelier failure and the more dangerous one,
   * because it trains whoever hits it to add a declaration rather than look.
   * `routes/catalog.ts` earns its place here: it mentions `serviceClient` only
   * in a comment recording that it deliberately does NOT use one to dodge a
   * policy, so it is clean for a stated reason rather than by accident.
   */
  test('the detector is not indiscriminate — negative control', () => {
    const found = serviceRoleWriteModules();
    assert.ok(
      !found.includes('routes/catalog.ts'),
      'routes/catalog.ts was flagged, but it deliberately uses no service client at all — the detector is matching on mentions, not on bindings'
    );
    assert.ok(
      !found.includes('routes/settings.ts'),
      'routes/settings.ts was flagged, but its own write runs on userClient; it merely imports writeAudit from a module that writes as the service role. Attribution has slipped from bindings to file membership.'
    );
  });

  test('the detector does NOT flag routers whose writes run on userClient', () => {
    const found = serviceRoleWriteModules();
    // These three use `serviceClient()` for name/roster joins and write only
    // through the caller's own client, so `not core.is_read_only()` already
    // covers them. If one shows up here, either it gained a service-role write
    // or the detector has become name-blind; both need a human.
    for (const rel of ['routes/tasks.ts', 'routes/task-edit-requests.ts', 'routes/points.ts']) {
      assert.ok(!found.includes(rel), `${rel} was flagged as a service-role writer — check whether it gained one`);
    }
  });

  test('every service-role write module is one we have reviewed', () => {
    const found = serviceRoleWriteModules();
    // An EXACT set, not a superset. A "contains" assertion lets the next real
    // gap hide inside a long list; equality makes it show up as a failure.
    assert.deepEqual(
      found,
      Object.keys(DECLARED_SERVICE_ROLE_WRITES).sort(),
      'the set of modules writing as the service role is no longer exactly the set we reviewed'
    );
    const undeclared = found.filter((f) => !(f in DECLARED_SERVICE_ROLE_WRITES));
    assert.deepEqual(
      undeclared,
      [],
      `New service-role write(s) found in ${undeclared.join(', ')}. RLS's not core.is_read_only() does NOT ` +
        `cover a service-role connection. Decide which this is and add it to DECLARED_SERVICE_ROLE_WRITES ` +
        `with the reason: either the write is a primary request effect (add it to PRIMARY too, and register ` +
        `refuseReadOnlyWrites on every router that can reach it), or it only ever runs downstream of an ` +
        `action RLS already authorised.`
    );
  });

  test('every router that can reach a primary service-role write registers refuseReadOnlyWrites', () => {
    const routers = readdirSync(join(SRC, 'routes')).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    const guarded: string[] = [];

    for (const file of routers) {
      const rel = `routes/${file}`;
      const reachable = reachableFrom(rel);
      if (!PRIMARY.some((p) => reachable.has(p))) continue;

      const src = readFileSync(join(SRC, rel), 'utf8');
      // The hook must actually be registered, not merely imported.
      if (/addHook\(\s*'onRequest'\s*,\s*refuseReadOnlyWrites\s*\)/.test(src)) guarded.push(rel);
      else offenders.push(rel);
    }

    // Same reasoning as the positive control: if the reachability walk finds no
    // routers at all, this test is vacuous and must say so rather than pass.
    assert.ok(
      guarded.length + offenders.length > 0,
      'no router was found to reach a primary service-role write, so this assertion proved nothing — the import walk is broken'
    );
    // Exact, for the same reason as above: today the answer is
    // {routes/admin.ts, routes/jobs.ts} and nothing else. A router appearing
    // here is either a new surface that needs the hook, or a sign the
    // reachability walk has started over-reporting — both need a human, and
    // neither should be able to arrive quietly.
    assert.deepEqual(
      guarded.sort(),
      ['routes/admin.ts', 'routes/jobs.ts'],
      'the set of routers able to trigger a primary service-role write changed'
    );
    assert.deepEqual(
      offenders,
      [],
      `Router(s) ${offenders.join(', ')} can trigger a service-role write without registering ` +
        `refuseReadOnlyWrites. An account holding authority='admin' AND read_only would keep that surface ` +
        `in full while every screen told it it could change nothing. Add ` +
        `app.addHook('onRequest', refuseReadOnlyWrites) after requireAuthority — it reads req.user, so it ` +
        `must come after authenticate.`
    );
  });

  /**
   * WHY MODULE GRANULARITY IS NOT ENOUGH.
   *
   * A peer put it better than my own note did: **module-level declarations go
   * stale for exactly the reason comments do** — they record a judgement made
   * once, about a file that keeps changing. `routes/admin.ts` was
   * declared-and-reviewed; `routes/jobs.ts` was the one nobody looked at again.
   * The same shape applied to this test's own escape hatch: adding a new
   * service-role write to `lib/supabase.ts` would have stayed green, because
   * the MODULE was already declared.
   *
   * So for every module declared as infrastructure (declared, but deliberately
   * excluded from `PRIMARY`), the FUNCTIONS carrying the writes are pinned too.
   * A new exported function in such a module doing a service-role write goes red
   * regardless of which table it touches.
   */
  const INFRASTRUCTURE_WRITE_FUNCTIONS: Record<string, string[]> = {
    // Both write core tables as the service role by design, regardless of
    // caller, downstream of an action RLS has already gated.
    'lib/supabase.ts': ['enqueueNotification', 'writeAudit'],
  };

  test('infrastructure modules write from exactly the functions we reviewed', () => {
    const writes = serviceRoleWrites();
    for (const [rel, expected] of Object.entries(INFRASTRUCTURE_WRITE_FUNCTIONS)) {
      const actual = [...(writes.get(rel) ?? new Set<string>())].sort();
      assert.deepEqual(
        actual,
        [...expected].sort(),
        `A service-role write appeared in ${rel} from a function we have not classified. ` +
          `Decide which it is: infrastructure like its neighbours (runs as the service role by design ` +
          `regardless of caller, downstream of an action RLS already authorised) — in which case add it ` +
          `here — or a primary request effect, in which case ${rel} belongs in PRIMARY and every router ` +
          `that can reach it needs refuseReadOnlyWrites.`
      );
    }
  });

  test('a read-only service-role helper is not counted as a write — function-level negative control', () => {
    // `loadAuthUser` binds `serviceClient()` in the same module and only reads.
    // If it ever shows up as a write, the tail check has stopped distinguishing
    // verbs and every set above is suspect.
    const fns = serviceRoleWrites().get('lib/supabase.ts') ?? new Set<string>();
    assert.ok(!fns.has('loadAuthUser'), 'loadAuthUser only reads — the write-verb check has broken');
    assert.ok(!fns.has('<module scope>'), 'a service-role write was attributed to module scope; enclosingExport failed to resolve it');
  });

  test('routes/jobs.ts specifically is guarded — the instance this test exists for', () => {
    const src = readFileSync(join(SRC, 'routes/jobs.ts'), 'utf8');
    assert.match(src, /addHook\(\s*'onRequest'\s*,\s*refuseReadOnlyWrites\s*\)/);
    // Order matters: the hook reads `req.user.readOnly`, so registered before
    // `authenticate` it would throw on undefined instead of refusing.
    assert.ok(
      src.indexOf("addHook('onRequest', authenticate)") < src.indexOf("addHook('onRequest', refuseReadOnlyWrites)"),
      'refuseReadOnlyWrites must be registered after authenticate — it reads req.user'
    );
  });
});
