-- =====================================================================
-- LRA Ops :: seed the task catalog — DRAFT, unpriced, by design
--
-- ~15 real brokerage/sales/logistics/admin/management types, grounded in
-- what LRA actually does (PLAN.md §7 Phase 3 step 2). Every
-- `guideline_note` starts `DRAFT —` and `default_points` is NULL for
-- every row: ranking the value of LRA's own work is the founder's
-- judgement about his own business, and an agent proposing numbers would
-- launder a guess into company policy (OPEN-QUESTIONS.md #3). The
-- founder pricing this catalog is a Phase 6 gate, not built in this
-- phase.
--
-- Six of the fifteen are recurring (a matching `ops.recurring_templates`
-- row, keyed on `core.position`, follows each). Adding a position later
-- is `alter type core.position add value 'x'` plus one INSERT here — no
-- code change, per Chan's ask that this stay additive.
-- =====================================================================

insert into ops.task_types (name, category, guideline_note, is_recurring) values
  -- Brokerage
  ('Prepare and file import entry', 'Brokerage',
   'DRAFT — filing a complete, accurate import entry with BOC for one shipment. Founder to price against how much revenue/risk one entry represents.',
   false),
  ('BOC clearance follow-up', 'Brokerage',
   'DRAFT — actively chasing a submitted entry through Bureau of Customs clearance until release. Founder to price relative to filing itself.',
   false),
  ('Tariff classification for a new commodity', 'Brokerage',
   'DRAFT — researching and assigning the correct HS code for a commodity LRA has not classified before. Founder to weigh the compliance risk of getting this wrong.',
   false),
  ('Resolve a hold or discrepancy', 'Brokerage',
   'DRAFT — clearing a BOC hold, alert or documentary discrepancy that is stopping a shipment''s release. Founder to price against how disruptive an unresolved hold is.',
   false),
  ('Daily shipment status update to clients', 'Brokerage',
   'DRAFT — the recurring daily status message to clients with active shipments. Founder to price as routine/maintenance work.',
   true),

  -- Sales
  ('Quotation turnaround within SLA', 'Sales',
   'DRAFT — producing and sending a quotation to a prospect within the company''s target turnaround time. Founder to price against how often a slow quote loses the deal.',
   false),
  ('Convert a website "Free Quotation" lead', 'Sales',
   'DRAFT — following an inbound web lead through to a sent quotation. Founder to price relative to a cold-outreach quote.',
   false),
  ('Client follow-up', 'Sales',
   'DRAFT — the recurring check-in with an existing client to keep the relationship warm. Founder to price as routine/maintenance work.',
   true),
  ('Land a new account', 'Sales',
   'DRAFT — closing a genuinely new client account, not a repeat shipment from an existing one. Founder to price this as the highest-value sales outcome it is.',
   false),

  -- Logistics
  ('Arrange trucking for a released shipment', 'Logistics',
   'DRAFT — booking and confirming trucking for a shipment that has cleared BOC. Founder to price against how time-sensitive release-to-pickup is.',
   false),
  ('Warehousing coordination', 'Logistics',
   'DRAFT — coordinating storage for a shipment awaiting further processing or pickup. Founder to price against typical dwell-time risk.',
   false),

  -- Admin
  ('Statutory/accreditation filing', 'Admin',
   'DRAFT — the recurring filing that keeps LRA''s brokerage accreditation and statutory obligations current. Founder to price against the cost of lapsing.',
   true),
  ('Weekly billing and collection', 'Admin',
   'DRAFT — the recurring weekly billing run and collections follow-up. Founder to price as routine/maintenance work.',
   true),

  -- Management
  ('Run the Monday briefing', 'Management',
   'DRAFT — preparing and running the week''s briefing meeting end to end. Founder to price against how much the whole system depends on this happening well.',
   true),
  ('Clear the approval queue within 24h', 'Management',
   'DRAFT — GM/founder keeping the verification/approval queue from going stale. Founder to price against the cost of a slow approver, which PRD §3.5 already names as a real problem.',
   true);

-- ---------------------------------------------------------------------
-- Recurring templates — one per recurring type, keyed on the position
-- that owns it. `ops.generate_recurring_tasks()` (Phase 5) reads these
-- and the live `core.position` membership list; it does not switch on a
-- hardcoded position, so a sixteenth position added later needs only a
-- new template row here, never a code change.
-- ---------------------------------------------------------------------
insert into ops.recurring_templates (position, task_type_id, title, description)
select 'broker', id, 'Daily shipment status update to clients',
  'Send today''s status update to every client with an active shipment.'
from ops.task_types where name = 'Daily shipment status update to clients';

insert into ops.recurring_templates (position, task_type_id, title, description)
select 'sales', id, 'Client follow-up round',
  'Check in with existing clients this week.'
from ops.task_types where name = 'Client follow-up';

insert into ops.recurring_templates (position, task_type_id, title, description)
select 'accounting', id, 'Statutory/accreditation filing',
  'Confirm this week''s statutory and accreditation filings are current.'
from ops.task_types where name = 'Statutory/accreditation filing';

insert into ops.recurring_templates (position, task_type_id, title, description)
select 'accounting', id, 'Weekly billing and collection run',
  'Run this week''s billing and follow up on outstanding collections.'
from ops.task_types where name = 'Weekly billing and collection';

insert into ops.recurring_templates (position, task_type_id, title, description)
select 'gm', id, 'Run the Monday briefing',
  'Prepare and run this week''s Monday briefing.'
from ops.task_types where name = 'Run the Monday briefing';

insert into ops.recurring_templates (position, task_type_id, title, description)
select 'founder', id, 'Clear the approval queue',
  'Keep the verification/approval queue from going stale this week.'
from ops.task_types where name = 'Clear the approval queue within 24h';
