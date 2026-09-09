/**
 * LRA Ops :: @lra/ops-scoring — pure math, no database.
 *
 * Mirrors `packages/payroll` in LRA-HR: numbers that matter live where
 * they can be tested without a network. Phase 8 completes the package:
 * the recurring cap, the reliability formula and cycle-time helpers
 * join the week math that shipped in Phase 1.
 */

export * from './weeks.js';
export * from './fib.js';
export * from './recurring-cap.js';
export * from './cycle-time.js';
export * from './reliability.js';
