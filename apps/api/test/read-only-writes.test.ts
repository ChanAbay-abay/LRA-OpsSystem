/**
 * LRA Global Ops :: `refuseReadOnlyWrites` — the service-role read-only guard
 *
 * This hook is the ONLY thing standing between a read-only account and the two
 * routers whose writes run as the service role (`routes/admin.ts`'s whole
 * provisioning surface, and `routes/jobs.ts`'s drain-outbox / flag-stale).
 * RLS's `not core.is_read_only()` cannot help there: it reads
 * `core.auth_user_id()`, which is null as the service role, so it returns false
 * for everyone.
 *
 * There is no seeded read-only ADMIN to prove this with end-to-end (ERC and DCA
 * are read-only *founders*, refused a step earlier by `requireAuthority('admin')`),
 * and creating one on the live project to run a test is not worth it — so the
 * hook is pinned here instead, at the level where the decision is actually made.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { refuseReadOnlyWrites } from '../src/middleware/auth.js';
import { ApiError, type AuthUser } from '../src/lib/domain.js';

function user(readOnly: boolean): AuthUser {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'someone@example.invalid',
    authority: 'admin',
    personId: null,
    isActive: true,
    memberships: [],
    isClearingFounder: false,
    readOnly,
  };
}

// Only `method` and `user` are read by the hook; the rest of FastifyRequest is
// irrelevant to it and is not faked into existence here.
function req(method: string, readOnly: boolean) {
  return { method, user: user(readOnly) } as never;
}

const reply = {} as never;

describe('refuseReadOnlyWrites', () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    test(`${method} from a read-only account is refused with a 403 and a sentence`, async () => {
      await assert.rejects(
        () => refuseReadOnlyWrites(req(method, true), reply),
        (err: unknown) => {
          assert.ok(err instanceof ApiError);
          assert.equal(err.statusCode, 403);
          assert.equal(err.code, 'READ_ONLY_ACCOUNT');
          // The message is what the person actually reads. A read-only account
          // is a legitimate account type, not an error state.
          assert.match(err.message, /read-only/i);
          return true;
        }
      );
    });
  }

  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    test(`${method} from a read-only account is allowed — read-only means "sees what oversight sees"`, async () => {
      await refuseReadOnlyWrites(req(method, true), reply);
    });
  }

  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    test(`${method} from a normal admin is untouched`, async () => {
      await refuseReadOnlyWrites(req(method, false), reply);
    });
  }
});
