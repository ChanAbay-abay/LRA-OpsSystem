/**
 * LRA Global Ops :: admin corrections — payload shaping and refusals
 *
 * PLAN-ADMIN-CORRECTIONS.md. Same split as `task-edit-batches.test.ts`:
 * what is asserted here is pure and cannot be checked any other way
 * (the zod refusals that must never reach the database, `toRpcChanges`'
 * presence-vs-null distinction, and `requireAuthority('admin')` refusing
 * a non-admin token). The real gate — read-only, membership, the reason
 * floor, the whitelist, the audit row, the fall-through ladder, the
 * task-id-matched GUC — is `ops.admin_correct_task` /
 * `ops.admin_force_transition`, proved against a real Postgres in
 * `supabase/tests/rls_test.sql`'s "Admin corrections" section. A mocked
 * transaction cannot roll back and would only ever prove the mock works.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { correctTaskSchema, forceStatusSchema, toRpcChanges } from '../src/routes/tasks.js';
import { requireAuthority } from '../src/middleware/auth.js';
import type { AuthUser } from '../src/lib/domain.js';

function user(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    email: 'someone@example.invalid',
    authority: 'staff',
    personId: null,
    isActive: true,
    memberships: [],
    isClearingFounder: false,
    readOnly: false,
    ...over,
  };
}

describe('toRpcChanges — presence, never truthiness', () => {
  test('an omitted field produces no key at all', () => {
    const out = toRpcChanges({ title: 'renamed' });
    assert.deepEqual(out, { title: 'renamed' });
    assert.ok(!('description' in out), 'an unmentioned field must not appear in the correction');
  });

  test('an explicit null is preserved — clearing a field is a real, intentional change', () => {
    const out = toRpcChanges({ description: null });
    assert.ok('description' in out);
    assert.equal(out.description, null);
  });

  test('camelCase becomes the column name ops.admin_correct_task expects', () => {
    const out = toRpcChanges({
      taskTypeId: 'type-1',
      ownerUserId: 'user-1',
      clientRef: null,
      pointsOverride: 13,
      pointsOverrideReason: 'client re-scoped the shipment after it was filed',
    });
    assert.deepEqual(out, {
      task_type_id: 'type-1',
      owner_user_id: 'user-1',
      client_ref: null,
      points_override: 13,
      points_override_reason: 'client re-scoped the shipment after it was filed',
    });
  });
});

describe('correctTaskSchema — the refusals that must not reach the database', () => {
  test('a reason under 10 characters is refused', () => {
    const r = correctTaskSchema.safeParse({ reason: 'too short', changes: { title: 'renamed' } });
    assert.equal(r.success, false);
  });

  test('a whitespace-only reason of 10+ raw characters passes THIS schema — it only checks raw length', () => {
    // Documents the boundary this schema actually enforces, so nobody
    // reads a green test here as proof the trim-aware floor is covered
    // end to end — the trim happens in the database, and that assertion
    // (a whitespace-padded 9-character reason is refused) lives in
    // rls_test.sql's "Admin corrections" section, against the real
    // >= 10-trimmed-characters check ops.admin_correct_task makes.
    const r = correctTaskSchema.safeParse({ reason: '          ', changes: { title: 'renamed' } });
    assert.equal(r.success, true);
  });

  test('an empty changes object is refused — a correction must change at least one field', () => {
    const r = correctTaskSchema.safeParse({
      reason: 'a perfectly good reason here',
      changes: {},
    });
    assert.equal(r.success, false);
  });

  /**
   * The guarantee this protects: `status` and the commitment triple are
   * not merely unchecked, they are ABSENT from the schema, so a client
   * that sends `status` is refused with the key named, not silently
   * stripped — same as a bulk edit suggestion refusing `pointsOverride`.
   */
  test('status is REFUSED, not silently dropped — a transition is a separate endpoint', () => {
    const r = correctTaskSchema.safeParse({
      reason: 'trying to smuggle a status change through a correction',
      changes: { title: 'renamed', status: 'cleared' },
    });
    assert.equal(r.success, false);
  });

  test('the commitment triple is REFUSED — Chan\'s "out of scope" ruling, enforced structurally', () => {
    for (const key of ['isCommitted', 'committedWeekId', 'committedPoints', 'weekId']) {
      const r = correctTaskSchema.safeParse({
        reason: 'trying to smuggle a commitment change',
        changes: { title: 'renamed', [key]: true },
      });
      assert.equal(r.success, false, `${key} must be refused`);
    }
  });

  test('every server-derived stamp is REFUSED from this path too', () => {
    for (const key of [
      'catalogPoints',
      'gmId',
      'gmActedAt',
      'founderId',
      'founderActedAt',
      'clearedAt',
      'pointsAwarded',
      'firstInProgressAt',
    ]) {
      const r = correctTaskSchema.safeParse({
        reason: 'trying to forge a server-derived stamp',
        changes: { title: 'renamed', [key]: 'anything' },
      });
      assert.equal(r.success, false, `${key} must be refused`);
    }
  });

  test('pointsOverride with no pointsOverrideReason is refused', () => {
    const r = correctTaskSchema.safeParse({
      reason: 'client re-scoped the shipment after it was filed',
      changes: { pointsOverride: 13 },
    });
    assert.equal(r.success, false);
  });

  test('pointsOverride outside the domain (1,2,3,5,8,13,21) is refused', () => {
    const r = correctTaskSchema.safeParse({
      reason: 'client re-scoped the shipment after it was filed',
      changes: { pointsOverride: 7, pointsOverrideReason: 'not a real catalog value at all' },
    });
    assert.equal(r.success, false);
  });

  test('a valid correction parses, and an explicit null survives parsing', () => {
    const r = correctTaskSchema.safeParse({
      reason: 'client re-scoped the shipment after it was filed',
      changes: { description: null, pointsOverride: 13, pointsOverrideReason: 'client re-scoped the shipment after it was filed' },
    });
    assert.equal(r.success, true);
    assert.ok(r.success && 'description' in r.data.changes);
  });
});

describe('forceStatusSchema — the refusals that must not reach the database', () => {
  test('a reason under 10 characters is refused', () => {
    assert.equal(forceStatusSchema.safeParse({ to: 'cleared', reason: 'no' }).success, false);
  });

  test('an unknown status is refused', () => {
    assert.equal(
      forceStatusSchema.safeParse({ to: 'not-a-real-status', reason: 'a perfectly good reason' }).success,
      false
    );
  });

  test('a valid force-transition request parses', () => {
    const r = forceStatusSchema.safeParse({
      to: 'cleared',
      reason: 'client confirmed the work was already done and wants it cleared without the usual rungs',
    });
    assert.equal(r.success, true);
  });
});

describe('requireAuthority(\'admin\') — the pre-flight on both correction routes', () => {
  const reply = {} as never;

  test('a non-admin token is refused with a 403', async () => {
    const guard = requireAuthority('admin');
    await assert.rejects(
      () => guard({ user: user({ authority: 'founder' }) } as never, reply),
      (err: unknown) => {
        assert.ok(err && typeof err === 'object' && 'statusCode' in err);
        assert.equal((err as { statusCode: number }).statusCode, 403);
        return true;
      }
    );
  });

  test('staff is refused with a 403 too', async () => {
    const guard = requireAuthority('admin');
    await assert.rejects(() => guard({ user: user({ authority: 'staff' }) } as never, reply));
  });

  test('an admin token passes the pre-flight', async () => {
    const guard = requireAuthority('admin');
    await guard({ user: user({ authority: 'admin' }) } as never, reply);
  });
});
