-- =====================================================================
-- LRA Ops :: bootstrap Chan's admin account
--
-- The rebuild (000_drop_legacy_hr) deliberately does not touch
-- `auth.users`, so Chan's one login survives the drop -- but `core.users`
-- is a brand-new, empty table. Without this migration nobody has a
-- `core.users` row at all, which means the auth middleware's profile
-- lookup fails for every caller including Chan, and the admin-only
-- provisioning route in Phase 2 (`requireAuthority('admin')`) can never
-- be reached by anyone. This migration exists to break that
-- chicken-and-egg: it links the one pre-existing `auth.users` row to a
-- `core.people` + `core.users` row with `authority = 'admin'`, keyed on
-- email so it works identically against the linked production project
-- (where the row exists) and a fresh local `supabase start` (where it
-- matches nothing and is a safe no-op).
--
-- Idempotent: safe to re-run, matches PLAN.md Phase 2's "re-running
-- finds the existing row and repairs what's missing" rule.
-- =====================================================================

do $$
declare
  v_auth_id uuid;
  v_person_id uuid;
begin
  select id into v_auth_id from auth.users where email = 'chanabayabay@gmail.com';

  if v_auth_id is null then
    -- Fresh local stack: no such auth user. Nothing to bootstrap.
    return;
  end if;

  insert into core.people (person_code, first_name, last_name, display_name, email)
  values ('LRA-001', 'Chan', 'Abay-abay', 'Chan', 'chanabayabay@gmail.com')
  on conflict (email) do nothing
  returning id into v_person_id;

  if v_person_id is null then
    select id into v_person_id from core.people where email = 'chanabayabay@gmail.com';
  end if;

  insert into core.users (id, email, authority, person_id)
  values (v_auth_id, 'chanabayabay@gmail.com', 'admin', v_person_id)
  on conflict (id) do update
    set person_id = excluded.person_id
    where core.users.person_id is null;

  insert into core.memberships (user_id, module, position)
  values (v_auth_id, 'ops', 'other')
  on conflict (user_id, module) do nothing;
end $$;
