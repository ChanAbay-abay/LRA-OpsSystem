# Provisioning fallback — if invite emails do not land

`POST /api/admin/users` uses `inviteUserByEmail` as its only path (PLAN.md Phase 2, locked
in `OPEN-QUESTIONS.md` #9). No credential ever passes through this system, an agent, or a
chat log — Supabase Auth sends the invite email directly and the user sets their own
password on first login.

**That depends on the GM, Sales and Broker each having a working, monitored inbox** — a
plausible failure in a four-person office. If an invite genuinely does not arrive after a
reasonable wait (check spam, confirm the address, resend once from `/admin/users`), use
this fallback. It is documented, not automated — do not build a UI shortcut for it. If it
turns out invites reliably do not land, say so and it becomes real Phase 2 work instead of
a doc.

## Fallback: `auth.admin.createUser` with a one-time password

Run this from a trusted machine with the service-role key (never the anon key). It creates
the `auth.users` row directly with a temporary password that **Chan reads out to the
person in person or over a call he initiated** — never emailed, never put in a ticket or a
chat log, because a temporary password sent over the same channel as everything else is
just a credential with extra steps.

```js
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const tempPassword = crypto.randomUUID(); // read this out once, then discard it

const { data, error } = await db.auth.admin.createUser({
  email: 'person@lra-example.test',
  password: tempPassword,
  email_confirm: true, // they didn't click a confirmation link, so mark it confirmed
});
if (error) throw error;

console.log('auth user id:', data.user.id);
console.log('temporary password (read this out, then forget it):', tempPassword);
```

Then call `POST /api/admin/users` with the same email, first name, last name, authority
and position **as normal** — the route is idempotent on email (PLAN.md Phase 2 step 1): it
will find the `auth.users` row just created and attach `core.people` / `core.users` /
`core.memberships` to it instead of trying to invite again.

The user must change the temporary password on first login. Supabase does not enforce
this automatically; until a forced-password-change flow exists, tell them to do it
manually and confirm they did before treating provisioning as complete for that person.

## SQL fallback (last resort, admin/system access only)

If even `auth.admin.createUser` cannot run (e.g. debugging directly against the database),
the equivalent manual repair — assuming the `auth.users` row already exists by some other
means — is:

```sql
-- Run as a direct connection (migration/psql), which core.is_system_caller() treats as
-- privileged, or it will be refused by RLS exactly as intended.
insert into core.people (person_code, first_name, last_name, email)
values ('LRA-00X', 'First', 'Last', 'person@lra-example.test')
on conflict (email) do nothing;

insert into core.users (id, email, authority, person_id)
select u.id, 'person@lra-example.test', 'staff',
       (select id from core.people where email = 'person@lra-example.test')
from auth.users u
where u.email = 'person@lra-example.test'
on conflict (id) do nothing;

insert into core.memberships (user_id, module, position)
select id, 'ops', 'sales' from core.users where email = 'person@lra-example.test'
on conflict (user_id, module) do nothing;
```

Prefer the API route over hand-written SQL whenever it is reachable — it writes the audit
row (`admin.users.invite` / `admin.users.repair`) that this raw SQL does not.
