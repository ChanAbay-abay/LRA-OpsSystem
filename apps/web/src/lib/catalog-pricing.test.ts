import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { isPlaceholderPricing, stripPricingPrefix } from './catalog-pricing';

describe('catalog pricing markers', () => {
  test('strips a DOUBLED marker — the case live data actually has', () => {
    // 14 of 15 active types read exactly this shape. The old single-pass
    // regex left "DRAFT — " behind, which reached a tooltip and, worse,
    // pre-filled the catalog edit dialog.
    assert.equal(
      stripPricingPrefix('PLACEHOLDER — DRAFT — actively chasing a submitted entry'),
      'actively chasing a submitted entry'
    );
  });

  test('strips either marker alone, in either order', () => {
    assert.equal(stripPricingPrefix('PLACEHOLDER — a note'), 'a note');
    assert.equal(stripPricingPrefix('DRAFT — a note'), 'a note');
    assert.equal(stripPricingPrefix('DRAFT — PLACEHOLDER — a note'), 'a note');
  });

  test('is idempotent — stripping a clean note changes nothing', () => {
    assert.equal(stripPricingPrefix('a clean note'), 'a clean note');
    assert.equal(stripPricingPrefix(stripPricingPrefix('PLACEHOLDER — DRAFT — x')), 'x');
  });

  test('does not eat a legitimate note that merely mentions the word', () => {
    // Only a LEADING marker is a marker.
    assert.equal(
      stripPricingPrefix('use the DRAFT — bill of lading — when it arrives'),
      'use the DRAFT — bill of lading — when it arrives'
    );
  });

  test('an unpriced type is placeholder-priced even with a clean note', () => {
    assert.equal(isPlaceholderPricing({ default_points: null, guideline_note: 'clean' }), true);
  });

  test('a priced type with a marker is still placeholder-priced', () => {
    assert.equal(isPlaceholderPricing({ default_points: 8, guideline_note: 'PLACEHOLDER — DRAFT — x' }), true);
  });

  test('a priced type with a clean note is settled', () => {
    assert.equal(isPlaceholderPricing({ default_points: 8, guideline_note: 'clean' }), false);
  });

  test('a missing note does not throw', () => {
    assert.equal(stripPricingPrefix(undefined as unknown as string), '');
  });
});
