/**
 * The route gate decides who sees what, so it is tested like the rest of
 * the permission surface. Two separate defect classes are pinned here:
 *
 *   1. authority routing — who is redirected home from which route;
 *   2. the loading/failure distinction — the bug that left `/queue` and
 *      `/digest` on the shell skeleton indefinitely with the API down,
 *      reproduced past 20 seconds before it was fixed.
 *
 * The second is the reason this is a pure function at all: inside a
 * component reading a context there is nothing to call, and the state
 * that broke ("signed in, not loading, no profile, and none coming")
 * is precisely the one nobody thinks to click through by hand.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeGate, type GateState } from './route-gate';

const state = (over: Partial<GateState> = {}): GateState => ({
  loading: false,
  hasSession: true,
  authority: 'staff',
  meError: null,
  ...over,
});

const GATED = { requireOversight: true } as const;

// ---------------------------------------------------------------------
// The bug this function exists for
// ---------------------------------------------------------------------

test('a gated route reports a failed profile load instead of loading forever', () => {
  const d = routeGate(state({ authority: null, meError: 'Could not reach the server.' }), GATED);
  assert.equal(d.kind, 'error');
  assert.equal(d.kind === 'error' && d.message, 'Could not reach the server.');
});

test('the failure is checked BEFORE the still-in-flight skeleton', () => {
  // Both conditions hold at once — no profile AND a recorded failure —
  // which is exactly the state the API being down produces. If the
  // skeleton branch were to win here, the route hangs forever again.
  const d = routeGate(state({ loading: false, authority: null, meError: 'down' }), GATED);
  assert.notEqual(d.kind, 'skeleton');
  assert.equal(d.kind, 'error');
});

test('no profile YET, with no error, is still the skeleton — not an error, not a redirect', () => {
  // The honest answer for the beat after the session settles. Redirecting
  // here would bounce a legitimate GM off their own screen on every load.
  assert.equal(routeGate(state({ authority: null }), GATED).kind, 'skeleton');
});

test('an ungated route is NOT taken over by a profile failure', () => {
  // It never needed the profile to decide anything, and its own
  // useResource already shows a Retry panel for the thing the visitor
  // actually came for. Reporting the profile's failure over the top of
  // that would be a wider change than the defect called for.
  assert.equal(routeGate(state({ authority: null, meError: 'down' })).kind, 'render');
});

// ---------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------

test('a bootstrapping session is the skeleton, whatever else is true', () => {
  assert.equal(routeGate(state({ loading: true, hasSession: false, meError: 'down' }), GATED).kind, 'skeleton');
});

test('no session sends you to login, and a profile error never preempts that', () => {
  assert.equal(routeGate(state({ hasSession: false, authority: null, meError: 'down' }), GATED).kind, 'login');
});

// ---------------------------------------------------------------------
// Authority routing, one assertion per rung
// ---------------------------------------------------------------------

test('requireAdmin admits admin alone', () => {
  assert.equal(routeGate(state({ authority: 'admin' }), { requireAdmin: true }).kind, 'render');
  for (const a of ['founder', 'gm', 'staff'] as const) {
    assert.equal(routeGate(state({ authority: a }), { requireAdmin: true }).kind, 'home', a);
  }
});

test('requireOversight admits gm, founder and admin', () => {
  for (const a of ['gm', 'founder', 'admin'] as const) {
    assert.equal(routeGate(state({ authority: a }), { requireOversight: true }).kind, 'render', a);
  }
  assert.equal(routeGate(state({ authority: 'staff' }), { requireOversight: true }).kind, 'home');
});

test('requireFounder admits founder and admin, not gm — /admin/settings', () => {
  // The gate that used to be requireAdmin, which was stricter than both
  // settings.ts's requireAuthority('founder','admin') and ops.settings's
  // core.is_founder() RLS policy, and left a founder with no path in.
  for (const a of ['founder', 'admin'] as const) {
    assert.equal(routeGate(state({ authority: a }), { requireFounder: true }).kind, 'render', a);
  }
  for (const a of ['gm', 'staff'] as const) {
    assert.equal(routeGate(state({ authority: a }), { requireFounder: true }).kind, 'home', a);
  }
});

test('a read-only founder is routed exactly like any founder — read-only is never a routing question', () => {
  // ERC and DCA must REACH every screen oversight reaches; what they may
  // not do is write from it. That is a per-control decision, never a
  // redirect, and conflating the two is how a read-only account ends up
  // locked out of screens it is entitled to read.
  assert.equal(routeGate(state({ authority: 'founder' }), { requireOversight: true }).kind, 'render');
  assert.equal(routeGate(state({ authority: 'founder' }), { requireFounder: true }).kind, 'render');
});

test('an ungated route renders for everyone signed in', () => {
  for (const a of ['staff', 'gm', 'founder', 'admin'] as const) {
    assert.equal(routeGate(state({ authority: a })).kind, 'render', a);
  }
});
