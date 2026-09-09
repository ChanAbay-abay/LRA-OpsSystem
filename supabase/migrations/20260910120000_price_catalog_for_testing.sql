-- =====================================================================
-- LRA Ops :: price the catalog for testing (still not the founder's
-- real answer)
--
-- Chan has not yet done the sit-down that OPEN-QUESTIONS.md #3 and
-- PLAN.md's own framing call for -- pricing the catalog is the
-- founder's judgement about his own business, and an agent guessing it
-- would launder a guess into company policy. He asked for real,
-- exercisable numbers now so commitments, the scorecard and the
-- leaderboard can be trialled while that sit-down is still pending.
--
-- Two things, on top of 20260909180000's PLACEHOLDER pass:
--
-- 1. Recurring/admin work is the price of admission, not an
--    achievement, and must sit at or above a floor of 3 points -- the
--    same framing that pass already used for most rows. Three recurring
--    types were left at 2 in that first pass; raised to 3 here.
-- 2. Every guideline_note gets an explicit sentence that this number is
--    a stand-in for testing, appended AFTER the existing text -- never
--    replacing it, and the `PLACEHOLDER —` prefix that pass wrote is
--    left completely untouched. /catalog's banner
--    (`apps/web/src/routes/catalog.tsx`, `isPlaceholder()`) keys off
--    that literal prefix via `/^(PLACEHOLDER|DRAFT)\s*—/` and must keep
--    nagging the founder until he really prices these -- removing or
--    reworking the prefix here would silently turn that banner off.
-- =====================================================================

-- 1. Recurring floor of 3.
update ops.task_types
set default_points = 3
where name in (
  'Daily shipment status update to clients',
  'Client follow-up',
  'Run the Monday briefing'
)
and default_points < 3;

-- 2. The explicit "stand-in for testing" sentence, additive and
--    idempotent -- a second run of this migration (or a future one
--    touching the same rows) will not double the sentence.
update ops.task_types
set guideline_note = guideline_note
  || ' This point value is a stand-in for testing only -- the founder has not priced this catalog yet.'
where guideline_note not like '%stand-in for testing only%';
