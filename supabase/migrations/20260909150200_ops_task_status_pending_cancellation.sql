-- =====================================================================
-- LRA Ops :: add ops.task_status value 'pending_cancellation'
--
-- Chan: "if a task needs to be closed or cancelled the GM can flag it
-- then its to be approved by the founder with reason etc." -- gating
-- cancellation behind the same two-rung shape as submit -> verify ->
-- clear needs a state the ladder can sit in between "flagged" and
-- "actually cancelled".
--
-- `alter type ... add value` cannot be used in the same transaction
-- that later statements reference the new value (Postgres rule: a new
-- enum label is not visible to the transaction that added it). This
-- migration does ONLY the enum addition; every trigger/column change
-- that uses 'pending_cancellation' lives in the next migration file so
-- it runs in a separate transaction.
-- =====================================================================

alter type ops.task_status add value 'pending_cancellation';
