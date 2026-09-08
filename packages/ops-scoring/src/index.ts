/**
 * LRA Ops :: @lra/ops-scoring — pure math, no database.
 *
 * Mirrors `packages/payroll` in LRA-HR: numbers that matter live where
 * they can be tested without a network. Phase 1 ships the week math
 * only; the recurring cap, reliability formula and cycle-time helpers
 * arrive in Phases 5 and 8 alongside their consumers.
 */

export * from './weeks.js';
