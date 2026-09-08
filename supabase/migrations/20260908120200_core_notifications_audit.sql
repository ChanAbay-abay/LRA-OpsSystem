-- =====================================================================
-- LRA Ops :: core — notifications, outbox, audit
--
-- The forgeable-inbox defect is designed out here, not patched later.
-- HR shipped `create policy notifications_insert ... with check (true)`,
-- so any authenticated user could put a message, with a link, in
-- anyone's inbox. In an accountability system a spoofable "the founder
-- approved your points" is a product defect, not a nuisance. There is
-- therefore no INSERT policy for `authenticated` on core.notifications
-- at all in this migration or the RLS migration that follows it --
-- notifications originate only from the outbox drain, running on the
-- service client.
-- =====================================================================

create table core.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references core.users(id) on delete cascade,
  title       text not null,
  message     text not null,
  entity_type text,          -- 'ops.task', 'ops.block', later 'quote'
  entity_id   uuid,
  link        text,
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index idx_core_notifications_user
  on core.notifications(user_id, is_read, created_at desc);

-- Only `is_read` may be changed by the row owner, and only their own
-- row. Enforced here by trigger; the RLS WITH CHECK re-states the
-- ownership half so the two layers agree.
create or replace function core.guard_notification_is_read_only()
returns trigger
language plpgsql
security definer
set search_path = core, public
as $$
begin
  if core.is_system_caller() or core.is_admin() then
    return new;
  end if;

  if new.user_id is distinct from old.user_id
     or new.title is distinct from old.title
     or new.message is distinct from old.message
     or new.entity_type is distinct from old.entity_type
     or new.entity_id is distinct from old.entity_id
     or new.link is distinct from old.link
     or new.created_at is distinct from old.created_at then
    raise exception 'only is_read may be changed on a notification'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger trg_guard_notification_is_read_only
  before update on core.notifications
  for each row execute function core.guard_notification_is_read_only();

-- ---------------------------------------------------------------------
-- Outbox — delivery is abstracted from day one. In-app only in the MVP;
-- the drainer reads pending + in_app and inserts into core.notifications.
-- Email or WhatsApp later is a second drainer against this same table
-- with no call site touched.
-- ---------------------------------------------------------------------

create type core.outbox_channel as enum ('in_app', 'email', 'whatsapp');
create type core.outbox_state   as enum ('pending', 'sent', 'failed', 'skipped');

create table core.notification_outbox (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references core.users(id) on delete cascade,
  module       core.module not null,
  event_type   text not null,        -- 'ops.task.submitted', 'ops.block.opened'
  entity_type  text not null,
  entity_id    uuid,
  title        text not null,
  body         text not null,
  link         text,
  payload      jsonb not null default '{}'::jsonb,
  channel      core.outbox_channel not null default 'in_app',
  state        core.outbox_state not null default 'pending',
  attempts     int not null default 0,
  last_error   text,
  available_at timestamptz not null default now(),
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index idx_core_outbox_pending
  on core.notification_outbox(channel, available_at) where state = 'pending';

-- ---------------------------------------------------------------------
-- Audit — append-only even to the service role. Not even the admin
-- account can rewrite history through any path.
-- ---------------------------------------------------------------------

create table core.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references core.users(id) on delete set null,
  actor_email text,
  actor_authority core.authority,
  module      core.module,
  action      text not null,
  entity_type text not null,     -- 'ops.task'; later 'quote', unprefixed on purpose
  entity_id   uuid,
  old_values  jsonb,
  new_values  jsonb,
  ip_address  inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index idx_core_audit_entity on core.audit_logs(entity_type, entity_id, created_at);
create index idx_core_audit_actor  on core.audit_logs(actor_id, created_at desc);

create or replace function core.forbid_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'core.audit_logs is append-only; % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

create trigger trg_forbid_audit_update
  before update on core.audit_logs
  for each row execute function core.forbid_audit_mutation();

create trigger trg_forbid_audit_delete
  before delete on core.audit_logs
  for each row execute function core.forbid_audit_mutation();

-- Read policy each module extends: the actor, or the entity owner, may
-- read a timeline row. Ops's branch (a task's owner may read its
-- timeline) is added in the ops RLS migration via `create or replace`.
-- Oversight always reads everything -- see the RLS migration.
create or replace function core.can_read_audit(p_entity_type text, p_entity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = core, public
as $$
  select core.is_oversight();
$$;
