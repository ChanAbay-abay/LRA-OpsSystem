import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIB_POINTS, isFibPoint } from '../src/fib.js';

test('every Fibonacci point value in the catalog CHECK constraint is accepted', () => {
  for (const n of FIB_POINTS) {
    assert.equal(isFibPoint(n), true, `${n} should be a legal point value`);
  }
});

test('every non-Fibonacci integer is rejected, including 0 and negatives', () => {
  const rejected = [-21, -8, -1, 0, 4, 6, 7, 9, 10, 11, 12, 14, 20, 22, 34, 100];
  for (const n of rejected) {
    assert.equal(isFibPoint(n), false, `${n} should not be a legal point value`);
  }
});
