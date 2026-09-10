/**
 * LRA Global Ops :: /api/tasks routing — the shadowing hazard
 *
 * `GET /api/tasks/:id` (added 2026-09-10 so the Now screen can open the
 * board's task detail modal) sits alongside the literal
 * `GET /api/tasks/board` and `GET /api/tasks/open`. Fastify's router
 * prefers a static segment over a parametric one, so `/board` cannot be
 * swallowed — but that is a guarantee made by a dependency, and a
 * dependency upgrade is exactly the kind of thing that would break it
 * silently, with the symptom being "the board is empty" rather than
 * "routing changed".
 *
 * So this asserts it against the REAL router in the REAL server, not by
 * reading the registration order. `findRoute` returns the matched
 * route's params: `{}` means the static handler won, `{ id: 'board' }`
 * means the parametric one did and the board is broken. The last test
 * proves this assertion can actually go red, by building the same pair
 * of routes with the static one missing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { buildServer } from '../src/server.js';

describe('/api/tasks route resolution', () => {
  test('GET /api/tasks/board still resolves to the literal board route, not to /:id', async () => {
    const app = buildServer();
    await app.ready();
    const match = app.findRoute({ method: 'GET', url: '/api/tasks/board' });
    assert.ok(match, '/api/tasks/board must resolve to something');
    // `params` comes back with a null prototype, so it is spread into a
    // plain object before comparison -- deepStrictEqual compares
    // prototypes too.
    assert.deepEqual({ ...match.params }, {}, 'a params-carrying match means /:id swallowed the board');
    await app.close();
  });

  test('GET /api/tasks/:id resolves to the parametric route for a real uuid', async () => {
    const app = buildServer();
    await app.ready();
    const match = app.findRoute({ method: 'GET', url: '/api/tasks/1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718' });
    assert.ok(match);
    assert.equal(match.params.id, '1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718');
    await app.close();
  });

  test('the nested literal routes under /:id are untouched', async () => {
    const app = buildServer();
    await app.ready();
    const id = '1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718';
    for (const url of [`/api/tasks/${id}/notes`, `/api/tasks/${id}/blocks`]) {
      const match = app.findRoute({ method: 'GET', url });
      assert.ok(match, `${url} must still resolve`);
      assert.equal(match.params.id, id);
    }
    // /api/blocks/open is a different plugin and must not be confused
    // with a task id either.
    assert.deepEqual({ ...app.findRoute({ method: 'GET', url: '/api/blocks/open' })?.params }, {});
    await app.close();
  });

  test('GET /api/tasks/:id is auth-gated like every other route in the plugin', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/tasks/1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'NO_TOKEN');
    await app.close();
  });

  test('the shadowing assertion above can actually fail — with no static route, /board matches /:id', async () => {
    const control = Fastify();
    control.register(
      async (scope) => {
        scope.get('/:id', async () => ({ data: null }));
      },
      { prefix: '/api/tasks' }
    );
    await control.ready();
    const match = control.findRoute({ method: 'GET', url: '/api/tasks/board' });
    assert.deepEqual({ ...match?.params }, { id: 'board' });
    await control.close();
  });
});
