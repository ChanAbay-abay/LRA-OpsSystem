-- =====================================================================
-- LRA Ops :: placeholder point values, and admin holds clearing rights
--
-- TWO changes, both at Chan's explicit request.
--
-- 1. PLACEHOLDER POINTS. Chan: "just give placeholders for the 15 types
--    for now." These are NOT the company's real answer -- pricing the
--    catalog is a founder decision and the guideline notes say so. They
--    exist so commitments, scorecards and the leaderboard stop reading
--    zero while the system is being trialled.
--
--    Scale: Fibonacci, capped (1,2,3,5,8,13,21). Points mean VALUE and
--    IMPACT, never effort -- otherwise the person who takes three days
--    on something easy outscores the person who closed a deal in an
--    hour. Recurring work sits low on purpose: it is the price of
--    admission, not an achievement. "Land a new account" sits at 21
--    because Chan's own framing was that closing a client must be worth
--    roughly ten outreach calls.
--
-- 2. ADMIN CLEARS TOO. Chan: "for the clearing founder, give same perms
--    for me as the admin." core.is_clearing_founder() now returns true
--    for an admin as well as the single seated founder.
--
--    This is not an escalation: an admin can already set
--    users.is_clearing_founder on any account, so an admin could grant
--    themselves this in one UPDATE. Making it explicit is the honest
--    version, and it matches the convention every other predicate here
--    already follows -- is_founder(), is_gm() and is_oversight() all
--    admit admin.
--
--    The `uq_core_users_one_clearing_founder` index is untouched: there
--    is still exactly ONE seated founder. Admin is a separate capability
--    that happens to include the same right.
-- =====================================================================

update ops.task_types set default_points = v.pts,
  guideline_note = 'PLACEHOLDER — ' || guideline_note
from (values
  -- Recurring / routine: the baseline expectation.
  ('Daily shipment status update to clients',      2),
  ('Client follow-up',                             2),
  ('Run the Monday briefing',                      2),
  ('Weekly billing and collection',                3),
  ('Clear the approval queue within 24h',          3),
  ('Statutory/accreditation filing',               5),
  -- Core operational work.
  ('BOC clearance follow-up',                      3),
  ('Arrange trucking for a released shipment',     3),
  ('Warehousing coordination',                     3),
  ('Quotation turnaround within SLA',              3),
  ('Prepare and file import entry',                5),
  ('Tariff classification for a new commodity',    5),
  -- Genuinely hard, or genuinely worth money.
  ('Resolve a hold or discrepancy',                8),
  ('Convert a website "Free Quotation" lead',      8),
  ('Land a new account',                          21)
) as v(name, pts)
where ops.task_types.name = v.name
  and ops.task_types.guideline_note not like 'PLACEHOLDER —%';

create or replace function core.is_clearing_founder()
returns boolean
language sql
stable
security definer
set search_path to 'core', 'public'
as $function$
  select core.is_admin() or coalesce(
    (select u.is_clearing_founder from core.users u where u.id = core.auth_user_id()),
    false
  );
$function$;
