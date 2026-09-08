/**
 * LRA Global Ops :: domain helper tests
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isOversight, isFounder, isAdmin, hasMembership, type AuthUser } from '../src/lib/domain.js';

describe('authority predicates', () => {
  test('gm, founder and admin are oversight; staff is not', () => {
    assert.equal(isOversight('staff'), false);
    assert.equal(isOversight('gm'), true);
    assert.equal(isOversight('founder'), true);
    assert.equal(isOversight('admin'), true);
  });

  test('founder and admin pass isFounder; gm and staff do not', () => {
    assert.equal(isFounder('founder'), true);
    assert.equal(isFounder('admin'), true);
    assert.equal(isFounder('gm'), false);
    assert.equal(isFounder('staff'), false);
  });

  test('only admin passes isAdmin', () => {
    assert.equal(isAdmin('admin'), true);
    assert.equal(isAdmin('founder'), false);
  });
});

describe('hasMembership', () => {
  const staffWithOps: AuthUser = {
    id: 'u1',
    email: 'staff@lra.test',
    authority: 'staff',
    personId: 'p1',
    isActive: true,
    memberships: [{ module: 'ops', position: 'sales', isActive: true }],
  };

  test('a staff member with an active ops membership counts as a member', () => {
    assert.equal(hasMembership(staffWithOps, 'ops'), true);
  });

  test('a staff member has no hr membership just because they have ops', () => {
    assert.equal(hasMembership(staffWithOps, 'hr'), false);
  });

  test('an inactive membership does not count', () => {
    const inactive: AuthUser = {
      ...staffWithOps,
      memberships: [{ module: 'ops', position: 'sales', isActive: false }],
    };
    assert.equal(hasMembership(inactive, 'ops'), false);
  });

  test('admin counts as a member of every module without an explicit row', () => {
    const admin: AuthUser = {
      id: 'u2',
      email: 'admin@lra.test',
      authority: 'admin',
      personId: null,
      isActive: true,
      memberships: [],
    };
    assert.equal(hasMembership(admin, 'ops'), true);
    assert.equal(hasMembership(admin, 'hr'), true);
  });
});
