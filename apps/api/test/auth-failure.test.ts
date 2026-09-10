/**
 * LRA Global Ops :: a 401 must be Auth's verdict, never the network's
 *
 * `middleware/auth.ts` verifies every bearer token with a network call to
 * Supabase Auth. Before this test existed, ANY failure of that call --
 * including the transport never reaching Supabase -- came back as
 * `401 Invalid or expired token`. The web client signs out after two
 * consecutive 401s (`lib/auth-context.tsx`), so a few seconds of
 * unreachable auth ended a perfectly valid session and dropped the user
 * on the sign-in screen, blaming a token that was fine.
 *
 * Reproduced in a browser on 2026-09-10 against the live project: the
 * Supabase auth logs recorded no `/user` request at all for the window
 * the API was answering "Invalid or expired token", which is what showed
 * the 401 was never Auth's answer.
 *
 * The rule this pins: only an answer FROM Auth may say the token is bad.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AuthRetryableFetchError, AuthApiError } from '@supabase/supabase-js';
import { tokenCheckFailure } from '../src/middleware/auth.js';

describe('tokenCheckFailure — the network is not a verdict on the token', () => {
  test('an unreachable auth service is 503, and does not blame the token', () => {
    const err = tokenCheckFailure(new AuthRetryableFetchError('fetch failed', 0));
    assert.equal(err.statusCode, 503);
    assert.equal(err.code, 'AUTH_UNREACHABLE');
    // The sentence the user reads must not send them to re-authenticate.
    assert.match(err.message, /session is fine/i);
  });

  test('Auth answering "bad token" is still a 401', () => {
    const err = tokenCheckFailure(new AuthApiError('invalid claim', 401, 'bad_jwt'));
    assert.equal(err.statusCode, 401);
    assert.equal(err.code, 'BAD_TOKEN');
  });

  test('a valid response carrying no user is a 401, not a 503', () => {
    // `getUser` can resolve with no error and no user; that IS an answer.
    const err = tokenCheckFailure(null);
    assert.equal(err.statusCode, 401);
    assert.equal(err.code, 'BAD_TOKEN');
  });

  test('an unrecognised error is treated as a verdict, not as a retry', () => {
    // Deliberate: 503 says "your session is fine", which must never be
    // guessed. Anything we cannot positively identify as transport stays
    // a 401 the client can recover from by signing in again.
    const err = tokenCheckFailure(new Error('something else entirely'));
    assert.equal(err.statusCode, 401);
    assert.equal(err.code, 'BAD_TOKEN');
  });
});
