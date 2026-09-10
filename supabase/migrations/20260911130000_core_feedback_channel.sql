-- =====================================================================
-- LRA Ops :: core.feedback — the suggestion/bug channel to Chan
--
-- Chan: "add a feature at the bottom left where they can leave either a
-- suggestion or bug that they found (switchable)... it just gets sent
-- to me via the inbox and i can just archive and delete stuff once its
-- okay. i just need a channel to receive reviews and comments from them
-- incase they find something that we end up missing."
--
-- Five decisions, each deliberate:
--
-- 1. STORAGE. A notification is a pointer that gets marked read; a bug
--    report is content someone typed and Chan needs to still be able
--    to read after the inbox row is gone. `core.feedback` is a real
--    table with the body, the reporter, and the page it was raised
--    from — never routed through `core.notifications` directly. The
--    page/route is captured automatically by the web client from
--    `location.pathname`, never asked for: "the user found a bug on
--    /board" is half the report if the other half is "which screen".
--
-- 2. READ: ADMIN ONLY. Chan said "sent to me", not "sent to
--    oversight". `erc-demo`/`dca-demo` are read-only founder accounts
--    for two OTHER brokerages (20260910120100_core_read_only_-
--    accounts.sql) — internal feedback about THIS product is not
--    theirs to read, so the SELECT policy is `core.is_admin()` alone,
--    deliberately narrower than the `core.is_oversight()` this project
--    uses everywhere else a founder is meant to see what admin sees.
--
-- 3. WRITE: ANY ACTIVE OPS MEMBER, INCLUDING READ-ONLY. This is a
--    considered exception to the `not core.is_read_only()` clause every
--    other write in this migration set carries ahead of its authority
--    check. Read `core.is_read_only()`'s own header
--    (20260910120100_core_read_only_accounts.sql): the guard exists to
--    stop an outside observer from CHANGING THE OPERATIONAL RECORD —
--    tasks, points, weeks, the ledger. A bug report is not that record;
--    it does not move a task, does not touch a week, does not touch a
--    point. Blocking ERC/DCA from telling Chan "your board is broken on
--    my screen" defeats the entire purpose of giving them a working
--    account, for no protective benefit — there is nothing here for a
--    read-only observer to forge that would cost the business anything
--    if it were false. So `feedback_insert` below is the one write
--    policy in this system that does NOT carry `not core.is_read_only()`,
--    and this paragraph is the record of that being a decision, not an
--    oversight, for whoever next greps this file for the clause and
--    doesn't find it.
--
-- 4. ARCHIVE VS DELETE. Archive is `status = 'archived'`, reversible.
--    Delete is a real `DELETE`, irreversible. Unlike `core.audit_logs`
--    (append-only, even to service_role) and `ops.point_ledger`,
--    `core.feedback` is NOT part of the record this product exists to
--    protect — it is a scratch channel for things staff noticed, and
--    once Chan has acted on one there is no compliance, payroll or
--    audit reason to keep it. A hard delete is therefore legitimate and
--    intentional. Do not "fix" this into append-only later by
--    pattern-matching `core.audit_logs`; it is a different kind of row
--    on purpose.
--
-- 5. THE INBOX. Delivery goes through the existing outbox
--    (`core.notification_outbox`, drained every minute by
--    `ops.drain_notification_outbox` — 20260910230000_ops_scheduled_-
--    jobs.sql) exactly like every other notification in this system.
--    No second delivery mechanism, no direct insert into
--    `core.notifications`. Every outbox row here carries `link =
--    '/admin/feedback'` — `/inbox` (routes/inbox.tsx, fixed in this
--    same session's coder pass) already renders a notification's `link`
--    and navigates on click, so a founder feedback notice is not
--    another dead end.
--
-- Content columns (kind, body, page, submitted_by/email/authority,
-- module, created_at) are immutable once written — a BEFORE UPDATE
-- trigger refuses to let even an admin rewrite what someone reported;
-- the only mutable column is `status` (plus the `archived_*` stamps
-- that go with it). Not audited to `core.audit_logs`: per point 4 this
-- is explicitly not part of the operational record, and Chan archiving
-- or deleting a stale bug report is bookkeeping, not a business event.
-- =====================================================================

create type core.feedback_kind   as enum ('suggestion', 'bug');
create type core.feedback_status as enum ('open', 'archived');

create table core.feedback (
  id                     uuid primary key default gen_random_uuid(),
  kind                   core.feedback_kind not null,
  body                   text not null,
  -- Captured automatically from the web client's own route at submit
  -- time (never a free-text field the reporter fills in) — see point 1.
  page                   text not null default '',
  module                 core.module not null default 'ops',
  -- `on delete set null`, same as `core.audit_logs.actor_id`: accounts
  -- in this system are purged 14 days after deletion
  -- (20260910130000_schedule_account_purge.sql), and a purged reporter
  -- must not silently delete their old feedback rows out from under
  -- Chan. `submitted_by_email`/`submitted_by_authority` are a point-in-
  -- time copy for exactly that reason — stamped server-side below, not
  -- client-supplied.
  submitted_by           uuid references core.users(id) on delete set null,
  submitted_by_email     text not null,
  submitted_by_authority core.authority,
  status                 core.feedback_status not null default 'open',
  archived_at            timestamptz,
  archived_by            uuid references core.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  -- Rate/abuse floor and ceiling, enforced in the database, not just the
  -- form: a one-word "bug" is not a report, and there is no legitimate
  -- reason for a multi-megabyte body pasted into a feedback box.
  constraint feedback_body_length check (char_length(btrim(body)) between 10 and 4000),
  constraint feedback_page_length check (char_length(page) <= 300)
);

create index idx_core_feedback_status      on core.feedback(status, created_at desc);
create index idx_core_feedback_submitted_by on core.feedback(submitted_by);

comment on table core.feedback is
  'The suggestion/bug channel from the app''s bottom-left affordance to '
  'Chan''s inbox. Admin-read-only (point 2), any active ops member may '
  'write including read-only founders (point 3), hard-deletable '
  '(point 4) — see this migration''s header before changing any of that.';

-- ---------------------------------------------------------------------
-- Submitter stamp — server-derived, never client-supplied, so a
-- forwarded/forged body cannot claim to be from someone else. Mirrors
-- the cancellation ladder's "stamps are derived, never client-set"
-- pattern (20260909150300_ops_cancellation_approval.sql).
-- ---------------------------------------------------------------------
create or replace function core.stamp_feedback_submitter()
returns trigger
language plpgsql
security definer
set search_path = core, public
as $$
declare
  v_email     text;
  v_authority core.authority;
begin
  -- A claimless system connection (migration, cron, service client with
  -- no user JWT) has no caller to stamp; whatever it inserted stands.
  if core.is_system_caller() then
    return new;
  end if;

  new.submitted_by := core.auth_user_id();

  select u.email, u.authority into v_email, v_authority
    from core.users u where u.id = core.auth_user_id();

  new.submitted_by_email     := coalesce(v_email, 'unknown@lra.invalid');
  new.submitted_by_authority := v_authority;

  return new;
end;
$$;

create trigger trg_stamp_feedback_submitter
  before insert on core.feedback
  for each row execute function core.stamp_feedback_submitter();

-- ---------------------------------------------------------------------
-- Content immutability — only `status`/`archived_at`/`archived_by` may
-- ever change, even for an admin. Same shape as
-- `core.guard_notification_is_read_only()` (20260908120200).
-- ---------------------------------------------------------------------
create or replace function core.guard_feedback_immutable_content()
returns trigger
language plpgsql
security definer
set search_path = core, public
as $$
begin
  if core.is_system_caller() then
    return new;
  end if;

  if new.kind is distinct from old.kind
     or new.body is distinct from old.body
     or new.page is distinct from old.page
     or new.module is distinct from old.module
     or new.submitted_by is distinct from old.submitted_by
     or new.submitted_by_email is distinct from old.submitted_by_email
     or new.submitted_by_authority is distinct from old.submitted_by_authority
     or new.created_at is distinct from old.created_at then
    raise exception 'only status, archived_at and archived_by may be changed on feedback'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger trg_guard_feedback_immutable_content
  before update on core.feedback
  for each row execute function core.guard_feedback_immutable_content();

-- ---------------------------------------------------------------------
-- Notify every active admin through the existing outbox (point 5). One
-- row per admin, same fan-out shape as the verify/approve notices in
-- 20260909150300_ops_cancellation_approval.sql.
-- ---------------------------------------------------------------------
create or replace function core.notify_feedback_submitted()
returns trigger
language plpgsql
security definer
set search_path = core, public
as $$
declare
  v_recipient record;
  v_kind_word text := case new.kind when 'bug' then 'bug' else 'suggestion' end;
begin
  for v_recipient in
    select u.id from core.users u where u.authority = 'admin' and u.is_active
  loop
    insert into core.notification_outbox
      (recipient_id, module, event_type, entity_type, entity_id, title, body, link)
    values
      (v_recipient.id, new.module, 'core.feedback.submitted', 'core.feedback', new.id,
       format('New %s from %s', v_kind_word, coalesce(new.submitted_by_email, 'someone')),
       left(new.body, 140),
       '/admin/feedback');
  end loop;

  return new;
end;
$$;

create trigger trg_notify_feedback_submitted
  after insert on core.feedback
  for each row execute function core.notify_feedback_submitted();

-- ---------------------------------------------------------------------
-- RLS — points 2, 3, 4 above, in policy form.
-- ---------------------------------------------------------------------
alter table core.feedback enable row level security;

-- Point 2: admin only. Deliberately `core.is_admin()`, not
-- `core.is_oversight()` — a GM or a non-admin founder does not read
-- Chan's inbox either.
create policy feedback_select on core.feedback for select to authenticated
using (core.is_admin());

-- Point 3: any active ops member, INCLUDING a read-only founder. No
-- `not core.is_read_only()` clause — see the migration header, point 3,
-- for why that is deliberate rather than a gap. `submitted_by =
-- core.auth_user_id()` is redundant with the BEFORE INSERT trigger
-- above (which stamps it unconditionally) but stated explicitly so the
-- policy is correct to read on its own.
create policy feedback_insert on core.feedback for insert to authenticated
with check (
  core.is_member('ops')
  and submitted_by = core.auth_user_id()
);

-- Point 4a: archiving is an admin action on Chan's own inbox, same
-- weight as every other admin write in this system — `not
-- core.is_read_only()` applies here, unlike the insert policy above.
create policy feedback_update on core.feedback for update to authenticated
using (core.is_admin() and not core.is_read_only())
with check (core.is_admin() and not core.is_read_only());

-- Point 4b: a real, hard DELETE — legitimate per the migration header.
create policy feedback_delete on core.feedback for delete to authenticated
using (core.is_admin() and not core.is_read_only());
