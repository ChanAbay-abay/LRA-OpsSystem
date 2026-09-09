# Provisioning — accounts, read-only founders, and the fallback

`POST /api/admin/users` uses `inviteUserByEmail` as its primary path (PLAN.md Phase 2,
locked in `OPEN-QUESTIONS.md` #9). No credential ever passes through this system, an
agent, or a chat log — Supabase Auth sends the invite email directly and the user sets
their own password on `/set-password` on first login.

## The three founder accounts (OPEN-QUESTIONS.md #5)

Chan, 2026-09-09: **three founder accounts, but only one of them can act.**

| Account | `authority` | `is_clearing_founder` | `read_only` | Can do |
|---|---|---|---|---|
| **LRA** | `founder` | `true` | `false` | Everything a founder can — verify, clear, override points, run/close the briefing. `ops.enforce_task_transition()` requires `core.is_clearing_founder()` specifically for `verified → cleared`, so this is the seat that actually clears work. |
| **ERC** | `founder` | `false` | `true` | **Strictly read-only.** Sees everything oversight sees — the board, queue, scoreboard, points, briefing — and can change nothing. Every write path refuses a `read_only` account before it checks anything else. |
| **DCA** | `founder` | `false` | `true` | Same shape as ERC. |
| Chan's admin account | `admin` | n/a (`core.is_clearing_founder()` is true for any admin) | `false` | Everything, including provisioning itself. |

`read_only` and `is_clearing_founder` are independent columns on `core.users` — a
founder can be neither, either, or (nonsensically, but not enforced against) both. ERC
and DCA are `authority = 'founder'`, not a fourth authority value, because their *read*
scope is identical to a founder's; only the write half differs, and that is exactly what
`read_only` exists to express (`OPEN-QUESTIONS.md` #5, `supabase/migrations/`
`20260910120100_core_read_only_accounts.sql`).

**The database is the real guard, not this app.** `core.is_read_only()` is checked as the
first statement of every write-path RLS policy and every `security definer`
trigger/RPC across `core` and `ops`, ahead of the admin/system bypass — a read-only
founder's own authority would otherwise sail through most of those checks. The API and
UI below only get the flag onto the right row; they do not enforce anything themselves.

### Setting `read_only`

- **At invite time** — `POST /api/admin/users` accepts `readOnly` (boolean, default
  `false`) alongside `email`/`firstName`/`lastName`/`authority`/`position`. In
  `/admin/users`, the invite dialog shows a "Read-only (ERC / DCA)" checkbox whenever
  `authority = founder` is selected.
- **After the fact** — `PATCH /api/admin/users/:id` accepts `readOnly` (boolean). In
  `/admin/users`, each row has a "Make read-only" / "Yes — remove" toggle next to
  Clearing founder, gated behind a confirm dialog either direction — this is a
  permission change on the highest-privilege class of account in the platform and must
  never be a stray click.
- Both paths write `core.audit_logs` (`admin.users.invite` / `admin.users.repair` /
  `admin.users.patch`) with `readOnly` in `new_values`. Creating or modifying a founder
  is the highest-privilege action here and must never be silent.
- A read-only account is visually distinguishable in `/admin/users` at a glance: an
  info-toned "Read-only" badge sits directly next to Authority in the table, not tucked
  into a column someone has to go looking for. An observer who looks like a full founder
  is the failure mode this exists to prevent.

**Still needed from Chan, per `OPEN-QUESTIONS.md` #5:** the actual email addresses for
the ERC and DCA accounts, and whether the LRA founder account is his father's or a
shared brokerage inbox. Nothing above requires those answers to be built; it does
require them to actually provision the two accounts.

## The invite email's `redirectTo`

`inviteUserByEmail` is called with
`{ redirectTo: '<web app base url>/set-password' }`. Without it, the link in the invite
email drops the user on the Supabase project's default Site URL, not this app, and
`/set-password` (the screen that actually turns the link's token into a session and
collects a new password) never runs.

The base URL is **not hardcoded** — `apps/api/src/lib/env.ts`'s `webAppUrl()` reads
`WEB_APP_URL` if set, otherwise falls back to the first entry of `CORS_ORIGIN` (which is
already the web app's dev origin, `http://localhost:5173`), otherwise
`http://localhost:5173`. Set `WEB_APP_URL` explicitly in `apps/api/.env` for any
deployment where `CORS_ORIGIN` lists more than one origin, so the two don't have to
silently agree.

**Chan's step, not this codebase's:** the Supabase project's Auth settings (Dashboard →
Authentication → URL Configuration → Redirect URLs) need `<web app base url>/set-password`
added to the allow-list, or Supabase will refuse the redirect regardless of what this API
sends. This has not been done as part of this change — confirm it before relying on a
real invite link working end to end.

## If invite emails do not land

**That depends on the GM, Sales, Broker and the two read-only founders each having a
working, monitored inbox** — plausible to fail in a four-person office. If an invite
genuinely does not arrive after a reasonable wait (check spam, confirm the address,
resend once from `/admin/users`), use the fallback below. It is documented, not
automated — do not build a UI shortcut for it. If it turns out invites reliably do not
land, say so and it becomes real Phase 2 work instead of a doc.

### Fallback: `auth.admin.createUser` with a one-time password

Run this from a trusted machine with the service-role key (never the anon key). It
creates the `auth.users` row directly with a temporary password that **Chan reads out to
the person in person or over a call he initiated** — never emailed, never put in a
ticket or a chat log, because a temporary password sent over the same channel as
everything else is just a credential with extra steps.

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

Then call `POST /api/admin/users` with the same email, first name, last name,
`authority`, `position` and (for ERC/DCA) `readOnly: true` **as normal** — the route is
idempotent on email: it will find the `auth.users` row just created and attach
`core.people` / `core.users` / `core.memberships` to it instead of trying to invite
again.

The user must change the temporary password on first login. Supabase does not enforce
this automatically; until a forced-password-change flow exists, tell them to do it
manually and confirm they did before treating provisioning as complete for that person.

### SQL fallback (last resort, admin/system access only)

If even `auth.admin.createUser` cannot run (e.g. debugging directly against the
database), the equivalent manual repair — assuming the `auth.users` row already exists
by some other means — is:

```sql
-- Run as a direct connection (migration/psql), which core.is_system_caller() treats as
-- privileged, or it will be refused by RLS exactly as intended.
insert into core.people (person_code, first_name, last_name, email)
values ('LRA-00X', 'First', 'Last', 'person@lra-example.test')
on conflict (email) do nothing;

insert into core.users (id, email, authority, person_id, read_only)
select u.id, 'person@lra-example.test', 'founder',
       (select id from core.people where email = 'person@lra-example.test'),
       true  -- false for the LRA clearing founder / staff / gm accounts
from auth.users u
where u.email = 'person@lra-example.test'
on conflict (id) do nothing;

insert into core.memberships (user_id, module, position)
select id, 'ops', 'founder' from core.users where email = 'person@lra-example.test'
on conflict (user_id, module) do nothing;
```

For the LRA clearing founder specifically, also set
`is_clearing_founder = true` on that one row (a partial unique index enforces there is
only ever one) — do this through `PATCH /api/admin/users/:id { isClearingFounder: true }`
where reachable, since only the API path writes the audit row.

Prefer the API route over hand-written SQL whenever it is reachable — it writes the
audit row (`admin.users.invite` / `admin.users.repair` / `admin.users.patch`) that this
raw SQL does not.
