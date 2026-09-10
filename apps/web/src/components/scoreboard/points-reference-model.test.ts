/**
 * LRA Global Ops :: points reference model unit tests
 *
 * The one thing this reference cannot get wrong (Chan's own
 * instruction): a retired type must never look like it still earns
 * points. `groupTypesByPoints` is what enforces that, so it is tested
 * directly rather than trusted by eye in the browser.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupTypesByPoints,
  isPlaceholderPricing,
  stripPricingPrefix,
  type CatalogTaskType,
} from './points-reference-model';

function type(overrides: Partial<CatalogTaskType> & { id: string; name: string }): CatalogTaskType {
  return {
    guideline_note: 'A real, priced guideline note.',
    default_points: 5,
    is_active: true,
    ...overrides,
  };
}

describe('groupTypesByPoints', () => {
  test('groups active, priced types by their point value', () => {
    const groups = groupTypesByPoints([
      type({ id: '1', name: 'Clear BOC entry', default_points: 8 }),
      type({ id: '2', name: 'File paperwork', default_points: 3 }),
      type({ id: '3', name: 'Draft invoice', default_points: 8 }),
    ]);
    assert.deepEqual(
      groups.map((g) => g.points),
      [3, 8]
    );
    assert.deepEqual(
      groups.find((g) => g.points === 8)?.types.map((t) => t.name),
      // Alphabetical within a group.
      ['Clear BOC entry', 'Draft invoice']
    );
  });

  test('drops point values nothing currently earns', () => {
    const groups = groupTypesByPoints([type({ id: '1', name: 'Only one', default_points: 13 })]);
    assert.deepEqual(
      groups.map((g) => g.points),
      [13]
    );
  });

  test('a retired type never appears, even with a real point value', () => {
    const groups = groupTypesByPoints([
      type({ id: '1', name: 'Retired work', default_points: 5, is_active: false }),
    ]);
    assert.equal(groups.length, 0);
  });

  test('an unpriced DRAFT type never appears', () => {
    const groups = groupTypesByPoints([type({ id: '1', name: 'Unpriced', default_points: null })]);
    assert.equal(groups.length, 0);
  });

  test('no active priced types -> no groups', () => {
    assert.deepEqual(groupTypesByPoints([]), []);
  });

  test('ladder order is ascending, not insertion order', () => {
    const groups = groupTypesByPoints([
      type({ id: '1', name: 'A', default_points: 21 }),
      type({ id: '2', name: 'B', default_points: 1 }),
      type({ id: '3', name: 'C', default_points: 8 }),
    ]);
    assert.deepEqual(
      groups.map((g) => g.points),
      [1, 8, 21]
    );
  });
});

describe('isPlaceholderPricing', () => {
  test('null points is always a placeholder', () => {
    assert.equal(isPlaceholderPricing({ guideline_note: 'anything', default_points: null }), true);
  });
  test('a PLACEHOLDER-prefixed note is a placeholder even with a real-looking number', () => {
    assert.equal(isPlaceholderPricing({ guideline_note: 'PLACEHOLDER — a starting guess', default_points: 8 }), true);
  });
  test('a DRAFT-prefixed note is a placeholder', () => {
    assert.equal(isPlaceholderPricing({ guideline_note: 'DRAFT — needs pricing', default_points: 3 }), true);
  });
  test('a genuinely priced type is not a placeholder', () => {
    assert.equal(isPlaceholderPricing({ guideline_note: 'Clear a standard BOC entry.', default_points: 8 }), false);
  });
});

describe('stripPricingPrefix', () => {
  test('strips PLACEHOLDER —', () => {
    assert.equal(stripPricingPrefix('PLACEHOLDER — a starting guess'), 'a starting guess');
  });
  test('strips DRAFT —', () => {
    assert.equal(stripPricingPrefix('DRAFT — needs pricing'), 'needs pricing');
  });
  test('leaves a real note untouched', () => {
    assert.equal(stripPricingPrefix('Clear a standard BOC entry.'), 'Clear a standard BOC entry.');
  });
});
