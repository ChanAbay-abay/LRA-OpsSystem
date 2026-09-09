-- =====================================================================
-- LRA Ops :: one recurring template per position + title
--
-- Found by the tester, and it was the worst defect in this build.
-- ops.recurring_templates had NO uniqueness of any kind. POSTing an
-- exact duplicate of an existing template -- same position, same task
-- type, same title -- returned 200 and created a second row. Recurring
-- generation dedupes on (owner_user_id, week_id, recurring_template_id),
-- so two templates are two different ids and both generate: the sales
-- seat got "Client follow-up round" twice, every week, forever.
--
-- Why that is a Blocker and not a tidiness issue: points are the
-- currency this whole system runs on. A duplicated recurring template
-- credits the same work twice every single week, compounding silently
-- until somebody happens to notice the catalog looks wrong. The Monday
-- briefing, the scorecard and the leaderboard would all quietly report
-- inflated numbers, and the ledger -- being append-only by design --
-- would faithfully preserve the wrong answer.
--
-- Keyed on (position, lower(title)) among ACTIVE rows, deliberately
-- mirroring uq_ops_task_types_name. Not (position, task_type_id): a
-- position may legitimately hold two different weekly routines built on
-- the same task type, and blocking that would be a worse error than the
-- one being fixed. Two routines with the SAME NAME for the same role is
-- never right -- nobody could tell them apart on the board.
--
-- Deactivated rows are excluded so a template can be retired and a
-- replacement created under the same name.
--
-- The tester's duplicate row and the task it generated were removed
-- before this index was created; verified zero duplicates remained.
-- =====================================================================

create unique index if not exists uq_ops_recurring_templates_title
  on ops.recurring_templates (position, lower(title))
  where is_active;

comment on index ops.uq_ops_recurring_templates_title is
  'One active recurring routine per position per name. See migration 20260909210000: '
  'without this, duplicate templates silently double-generated and double-credited points every week.';
