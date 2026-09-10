# LRA Ops Monitoring System — Implementation Plan

**Revision 2, 2026-09-08.** Supersedes revision 1 in its foundation: Chan has decided to
**drop the HR schema and rebuild the database from scratch**, knowing HR and CRM are coming.
Ops is no longer a guest in someone else's database. Everything above the foundation —
the task state machine, the points ledger, the reliability formula, the RLS discipline —
survives revision 1 largely intact.

Read `PRD.md` first; this file assumes it. `DESIGN.md` (present at the repo root, with
`design/tokens.css`) is **binding on every visual value** and this plan specifies none.
Read `OPEN-QUESTIONS.md` before Phase 2.

**Binding external context, in this order:**
1. `/Users/chanchan/Programming/CLAUDE.md` — universal process rules.
2. `/Users/chanchan/Programming/Projects/LRA-HR/docs/STATUS.md` — five rounds of security
   defects found the hard way. **The schema is being deleted; the lessons are not.** Every
   one of those defects is reproducible in a fresh database.
3. `/Users/chanchan/Programming/Projects/LRA-HR/docs/APPROVALS-MODULE.md` — binding on the
   shape of the approval-routing seam.
4. `DESIGN.md` — binding on anything visual.

Everything marked `ASSUMED:` was not confirmed.

---

## 0. The rebuild

### 0.1 What is being deleted, and why it costs nothing

A live row census was run against the project with the service role key. **47 rows total.**

| Table | Rows | Nature |
|---|---|---|
| `users` | 1 | Chan's admin account |
| `employees` | 1 | EMP-001, Chan |
| `leave_balances` | 5 | derived from that one employee |
| `leave_types` | 6 | pure seed from `003_seed.sql` |
| `statutory_rate_config` | 4 | pure seed, and **known wrong** (see §0.5) |
| `checklist_templates` / `checklist_items` | 2 / 28 | pure seed |
| **everything else** | **0** | no payroll runs, no payroll items, no payslips, no attendance, no leave requests, no loans, no certifications, no documents, no announcements, and an **empty `audit_logs`** |

**There is no transactional data to preserve. The wipe costs nothing.** Not one payroll has
been run, not one leave request filed, not one audit row written. What is being deleted is a
schema and its seed — both reproducible, neither in use.

`auth.users` holds **one** account (Chan's, `chanabayabay@gmail.com`, created 2026-09-07).
**That account must survive.** The rebuild drops `public` only. It does not touch `auth`,
`storage`, `graphql`, `extensions` or `realtime`.

Rollback artifact: `backup/pre-rebuild-snapshot.json` — a full dump of all 47 rows, written
before the drop. It is **gitignored** because it contains PII. It is the only thing standing
between us and "we deleted it and cannot say what was there," so verify it exists and parses
before running the drop, not after.

### 0.2 Foundation and modules — the architecture

The database is now ours to shape, and it is being shaped for three consumers, of which
exactly one is being built.

```
  core   ── identity, people, authority, memberships, notifications, audit history
             the layer HR and CRM will sit on
  ops    ── the only module built now: tasks, points, weeks, briefing, blockers, scores
  hr     ── designed for, not created
  crm    ── designed for, not created
```

`public` is left empty. Nothing goes in it. It exists because Postgres requires it and
because extensions land near it; treating it as "the default place things go" is precisely
the drift this structure exists to prevent.

### 0.3 Where I drew the speculative-abstraction line, and why

Chan's standing rule is *"extract to a shared location only once a second real consumer needs
it — avoid speculative abstraction."* But we **know** two more consumers are coming. Those
two facts pull in opposite directions and the resolution has to be stated, not fudged.

**The rule I applied:** build the *shape* that makes extension a data change or an additive
column; do not build a table, a column or a line of code that has zero consumers today.
Concretely, and the difference matters:

| Thing | Built now? | Why |
|---|---|---|
| `core.people` separate from `core.users` | **Yes**, but thin | A person can exist without a login (a new hire, a resigned employee). That split is agonising to retrofit — it means backfilling every FK in the system. It is a shape, not a feature, and it costs one table with six columns. |
| `core.memberships` with a `module` column | **Yes** | Ops needs a membership table regardless. The `module` column is *one enum column* on a table that has to exist anyway, and it turns "add HR" into `insert`, not `alter table`. This is the cheapest possible seam. |
| `core.people.manager_id` | **No** | Nothing in a four-person company uses a manager relation, and Ops's authority model does not have one. It is a nullable FK when HR needs it — the single cheapest thing to add later. |
| Salary, government IDs, employment type on `core.people` | **No** | Compensation is HR-module data. Putting it in `core` would mean Ops's RLS has to defend payroll columns it never reads. It goes in `hr.employment` when HR is built. |
| `core.notifications` + `core.notification_outbox` | **Yes** | Ops needs both today. They are generic by nature and any module-specific version would be a duplicate. |
| `core.audit_logs` | **Yes** | Ops writes to it from day one, and a history that starts late is not a history. |
| **`core.approval_flows` / `core.approval_documents`** | **No** | **Zero consumers today.** Ops task approval is a fixed two-rung ladder on a task, not a routed document, and it must not become the generic service by accident. The full intended schema is written down in `PRD.md` §7 so it is *designed*; it is created in the same migration as its first consumer. |
| `hr` / `crm` schemas | **No** | Empty schemas are clutter that look like progress. |

I am flagging the approval-routing call explicitly because the brief named it as part of the
foundation. I did not build it because building a routing table with no documents to route is
the exact failure mode Chan's rule names, and because getting it *wrong* early is worse than
getting it late — `APPROVALS-MODULE.md` says the routing key is
`(document_type, entity/brokerage, amount)` and we do not yet know what a quote's fields are
(`OPEN-QUESTIONS.md` #1). **If Chan wants it built now anyway, say so and it becomes Phase
9 — but it needs the quote lifecycle answered first.**

### 0.4 Authority, designed from first principles

The old `user_role` enum was `employee < manager < hr < gm < founder < admin` — a single
ladder that conflated **rank** with **function**. HR sat between a manager and the GM, which
means nothing organisationally, and that conflation directly produced the "a manager can
forge `hr_id`" class of defect: if HR is a rung, then being above the rung looks like being
allowed to act as it.

The rebuild separates the two ideas.

**1. Company authority — `core.authority`, four values, rarely changes:**

```sql
create type core.authority as enum ('staff', 'gm', 'founder', 'admin');
```

- `staff` — does the work, commits, submits.
- `gm` — verifies, oversees, runs the briefing.
- `founder` — final approval. Multiple people can hold it (Chan's father and his two eldest
  brothers each get their own row, exactly as HR intended).
- `admin` — system operator (Chan). Outside every business ladder, as before.

**2. Module capability — `core.memberships`, additive, per module:**

```sql
create type core.module   as enum ('ops', 'hr', 'crm');
create type core.position as enum
  ('founder','gm','sales','broker','hr_officer','accounting','other');
```

A membership row says *"this user participates in this module, in this position."* Position
drives recurring-task templates and scoreboard grouping. It is **not** an authority level.

**How HR and CRM slot in later, with no migration:**
- An HR officer is `authority = 'staff'` with a membership `(hr, hr_officer)`. They are not
  above a broker in the company; they have HR-module powers. Payroll's
  "HR prepares → GM → Founder" becomes: HR-module membership grants *prepare*, and the GM and
  founder **authority tiers** approve. Cleaner than the old ladder and structurally immune to
  the forgery class of bug.
- A CRM salesperson is `authority = 'staff'` with memberships `(ops, sales)` and `(crm, sales)`.
- Adding a module is `alter type core.module add value 'x'` plus rows. Adding a position is
  one enum value. Neither touches another module's authorization surface — which was exactly
  the thing that made this impossible before.

Helper functions live in `core` and are the single source of authority. Modules call them;
modules never re-derive authority from a JWT.

```sql
core.auth_user_id()            -- auth.uid(), null-safe
core.authority()               -- core.authority of the caller, from core.users
core.is_admin()                -- authority = 'admin'
core.is_founder()              -- authority in ('founder','admin')
core.is_gm()                   -- authority in ('gm','admin')
core.is_oversight()            -- authority in ('gm','founder','admin')
core.is_member(m core.module)  -- active membership in that module
core.is_system_caller()        -- service_role or a direct connection
```

`core.is_system_caller()` is copied **verbatim** from HR migration 009, including the fix:
absent claims mean a direct connection (migration, psql, cron) and are privileged; claims
that exist but carry no `role` key are **not**. HR shipped the naive version and one such
token voided every guard in three migrations at once.

### 0.5 What is kept

**The security lessons, not the schema.** These carry over verbatim and are non-negotiable:

1. **Every UPDATE policy needs an explicit `WITH CHECK`**, and it is almost never the same
   expression as `USING`. Postgres silently reuses `USING` as the check when you omit it,
   which is how `users.role` became freely writable.
2. **A policy cannot express a state machine** — it only ever sees the NEW row. Transitions
   go in a `BEFORE UPDATE` trigger, and the initial state in a `BEFORE INSERT` trigger. HR
   wrote the UPDATE guard first and left INSERT open for a whole migration, so a row could be
   inserted already approved.
3. **Enumerate all five verbs** — SELECT, INSERT, UPDATE, DELETE, **TRUNCATE** — for every
   table, and write down which are covered. **RLS does not apply to TRUNCATE at all.** Only
   the table grant stands in front of it, and `truncate employees cascade` from the public
   anon key emptied all 23 HR tables with no login.
4. **`alter default privileges` is per schema.** A fresh schema does not inherit another
   schema's revokes. `core` and `ops` each need their own full set, re-issued.
5. **Enforce ladders in the database.** PostgREST is reachable with the anon key without
   going anywhere near the Fastify API. A ladder that exists only in TypeScript is decoration.
6. **SECURITY DEFINER functions bypass RLS by design and must re-check authorization
   themselves.** HR's did not, and any employee could set a colleague's leave balance.
7. **Read-side definer functions count too.** `dashboard_summary()` leaked company-wide
   figures to every employee for three migrations because the hardening passes only looked at
   writes.

**`packages/payroll` in LRA-HR is a preserved asset.** ~45 passing tests, a real PH statutory
engine (PhilHealth, Pag-IBIG and the TRAIN table verified line by line against the
circulars). It is pure TypeScript with no database dependency, so the wipe does not touch it.
**Do not migrate it now** — it has no consumer until HR is rebuilt. Leave it where it is.

**`statutory_rate_config` seed data is kept as a reference file**, copied to
`reference/statutory-rates-2026.json` with a header recording what HR's own docs say:
**the SSS salary credit is one bracket low for roughly half of all salaries** —
`statutory.ts:35` uses `Math.floor(salary/500)*500` where the real schedule brackets on
midpoints, and `payroll.test.ts:92` currently locks in the wrong answer. Chronic
under-remittance. Whoever rebuilds HR needs the real SSS schedule from the accountant, loaded
as brackets rather than a formula. That warning must travel with the file.

**The LRA-HR repo becomes legacy reference, not a running system.** Recommended marking, and
the only edit to that repo:

- A banner at the very top of `LRA-HR/README.md`:
  > **⚠️ LEGACY — this repo's migrations no longer describe the live database.**
  > The `public` schema they create was dropped on 2026-09-08 and rebuilt as `core` + `ops`
  > by `LRA-OpsSystem`. Nothing here runs. `packages/payroll` is still good and is the reason
  > this repo is kept. See `LRA-OpsSystem/PLAN.md` §0.
- The same paragraph appended to `LRA-HR/docs/STATUS.md`, rewritten to say the schema was
  **dropped and rebuilt**, not merely that a database is shared.
- **No other change to HR code.** Do not delete the repo, do not touch `packages/payroll`,
  do not rewrite its migrations.

### 0.6 Migration tooling — **adopt the Supabase CLI**

Revision 1 rejected the CLI. That objection was: `supabase db push` reconciles the *whole*
database against the local migrations folder, and this repo would never contain HR's eleven
migrations, so the CLI would see 23 tables it had no record of and treat them as drift.

**That objection is gone.** After the wipe, this repo's migrations describe the entire
database. So:

**Adopt the Supabase CLI. Timestamped migrations. This repo is the database's system of
record until a dedicated platform-DB repo exists.**

What that buys, and the third item is the one that matters:

1. `supabase migration new <name>` → `supabase/migrations/<timestamp>_<name>.sql`, applied
   with `supabase db push`. No more hand-pasting into the SQL editor and hoping.
2. `supabase db diff` catches schema drift — someone editing a policy in the dashboard stops
   being invisible.
3. **`supabase start` gives CI a real Postgres with the `auth` schema.** The RLS suite can
   therefore run **on every pull request**, against a throwaway database, instead of needing
   a live `DATABASE_URL` and a human remembering to run it. HR's entire security history is
   "found by hand, in production, five rounds late." This single change is the biggest
   quality improvement in the rebuild and it was not available before.

Naming discipline survives: the descriptive half carries the module prefix, so
`20260908T1200_core_identity.sql`, `20260908T1230_ops_tasks.sql`. `core.schema_migrations`
from revision 1 is **deleted** — the CLI owns `supabase_migrations.schema_migrations` and a
second ledger is a second truth.

**The danger, stated once and loudly:** `supabase db reset` **drops and recreates the linked
database.** Against the production project it would destroy everything, and unlike the
one-time rebuild there would be no snapshot. Mitigations, all three required:
- `db reset` is only ever run against the **local** stack (`supabase start`), never `--linked`.
- The production project is pushed to with `supabase db push` only.
- `package.json` exposes `db:push` and `db:reset:local`. **There is no `db:reset` script**,
  so the destructive form has to be typed out deliberately.

**When HR is rebuilt in its own repo, it must not get its own migrations folder.** It
consumes the schema; it does not own it. Two repos owning one database is the problem we just
escaped. Write that in the HR banner.

---

## 1. Repository shape

npm workspaces, no turbo, `"type": "module"`, Node >= 20 — HR's conventions, which were good.

```
LRA-OpsSystem/
  package.json                     # workspaces: packages/*, apps/*
  README.md
  PRD.md  PLAN.md  DESIGN.md  OPEN-QUESTIONS.md
  design/tokens.css                # binding, from the designer
  reference/statutory-rates-2026.json   # kept for the future HR module, with its warning
  backup/pre-rebuild-snapshot.json      # gitignored, PII
  .github/workflows/ci.yml         # build / test / lint / RLS-on-every-PR
  supabase/
    config.toml
    migrations/<timestamp>_<module>_<name>.sql
    seed.sql                       # local-only fixtures for `supabase start`
    tests/rls_test.sql             # core + ops, with the mandatory-fail canary
  scripts/run-rls-tests.sh
  packages/ops-scoring/            # @lra/ops-scoring — pure math, no I/O
  apps/api/                        # @lra/ops-api — Fastify 5 + zod + supabase-js
  apps/web/                        # @lra/ops-web — Vite 8 + React 19 + router 7
```

Conventions carried from HR, all of them earned:

- `buildServer()` exported; the server listens only when run directly, so tests import it.
- Global error handler: `ZodError → 400`, `ApiError → its status`, everything else → a
  generic 500 with the real error logged. Responses are `{ data }`.
- Env read **lazily** through `lib/env.ts` with `assertEnv()` at boot. Same names:
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT`, `HOST`,
  `LOG_LEVEL`, `CORS_ORIGIN`. **Never snapshot `process.env` at module load** — import order
  then decides whether you get a value, and that bug cost HR its entire first life: every
  authenticated request returned 500 while `/health` stayed green.
- **Two Supabase clients.** `userClient(accessToken)` (anon key + caller JWT, RLS applies) is
  the default. `serviceClient()` is for genuinely system-level work only. *Reaching for
  serviceClient to avoid an RLS error is how a permission model quietly dies. Fix the policy
  instead.* Legitimate uses in Ops: outbox drain, week rollover, recurring generation, audit
  writes, provisioning, and the auth middleware's profile lookup. Each gets a comment saying
  why.
- Auth: Supabase `signInWithPassword` **in the browser**; the web attaches
  `Authorization: Bearer <token>`. The API verifies the JWT then reads authority from
  `core.users`, **never from the JWT payload**.
- Tests run against **compiled** output: `node --test dist/test/*.test.js`, `node:test` +
  `node:assert/strict`. No Prettier. oxlint on web.
- ESM: server-side relative imports carry `.js` even from `.ts` sources.
- Every source file opens with a `/** LRA Global Ops <Area> */` block comment explaining
  **why** it exists, naming the bug it prevents where there is one.
- **Both** tsconfigs `strict: true`. HR's web config was not, and that was a mistake.
- Commit messages are imperative sentences.

---

## 2. Database design

Three schemas exist after the rebuild: `core`, `ops`, and an empty `public`.
Cross-schema references are always fully qualified.

### 2.1 The drop

```sql
-- <timestamp>_000_drop_legacy_hr.sql
-- Verified safe: 47 rows, all seed or derived, no transactional data.
-- Snapshot at backup/pre-rebuild-snapshot.json. auth.users is NOT touched:
-- Chan's account is the only login and it must survive.
drop schema public cascade;
create schema public;
grant usage on schema public to anon, authenticated, service_role;
comment on schema public is
  'Intentionally empty. LRA data lives in core and per-module schemas.';
```

### 2.2 `core` — identity, authority, membership

```sql
create schema core;
grant usage on schema core to anon, authenticated, service_role;

create type core.authority as enum ('staff','gm','founder','admin');
create type core.module    as enum ('ops','hr','crm');
create type core.position  as enum
  ('founder','gm','sales','broker','hr_officer','accounting','other');

-- A human. May exist without a login. Deliberately thin: everything a
-- module needs and nothing a module owns. No salary, no government IDs,
-- no manager relation - those arrive with hr, as additive columns.
create table core.people (
  id           uuid primary key default gen_random_uuid(),
  person_code  text unique not null,          -- 'LRA-001'
  first_name   text not null,
  last_name    text not null,
  display_name text,                          -- short label for the board
  email        text unique not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- A login. Mirrors auth.users. Authority is a plain column so three
-- founders can each hold their own account with no schema change.
create table core.users (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text unique not null,
  authority  core.authority not null default 'staff',
  person_id  uuid unique references core.people(id) on delete set null,
  is_active  boolean not null default true,
  last_login timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_core_users_authority on core.users(authority) where is_active;

-- Participation in a module, in a position. NOT an authority level.
create table core.memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references core.users(id) on delete cascade,
  module     core.module not null,
  position   core.position not null default 'other',
  is_active  boolean not null default true,
  joined_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, module)
);
create index idx_core_memberships_module on core.memberships(module, position)
  where is_active;
```

Helper functions per §0.4, all `stable security definer set search_path = core, public`.
A `core.guard_user_privilege_columns()` BEFORE UPDATE trigger enforces that **only an admin
may change `authority`, `person_id` or `is_active`** on `core.users` — HR's migration 005
lesson, written correctly the first time this round.

### 2.3 `core` — notifications, outbox, audit

```sql
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
```

**The forgeable-inbox defect is designed out, not patched.** HR shipped
`create policy notifications_insert ... with check (true)`, so any authenticated user could
put a message, with a link, in anyone's inbox. In an accountability system a spoofable
"the founder approved your points" is a product defect, not just a nuisance. Here:

- **There is no INSERT policy for `authenticated` at all.** Notifications originate only from
  the outbox drain, which runs on the service client.
- The only authenticated write is `update ... set is_read` on your own row, with an explicit
  `WITH CHECK (user_id = core.auth_user_id())` **and** a trigger refusing any change to a
  column other than `is_read`.

```sql
create type core.outbox_channel as enum ('in_app','email','whatsapp');
create type core.outbox_state   as enum ('pending','sent','failed','skipped');

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
```

In-app only in the MVP; the drainer reads `pending` + `in_app` and inserts into
`core.notifications`. Email or WhatsApp later is a second drainer against the same table with
no call site touched. That is the difference between an abstraction and a promise.

```sql
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
create index idx_core_audit_entity  on core.audit_logs(entity_type, entity_id, created_at);
create index idx_core_audit_actor   on core.audit_logs(actor_id, created_at desc);
```

**Append-only even to the service role**, via a BEFORE UPDATE/DELETE trigger raising `42501`.
Not even the admin account can rewrite history through any path. INSERT policy for
`authenticated` is `with check (actor_id = core.auth_user_id())` — an audit row must claim
the identity actually making the request.

**Read policy, fixed from the start** (revision 1 flagged this as a gap in HR): a caller may
read audit rows where they are the actor, **or** where they own the entity — via
`core.can_read_audit(entity_type, entity_id)`, a definer function each module extends. Ops's
branch: a task's owner may read its timeline. Oversight reads everything. A submitter being
unable to see their own document's history is the thing that makes people distrust a system.

### 2.4 `ops` — weeks, catalog, tasks

Unchanged from revision 1 except that `ops.members` is gone (replaced by `core.memberships`)
and the outbox moved to `core`. Reproduced in condensed form; the migration carries the full
text.

```sql
create schema ops;
grant usage on schema ops to anon, authenticated, service_role;

create type ops.week_state  as enum ('planning','open','closed');
create type ops.task_status as enum
  ('todo','in_progress','submitted','verified','cleared','rejected','cancelled');
create type ops.ledger_state as enum
  ('submitted','verified','cleared','rejected','cancelled');
-- 'external' matters in this trade: BOC, carriers and clients block work
-- constantly, and that time must be measured even though nobody here can chase it.
create type ops.block_target as enum ('task','person','external');

create table ops.settings (
  id boolean primary key default true check (id),
  recurring_cap_pct           numeric(4,3) not null default 0.400
    check (recurring_cap_pct >= 0 and recurring_cap_pct < 1),
  recurring_floor_points      int not null default 3 check (recurring_floor_points >= 0),
  stale_after_days            int not null default 3 check (stale_after_days >= 1),
  reliability_window_weeks    int not null default 8,
  reliability_half_life_weeks numeric(4,2) not null default 3.0,
  min_weeks_for_rating        int not null default 3,
  leaderboard_visibility      text not null default 'all'
    check (leaderboard_visibility in ('all','oversight_only')),
  timezone   text not null default 'Asia/Manila',
  updated_by uuid references core.users(id),
  updated_at timestamptz not null default now()
);

-- Manila, always. Never UTC, never the browser's clock.
create or replace function ops.week_start_for(p_ts timestamptz default now())
returns date language sql immutable as $$
  select (date_trunc('week', (p_ts at time zone 'Asia/Manila')))::date;
$$;   -- date_trunc('week') is ISO: Monday.

create table ops.weeks (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique check (extract(isodow from week_start) = 1),
  week_end   date generated always as (week_start + 6) stored,
  state      ops.week_state not null default 'planning',
  briefing_opened_at timestamptz,
  briefing_closed_at timestamptz,
  briefing_closed_by uuid references core.users(id),
  closed_at timestamptz, closed_by uuid references core.users(id),
  rolled_over_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

`ops.task_types` (Fibonacci `check (default_points in (1,2,3,5,8,13,21))`, a **mandatory**
`guideline_note`), `ops.task_type_revisions` (append-only), `ops.recurring_templates` keyed on
`core.position`, and `ops.tasks` are exactly as in revision 1, with every `public.users`
reference becoming `core.users`. The columns that matter:

- `catalog_points` — **snapshotted at creation.** Re-pricing the catalog must never move last
  month's scores. Same rule as HR's payslip rate-config snapshot, same reason.
- `points_override` + `points_override_reason` — override requires a reason, enforced by a
  CHECK **and** restricted to oversight by the trigger.
- `points_awarded` — written by the trigger at `cleared` **only**, derived, never accepted
  from the client. HR learned this with `hours_worked`: an employee who can send the number
  will eventually send a better one.
- `is_committed` / `committed_week_id` / `committed_points`, `first_week_id` /
  `carry_over_count`, `last_activity_at`.
- `unique index uq_ops_tasks_recurring on (owner_user_id, week_id, recurring_template_id)` —
  recurring generation **must** be idempotent. HR's `apply_loan_deductions()` was not, and any
  employee could drain a loan by calling it repeatedly.

### 2.5 The task state machine

**A policy cannot express a state machine.** `ops.enforce_task_transition()` (BEFORE UPDATE)
and `ops.enforce_initial_task_status()` (BEFORE INSERT) **ship in the same migration** — HR
shipped them a migration apart and the gap was exploitable.

1. `if core.is_system_caller() or core.is_admin() then return new; end if;`
2. **Stamp-forgery guard, on every update whether or not the status changed.** Non-GM may not
   touch `gm_id`/`gm_acted_at`; non-founder may not touch
   `founder_id`/`founder_acted_at`/`cleared_at`/`points_awarded`. HR needed two extra
   migrations to get this right; write it once.
3. Status unchanged → allow, refresh `last_activity_at`.
4. `cleared` is terminal. Any change to a cleared task raises `42501`.
5. Legal transitions:

| From | To | Who |
|---|---|---|
| `todo` | `in_progress`, `submitted`, `cancelled` | owner, or oversight |
| `in_progress` | `todo`, `submitted`, `cancelled` | owner, or oversight |
| `submitted` | `verified` | GM, **and not the task owner** |
| `submitted` | `rejected` | GM or founder; reason required |
| `submitted` | `in_progress` | owner (retract), or GM |
| `verified` | `cleared` | **founder only** |
| `verified` | `rejected` | founder; reason required |
| `verified` | `submitted` | founder (send back to the GM); reason required |
| `rejected` | `todo` | owner (rework) |
| `cancelled` | `todo` | oversight only |

6. **GM self-verification:** if the owner is the GM, `submitted → verified` is permitted only
   to a founder. A two-person control where one person can be both people is not a control.
7. On `→ cleared`: set `cleared_at`, derive `points_awarded`.
8. Every point-bearing transition inserts one `ops.point_ledger` row and enqueues one
   `core.notification_outbox` row.

INSERT guard: a task starts at `todo` or `in_progress`; `points_awarded`, `gm_*`,
`founder_*`, `cleared_at` must be null; `created_by = core.auth_user_id()` unless
system/admin; `catalog_points` is read from the catalog server-side, not from the request.

### 2.6 Ledger, blocks, commitments

`ops.point_ledger` — append-only, one row per point-bearing transition
(`task_id`, `user_id`, `week_id`, `from_status`, `to_status`, `state`, `points`,
`is_recurring`, `is_committed`, `actor_id`, `reason`). Written only by the trigger.
UPDATE and DELETE raise `42501`. **Balances are computed, never stored** —
`ops.v_point_balances` gives cleared / pending-with-GM / pending-with-founder /
new-vs-recurring per person per week.

**The recurring cap is applied in `packages/ops-scoring`, on top of that view, never in SQL.**
The ledger stores true cleared points; the scorecard computes the capped figure; both are
shown, with the capped one labelled, so nobody discovers a silent haircut.

`ops.task_blocks` — `target` is `task` | `person` | `external`, with a CHECK enforcing exactly
one populated target column and a non-trivial `reason`. `ops.reject_block_cycle()` refuses a
task→task edge that closes a cycle, because two people blocking each other deadlocks the
board silently. Views: `ops.v_task_blocked_time`, `ops.v_blocker_load` (per person — the one
the briefing reads out loud) and `ops.v_external_blocker_load` (which outside party costs us
the most days — a question a customs broker genuinely wants answered and cannot ask today).

Commitments live on `ops.tasks`, not in a join table, because a task commits to exactly one
week and a second table would be a second truth. `ops.enforce_commitment_lock()` refuses any
change to `is_committed` / `committed_week_id` / `committed_points` once the week has left
`planning`.

### 2.7 RLS and grants

Every table in `core` and `ops` gets `enable row level security`.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `core.people` | self, or oversight | admin | admin | none |
| `core.users` | self, or oversight | admin | self (non-privileged cols) + trigger; admin all | none |
| `core.memberships` | any active member | admin | admin | none |
| `core.notifications` | `user_id = auth.uid()` | **none for authenticated** | own row, `is_read` only, trigger-enforced | own row |
| `core.notification_outbox` | recipient, or oversight | system only | system only | none |
| `core.audit_logs` | actor, entity owner, or oversight | `actor_id = auth.uid()` | **none** | **none** |
| `ops.settings` | ops member | none | founder | none |
| `ops.weeks` | ops member | oversight | oversight + state trigger | none |
| `ops.task_types` | ops member | oversight | oversight | none (deactivate) |
| `ops.task_type_revisions` | ops member | oversight | none | none |
| `ops.recurring_templates` | ops member | oversight | oversight | none |
| `ops.tasks` | **any ops member** — everyone sees everything, by design | owner only, or oversight | owner or oversight, `WITH CHECK` identical, trigger does the real work | owner, only while `todo`/`cancelled` |
| `ops.point_ledger` | ops member | trigger/system only | **none** | **none** |
| `ops.task_blocks` | ops member | member, `created_by = auth.uid()` | creator, blocking user, or oversight | none |

And, mandatory, **once per schema** — this is the step that is easy to forget and
catastrophic to skip:

```sql
-- Supabase grants ALL on new tables to anon/authenticated and relies on RLS.
-- RLS does not cover TRUNCATE. Only this grant stands in front of it.
revoke truncate, trigger, references on all tables in schema core from anon, authenticated;
revoke truncate, trigger, references on all tables in schema ops  from anon, authenticated;
revoke delete on all tables in schema core from anon;
revoke delete on all tables in schema ops  from anon;
alter default privileges in schema core
  revoke truncate, trigger, references on tables from anon, authenticated;
alter default privileges in schema ops
  revoke truncate, trigger, references on tables from anon, authenticated;
alter default privileges in schema core revoke delete on tables from anon;
alter default privileges in schema ops  revoke delete on tables from anon;
```

**Every future module schema repeats this block.** Put it in the migration template.

---

## 3. API surface

`apps/api`, Fastify 5, everything under `/api`, everything behind `authenticate`.
Responses are `{ data }`.

```
GET    /health

GET    /api/me                       identity + authority + ops position
GET    /api/members                  the ops team

POST   /api/admin/users              admin: invite + person + user + membership (idempotent)
GET    /api/admin/users
PATCH  /api/admin/users/:id          is_active, authority, position

GET    /api/weeks/current | ?limit=8
POST   /api/weeks                    oversight, idempotent on week_start
POST   /api/weeks/:id/generate-recurring
POST   /api/weeks/:id/briefing/open | /close
POST   /api/weeks/:id/close

GET    /api/tasks?weekId=&ownerId=&status=&committed=&stale=
GET    /api/tasks/board?weekId=
POST   /api/tasks
PATCH  /api/tasks/:id                title/description/type/client_ref only
POST   /api/tasks/:id/status         { to, reason? }   THE one transition endpoint
POST   /api/tasks/:id/commit | DELETE
POST   /api/tasks/:id/override-points  oversight, reason required
DELETE /api/tasks/:id
POST   /api/tasks/:id/blocks
POST   /api/blocks/:id/resolve
GET    /api/blocks/open

GET    /api/catalog | POST | PATCH /:id | GET /:id/revisions
GET    /api/catalog/recurring | POST | PATCH /:id

GET    /api/points/me?weekId=
GET    /api/points/ledger?userId=&weekId=
GET    /api/points/queue             GM: submitted. Founder: verified. Ages in hours.

GET    /api/briefing/:weekId         one call, everything the briefing screen needs
GET    /api/now                      who is working on what right now
GET    /api/scoreboard?weekId= | /api/scoreboard/:userId

GET    /api/notifications?unread= | POST /:id/read
GET    /api/settings | PATCH         founder only
POST   /api/jobs/drain-outbox | /api/jobs/flag-stale
```

**One transition endpoint.** Every status change — button, drag, keyboard — goes through
`POST /api/tasks/:id/status`. One path means one place for the ladder to be wrong, and the
route uses `userClient`, so the trigger is the real enforcement and a route bug cannot
promote anything.

---

## 4. Web

Vite 8 + React 19 + react-router-dom 7, plain `useState`/`useEffect` over a hand-written
`lib/api.ts`. No React Query. **Tailwind + shadcn/ui over Radix primitives**, driven by the
21st.dev MCP tooling the coder has.

**`DESIGN.md` exists and is binding on every visual value** — palette, type scale, spacing,
radii, motion, the shadcn token aliases, and the "settled value is solid ink, unsettled value
never is" rule that governs every number on screen. `design/tokens.css` is copied into
`apps/web/src/index.css` before the first component is generated. This plan specifies no
colour, font, radius or curve. Where DESIGN.md and this file disagree, DESIGN.md wins.

Two DESIGN.md decisions this plan must respect structurally: **light mode only** in the MVP,
and input borders use the lighter `#CBD2E0` with its WCAG 1.4.11 shortfall **documented
rather than hidden** — the tester should confirm the note exists, not report the contrast as
a new defect.

| Need | Library |
|---|---|
| Components | `shadcn/ui`, generated into `src/components/ui`, then owned |
| Primitives | `@radix-ui/react-*` — dialogs, menus, popovers, tooltips, tabs, select. Hand-build none of these |
| Board drag-and-drop | **`@dnd-kit/core` + `@dnd-kit/sortable`** — Radix has no DnD primitive; dnd-kit is keyboard-accessible and pointer-agnostic, which matters because the briefing runs on a shared display |
| Icons | `lucide-react` |
| Sparklines | `recharts`, via shadcn's `chart` |
| Fonts | `@fontsource-variable/urbanist`, `@fontsource-variable/geist-mono` — **self-hosted**, so a Cebu office with a flaky link still renders legibly |
| Class merge | `clsx` + `tailwind-merge` via `cn()` |

Chan has **no 21st.dev team library yet**, so components come from the public catalog or
fresh generation. Generated output is a starting point, not a commit: every component gets
DESIGN.md's tokens and an LRA header before it lands. Once the board card, the points tile,
the queue row and the chain-of-custody indicator settle, publish them back to a team library
so the HR and CRM rebuilds start from LRA's components.

| Route | Screen | Who |
|---|---|---|
| `/login` | Sign in | all |
| `/` | **Now** — who is working on what right now | all |
| `/board` | **Board** — Trello columns, drag to move | all |
| `/briefing` | **Monday briefing** — the live meeting screen | all; oversight closes |
| `/points` | **My points** — cleared / pending / committed + ledger | all |
| `/queue` | **Approvals** — verify (GM) / approve (founder) | oversight |
| `/scoreboard` | Team scoreboard, leaderboard, week-over-week | per `leaderboard_visibility` |
| `/people/:id` | Person profile, reliability, 8-week history | all |
| `/catalog` | Task catalog + guideline notes + templates | read all; edit oversight |
| `/admin/users` | Provisioning | admin |
| `/settings` | Ops settings | founder |
| `/inbox` | Notifications | all |

---

## 5. `packages/ops-scoring` — pure math, no database

Mirrors `packages/payroll` in LRA-HR, which is exactly why that package survived the wipe:
numbers that matter live where they can be tested without a network.

```ts
manilaWeekStart(d) / manilaWeekBounds(ws) / weeksBetween(a,b)
FIB_POINTS = [1,2,3,5,8,13,21]; isFibPoint(n)
applyRecurringCap({ newPoints, recurringPoints, capPct, floorPoints })
reliability(weeks, opts) -> { score|null, band, base, modifiers, ratedWeeks }
cycleTimeHours(startedAt, clearedAt, blockedHours) / median(xs) / isStale(...)
```

Required tests — each is a way a formula can be silently wrong:

- Every non-Fibonacci integer rejected, including 0 and negatives.
- Cap: `N=0,R=10,floor=3` → 3. `N=0,R=10,floor=0` → 0. `N=10,R=10` → 6, ratio 0.375 ≤ 0.40.
  `R=0` no crash. `capPct=0` → floor only.
- Reliability: all-perfect → 100; all-missed → 0; zero-commitment weeks contribute to neither
  sum; fewer than `min_weeks_for_rating` → **`null` / unrated, not 100**; a recent bad week
  outweighs an old one (strict inequality on two mirrored histories); modifiers respect caps;
  clamps to [0,100].
- Weeks: **Manila Monday 00:15 and Manila Sunday 23:45 map to the same week** — a UTC-naive
  implementation gets both wrong. Plus 31 Dec / 1 Jan.
- Cycle time: blocked hours subtracted, never negative, median of an even-length list.

---

## 6. Test strategy

**1. Unit** — `packages/ops-scoring`, compiled, no I/O.

**2. RLS and write-path regression** — `supabase/tests/rls_test.sql`, covering `core` **and**
`ops`. Structure copied from HR's suite, and none of it is optional:

- One transaction, rolled back.
- Runs as `authenticated`, **never as the table owner** — the owner bypasses RLS entirely
  because no table has `FORCE ROW LEVEL SECURITY`.
- Sets `request.jwt.claims`, the **plural** GUC. HR's earlier suite set the legacy singular
  `request.jwt.claim.sub`, so every persona was anonymous, `is_system_caller()` treated absent
  claims as privileged, and the suite passed 14/14 against a wide-open database.
- Mostly **negative assertions**. `expect_blocked` counts "zero rows affected" as a refusal,
  because RLS usually refuses by matching no rows rather than by raising.
- Ends with a **canary that MUST fail**. If it passes, the suite is not exercising RLS and
  every result above it is void. `run-rls-tests.sh` exits non-zero on a passing canary.

Attacks, minimum:

| # | Attack | Must |
|---|---|---|
| 1 | `truncate ops.tasks` as `anon` | refused |
| 2 | `truncate core.users` as `anon` | refused |
| 3 | staff INSERTs a task already at `verified` | refused |
| 4 | staff moves their own task `submitted → cleared` | refused |
| 5 | staff writes `points_awarded` | refused / no effect |
| 6 | GM stamps `founder_id` | refused |
| 7 | GM moves `verified → cleared` | refused |
| 8 | GM verifies a task they own | refused |
| 9 | staff changes `catalog_points` on their own task | refused |
| 10 | staff sets `points_override` | refused |
| 11 | override without a reason | refused |
| 12 | staff commits after the briefing closed | refused |
| 13 | any UPDATE/DELETE on `ops.point_ledger` | refused |
| 14 | any UPDATE on a `cleared` task | refused |
| 15 | staff edits `ops.task_types` | refused |
| 16 | staff edits `ops.settings` | refused |
| 17 | a non-ops-member SELECTs `ops.tasks` | zero rows |
| 18 | task→task block closing a cycle | refused |
| 19 | staff sets `is_committed` on someone else's task | refused |
| 20 | staff opens or closes a week | refused |
| 21 | **staff INSERTs a `core.notifications` row for another user** | refused |
| 22 | staff updates a notification field other than `is_read` | refused |
| 23 | staff sets their own `core.users.authority = 'admin'` | refused |
| 24 | **service role UPDATEs a `core.audit_logs` row** | refused |
| 25 | staff inserts an audit row claiming another actor | refused |
| 26 | staff reads `core.people` rows other than their own | zero rows |
| 27 | **CANARY:** a non-member reads all `ops.tasks` and finds rows | **FAIL** |

**3. Integration across a process boundary.** HR's postmortem is explicit: a green unit suite
coexisted with an API where every authenticated request returned 500, because no test crossed
a process boundary. So: boot `buildServer()`, sign in a real seeded user over HTTP, walk
`create → submit → verify → clear`, assert three ledger rows and the balance at each step.

**4. CI — and this is the part that is genuinely new.** With `supabase start` giving CI a real
Postgres including the `auth` schema, `.github/workflows/ci.yml` runs, on **every pull
request**:

- `build` — `npm ci && npm run build && npm test`, Node 20 and 22.
- `lint` — oxlint on web.
- `rls` — `supabase start`, `supabase db reset` (**local only**), then the full 27-attack
  suite. HR's entire security history is "found by hand, in production, five rounds late."
  This is the change that stops that from repeating, and it was not possible before the
  rebuild.

Deploy: build in CI, ship `dist/`. The VPS has 1 core and must not build anything.

---

## 7. Phases

Each phase carries a **Status** line and per-step checkboxes. A `[x]` means the artifact was
verified to exist in the repo — not that it was re-tested. `grep -n '^[0-9]\+\. \[ \]' PLAN.md`
lists everything still outstanding. Update the box in the same change that lands the step.

Every phase ends with a command to run and an output to read. Nothing is done without both.

### Phase 0 — The rebuild

**Status: done.** `supabase/migrations/20260908120000_000_drop_legacy_hr.sql` applied; `public` rebuilt.

1. [x] **Verify `backup/pre-rebuild-snapshot.json` exists and parses**, and that its row counts
   match the census in §0.1. If it does not parse, stop. This is the only rollback artifact.
2. [x] `supabase init`; `supabase link --project-ref <ref>`; commit `supabase/config.toml`.
3. [x] Migration `000_drop_legacy_hr.sql` per §2.1. **`auth` is not touched.**
4. [x] Confirm in the Supabase Dashboard that Chan's account still exists in Authentication.
5. [x] `reference/statutory-rates-2026.json` — the four `statutory_rate_config` rows, with the
   SSS-bracket warning in a header comment.
6. [x] LRA-HR legacy banner: `README.md` top + the rewritten `docs/STATUS.md` paragraph. Nothing
   else in that repo is touched.
7. [x] `.gitignore` already excludes `backup/`; confirm.

**Verify:**
- `select count(*) from information_schema.tables where table_schema = 'public'` → **0**.
- `select count(*) from auth.users` → **1**, and Chan can still sign in via the dashboard.
- `git status` in LRA-HR shows exactly two modified files, both documentation.

### Phase 1 — `core`, `ops` schemas, API, auth, tokens

**Status: done.** Both schemas, RLS migration, `packages/ops-scoring`, `apps/api`, `apps/web`, `supabase/tests/rls_test.sql` and `.github/workflows/ci.yml` all present.

1. [x] Root `package.json` (workspaces, `db:push`, `db:reset:local`, `test:rls`, **no `db:reset`**).
2. [x] Migrations: `core_identity` (§2.2), `core_notifications_audit` (§2.3),
   `ops_foundation` (§2.4 settings/weeks), `core_ops_rls` (§2.7 policies **and the
   per-schema revoke block**).
3. [x] **Append `core` and `ops` to Supabase → Data API → Exposed schemas.** Append, never
   replace — `public` must stay listed even though it is empty, or PostgREST's own
   introspection paths change.
4. [x] `packages/ops-scoring` with `weeks.ts` + tests.
5. [x] `apps/api`: `server.ts`, `lib/env.ts`, `lib/supabase.ts` (schema-scoped clients for `core`
   and `ops`), `lib/domain.ts`, `middleware/auth.ts` — **authority read from `core.users`,
   never from the JWT**.
6. [x] `apps/web`: Vite + React 19 + router; copy `design/tokens.css` into `src/index.css`;
   `npx shadcn@latest init` (TypeScript, `src/components/ui`, CSS variables **on**); alias
   shadcn's token names to DESIGN.md's; install `@dnd-kit`, `lucide-react`, the two
   `@fontsource-variable` packages, `clsx`, `tailwind-merge`. `/login` + a placeholder `/`.
   **Both tsconfigs strict.**
7. [x] `supabase/tests/rls_test.sql` — harness, canary, attacks 1, 2, 16, 20, 21, 22, 23, 24, 25,
   26, 27. `scripts/run-rls-tests.sh`.
8. [x] `.github/workflows/ci.yml` including the `supabase start` RLS job.

**Verify:**
- `npm run build && npm test` green.
- `curl localhost:3001/health` → `{"status":"ok","service":"lra-ops-api",...}`.
- `npm run test:rls` → `ALL PASS (canary correctly failed)`.
- CI green on a pull request, **with the RLS job actually running** — check the log for the
  canary line, do not trust a green tick.
- A shadcn `<Button>` renders with DESIGN.md's primary background (read the **computed**
  style; do not eyeball a screenshot). Urbanist and Geist Mono resolve with the network
  throttled to offline.

**Demoable:** log in, see the team. Small, but it proves auth, both schemas, the grants, the
tokens and CI before anything depends on them.

### Phase 2 — Provisioning

**Status: mostly done.** `routes/admin.ts`, `/admin/users`, `scripts/provision.md` present, and **`/set-password` is now built** (live requirements, verbatim Supabase errors, an explicit expired/invalid-link state). Two gaps remain, both in flight 2026-09-09 night: `inviteUserByEmail` is called with **no `redirectTo`**, so an invited user does not actually land on `/set-password`; and nothing can set `core.users.read_only`, without which the ERC and DCA observer accounts cannot be provisioned at all. **`/set-password`'s happy path is unverified** — only the failure states have been exercised, because no live invite token was available.

Chan's account is the only login in the system. Until three more people can sign in, every
later phase can only be demonstrated by one person pretending to be four — which is exactly
how a ladder bug survives to production.

The rebuild makes this simpler than revision 1 planned: no `EMP-001` collision, no UNIQUE
`employee_id` to work around, no salary columns to leave at zero.

1. [x] `apps/api/src/routes/admin.ts`, guarded `requireAuthority('admin')` — Chan only, not the
   founder and not the GM. Provisioning is a system act.
   - `POST /api/admin/users` → `inviteUserByEmail` (**no credential ever passes through this
     system, an agent, or a chat log**), then `core.people`, then `core.users` with
     `authority`, then `core.memberships` for `ops`. Every error thrown, never discarded.
   - **Idempotent on email.** Re-running finds the existing auth user and repairs missing
     rows. It will be re-run.
   - `GET` / `PATCH` for listing and deactivating. Every call writes `core.audit_logs`;
     creating a `founder` is the highest-privilege action in the platform and must never be
     silent.
2. [ ] `apps/web` `/admin/users` — table + invite dialog, showing invited / accepted / never
   logged in. `/set-password` first-login flow.
3. [x] `scripts/provision.md` — the SQL fallback, and the documented alternative
   (`auth.admin.createUser` with a one-time password read out in person) **if the invite
   emails do not land**, which is plausible in a four-person office.
4. [x] RLS suite: a non-admin creating a user → refused; attack 23 re-verified from the Ops side.

**Verify:**
- Three invites → three `core.people`, three `core.users` (`gm`, `staff`, `staff`), three
  `core.memberships` (`ops` / `gm`, `sales`, `broker`).
- Re-run the same three calls → no duplicates, no errors, counts unchanged.
- All three accept, set a password, log in, and `/` shows their own name and position.
  **Report which of the three actually logged in** — "the invite was sent" is a different
  claim from "they logged in," and only the second one counts.
- As Sales: `PATCH /api/admin/users/<self>` with `authority: 'admin'` → 403, and a direct
  PostgREST `update core.users set authority='admin'` → refused.

**Demoable:** four real people, four real logins.

### Phase 3 — Catalog, tasks, board

**Status: done.** Catalog + task migrations, state machine, `/board` on `@dnd-kit`, `/catalog` all present, and `/board` now has a **New task** dialog with a permission-gated assignee — verified end to end in a real browser on 2026-09-09, not just typechecked. Before that there was no way to create a task anywhere in the app. Attacks 5, 7, 10 and 11 were never actually missing: they exist in `rls_test.sql` under descriptive names rather than numbers (`'staff cannot write points_awarded directly'`, `'GM cannot move verified -> cleared'`, `'staff cannot set a points override'`, `'oversight cannot set a points override with no reason'`). Verified by grep, 2026-09-09. Attacks 5, 7, 10 and 11 were never actually missing: they exist in `rls_test.sql` under descriptive names rather than numbers (`'staff cannot write points_awarded directly'`, `'GM cannot move verified -> cleared'`, `'staff cannot set a points override'`, `'oversight cannot set a points override with no reason'`). Verified by grep, 2026-09-09.

1. [x] Migrations: `ops_catalog_tasks`, `ops_task_state_machine` (**INSERT and UPDATE guards in
   the same migration**), `ops_catalog_rls`.
2. [x] `ops_seed_catalog` — ~15 types grounded in what LRA actually does: **Brokerage** (prepare
   and file an import entry; BOC clearance follow-up; tariff classification for a new
   commodity; resolve a hold or discrepancy; daily shipment status to clients),
   **Sales** (quotation turnaround within SLA; convert a website "Free Quotation" lead; client
   follow-up; land a new account), **Logistics** (arrange trucking for a released shipment;
   warehousing coordination), **Admin** (statutory/accreditation filing; weekly billing and
   collection), **Management** (run the Monday briefing; clear the approval queue within 24h).
   **Point values are deliberately not proposed.** Ranking the value of work is the founder's
   judgement about his own business, and an agent guessing it would launder a guess into
   company policy. Every seeded `guideline_note` begins `DRAFT —`; `/catalog` shows a banner
   while any DRAFT row exists; **the founder re-pricing the catalog is a Phase 6 gate.**
3. [x] API `/api/catalog*`, `/api/tasks*`.
4. [x] Web `/board` on `@dnd-kit`, seven columns; the Blocked drop opens a Radix `Dialog`;
   `/catalog`.
5. [x] RLS suite: attacks 3–11, 14, 15. (Present under descriptive names, not numbers.)

**Verify:** drag `todo → in_progress → submitted`; as GM drag to `verified`; as staff try to
drag your own `submitted` task to `cleared` — the UI shows the database's `42501` and the card
snaps back. `npm run test:rls` all pass, canary fails.

### Phase 4 — Ledger, approval chain, notifications

**Status: done.** `ops_ledger` + purge exception, `points.ts` / `notifications.ts` / `jobs.ts`, `/points` `/queue` `/inbox`, attack 13 covered, and `apps/api/test/lifecycle-integration.test.ts` now walks the whole ladder over a real socket with three signed-in personas.

1. [x] Migration `ops_ledger` (+ append-only guard, `v_point_balances`); extend the transition
   trigger with `create or replace` in a **new** migration — never edit an applied one.
2. [x] API `/api/points/*`, `/api/tasks/:id/override-points`, `/api/notifications*`,
   `/api/jobs/drain-outbox`. `services/outbox.ts` — the in-app drainer.
3. [x] Web `/points`, `/queue` with per-item age in hours, `/inbox`.
4. [x] Integration smoke test across HTTP. Listens on a real port and `fetch`es it rather than using `inject`; signs in `sales-demo`, `gm-demo` and `founder-demo`; walks create → commit → submit → verify → clear; asserts three `ops.point_ledger` rows in order and the balance **delta** (an absolute balance would be a coincidence, since the demo seed already gives sales-demo cleared points); asserts both refusals. Skips loudly with a named cause rather than passing silently when credentials are absent.
5. [x] RLS suite: attack 13.

**Verify:** three accounts, end to end — staff submits → **Pending, with the GM**; GM
verifies → **Pending, with the Founder**; founder approves → **Cleared**.
`select count(*) from ops.point_ledger where task_id='<id>'` → 3.
`update ops.point_ledger set points=21` as **service role** → `42501`.

### Phase 5 — Weeks, recurring, carry-over

**Status: done.** `20260909110000_ops_weeks_functions.sql` plus the recurring/carry-over fix migrations.

`ops.generate_recurring_tasks()`, `ops.roll_over_week()`, `ops.close_week()` — all
`security definer`, **all guarded** (`is_system_caller() or is_oversight()`, else 42501) and
**all idempotent**. Carry-over increments `carry_over_count`, preserves `first_week_id`, and
**does not touch the old week's commitment records** — moving work forward is a scheduling
convenience, not an amnesty.

**Verify:** call each function twice; the second is a no-op and counts are unchanged. A staff
member calling either directly → 42501. Close a week with two unfinished tasks; both appear in
the new week with `carry_over_count = 1`.

### Phase 6 — The Monday briefing

**Status: mostly done.** `20260909150100_ops_briefing.sql`, `routes/briefing.ts`, `/briefing` present. Attack 19 already existed (`'staff cannot commit someone else\'s task'`); **attack 12 was genuinely missing and has been added** — every existing commitment-lock test started from an already-true commitment and tried to *alter* it after close, so a fresh `false → true` commit after close had never been exercised. **The founder catalog re-pricing gate is still open**: Chan assigned arbitrary Fibonacci values on 2026-09-09 so the system could be exercised, but explicitly deferred the real valuation to a sit-down with his team. The `PLACEHOLDER —` prefix and the banner stay until then.

Commitment lock trigger; `GET /api/briefing/:weekId` in one call; `/briefing` with the four
sections in order and large type for a shared display; a single **Close the briefing** button
for oversight, with a confirm step.

**Founder catalog review is a gate on this phase.** Commitments made against DRAFT point
values are not commitments.

**Verify:** three accounts commit, oversight closes, then `POST /api/tasks/:id/commit` →
refused with "commitments are locked for this week." RLS attacks 12, 19.

### Phase 7 — Blockers, staleness, Now

**Status: done.** `ops.task_blocks` + cycle guard, the Blocked dialog on `/board`, `POST /api/jobs/flag-stale` (idempotent per task per calendar day via the outbox, which needs no schema change and behaves correctly for a task still stale tomorrow), and `GET /api/now` — with `/` rebuilt on it as the real Now screen, polling every 20s. The only thing outstanding is a scheduler to *call* `flag-stale`, which needs a deployed URL and therefore belongs to Phase 9.

`ops.task_blocks` + cycle guard + blocked-time views; outbox events for
`ops.block.opened` / `.resolved`; `POST /api/jobs/flag-stale` daily and idempotent per task
per day; `/api/now`; the Blocked column dialog; `/` becomes the real Now screen, polling 20s.

**Verify:** block a task on the GM → a `core.notifications` row for the GM within one drain.
`v_task_blocked_time` grows and stops at `resolved_at`. A→B then B→A raises the cycle error.
RLS attack 18.

### Phase 8 — Scoreboard, reliability, leaderboard

**Status: done, 2026-09-10.** `packages/ops-scoring` completed tests-first: `fib.ts`, `recurring-cap.ts`, `cycle-time.ts`, `reliability.ts`. `/api/scoreboard` and `/api/scoreboard/:userId` enforce `leaderboard_visibility` server-side; `/scoreboard` and `/people/:id` show the capped score beside the raw cleared total and a week-by-week table so reliability can be recomputed by hand. **Median cycle time** is included, stamped from `ops.tasks.first_in_progress_at` (first entry to `in_progress` only, so a bounced task keeps its original start) with the sample size always shown and no backfill — neither the ledger nor the audit log records a plain `todo -> in_progress`, so historical rows stay NULL rather than being derived from a proxy.

Reliability, hit-rate and cycle time are **founder/admin only and stripped from the JSON**, per §10 #4. Three real weeks of history are seeded through the real ladder so these numbers are demonstrable rather than a column of "Unrated". The hand-computed cross-check §7 demands was done for reliability and for the median, and both matched the API.

`packages/ops-scoring` completed — **tests first**, because these formulas have no visible
failure mode. `/api/scoreboard*`; `/scoreboard` and `/people/:id`; capped score shown next to
the raw cleared total, labelled.

**Verify:** every §5 case green. Hand-compute one person's reliability on paper and confirm
the API agrees to two decimals. **Put that arithmetic in the phase report.**

### Phase 9 — Deploy and harden

**Status: not started, and deliberately deferred.** Chan, 2026-09-09: deployment waits until the system is functionally as complete as it can be locally, to avoid adding hosting cost this early. Nothing before this phase may assume a deployed URL. The RLS attack count in earlier revisions of this file was wrong — 26 of 27 were already covered and only attack 12 was missing; it has been added, along with a read-only-account block. **Both 2026-09-10 migrations are now applied, and the suite was run on 2026-09-10: `ALL PASS (canary correctly failed)`, 109 passed / 0 failed, both canaries correctly red.** Note it cannot be run from the Supabase web SQL editor — see OPEN-QUESTIONS.md #14. Still outstanding here: `pg_cron` is available but not installed, so `core.purge_due_accounts()` and `flag-stale` have no scheduler.

Full 27-attack suite green in CI. `README.md` — migration flow, env, provisioning, how to run
the RLS suite, and the standing rule that **every new module schema repeats the §2.7 revoke
block**. Deploy: build in CI, ship `dist/`; own port, own systemd unit, own `CORS_ORIGIN`.
Cron: `flag-stale` daily 08:00 Manila, `drain-outbox` every minute, week creation Monday
06:00, week close Sunday 23:59. Then `tester`, then `manager`.

---

## 8. Risks and unknowns

| Risk | Cheapest early de-risk |
|---|---|
| **The drop is irreversible.** | Phase 0 step 1 verifies the snapshot parses **before** dropping. 47 rows, all seed or derived — but "we deleted it and cannot say what was there" is unacceptable regardless of value. |
| **`drop schema public cascade` takes something unexpected.** | It is scoped to `public`. `auth`, `storage`, `graphql`, `extensions` and `realtime` are untouched, and Phase 0 verifies `auth.users = 1` and a working dashboard login immediately after. |
| **`supabase db reset` against production destroys everything**, with no snapshot next time. | Three mitigations, all required: reset only against the local stack, `db push` only against production, and **no `db:reset` script exists** in `package.json`. |
| **A new schema silently ships with TRUNCATE granted to `anon`** — the exact HR-008 catastrophe, and default privileges are per schema. | The revoke block is in the same migration as the schema, and attacks 1 and 2 run in CI on every PR from Phase 1. |
| **A seeded catalog invented by an agent becomes company policy by default.** | No point values proposed; every note begins `DRAFT —`; a UI banner while any remain; founder review gates Phase 6. |
| **Reliability is a management instrument with no visible failure mode.** | Tests before implementation; a hand-computed cross-check in the phase report; the inputs shown on the profile screen so anyone can recompute it. |
| **A leaderboard between three people can breed resentment as easily as motivation.** | `leaderboard_visibility` is one `UPDATE` away from `oversight_only`; reliability always shows its inputs; blocked time explicitly exonerates. Watch the first two weeks. |
| **The Manila week boundary.** A UTC-naive implementation is wrong for 8 hours in every 24, and it shows up as scores landing in the wrong week. | `manilaWeekStart` is a pure function in Phase 1 with boundary tests, and nothing else computes a week. |
| **Designing for HR and CRM before they exist.** | §0.3 draws the line explicitly and names what was deliberately *not* built. Revisit it when HR is actually specified, not before. |
| **Two repos owning one database, again.** | This repo is the database's system of record. The HR banner says so. When HR is rebuilt it consumes the schema; it does not get a migrations folder. |
| **HR's payroll engine gets orphaned or lost.** | `packages/payroll` stays exactly where it is, untouched; the legacy banner says it is the reason the repo is kept; `reference/statutory-rates-2026.json` travels with its SSS warning. |

---

## 9. Definition of done

1. `public` contains zero tables; `auth.users` still contains Chan's account; the snapshot is
   on disk.
2. `npm run build && npm test` green in CI on Node 20 and 22.
3. **The 27-attack RLS suite runs in CI on every pull request** and prints
   `ALL PASS (canary correctly failed)`. Not run by hand, not run once — every PR.
4. The integration test walks `create → submit → verify → clear` across a real HTTP boundary
   and asserts three ledger rows and the resulting balance.
5. Four real people complete one real week: invites accepted → briefing → commitments locked
   → work → blocks declared and resolved → approvals → week closed → carry-overs and scores
   at the next briefing.
6. `git grep -n "serviceClient" apps/api/src` returns only uses with a comment above them
   explaining why they are system-level.
7. `LRA-HR/README.md` carries the legacy banner and nothing else in that repo has changed
   except `docs/STATUS.md`.

---

## 10. Chan's asks, 2026-09-10 (late)

Given verbally as he signed off for the night, with standing authority to apply migrations
directly and an explicit instruction: **"I expect things to review when I get back, not
things I have to do before you can continue another chunk."** Nothing here may end in a
state that blocks him.

His stated priority order: **features first, UI/UX polish incrementally** — "we will slowly
start to make the UI/UX better as we go but of course we put more priority to the features
for now."

| # | Ask | Status |
|---|---|---|
| 1 | A read-only visitor's refusals must be obvious, not silent failures | **done** |
| 2 | Task cards get **quick submit + block** via right-click, and a 3-dot button opening the *same* menu | **done** — one menu definition feeds both |
| 3 | Task modal: when it grows tall, the **comment list** scrolls, not the whole modal | **done** |
| 4 | Hide **reliability and hit-rate** from non-founder members | **done** — and cycle time; stripped from the payload, not hidden. Also closed a leak on the briefing, which computes its own hit-rate |
| 5 | The Monday lock, and the GM's edit-request path | **done** — enforced, UI built, and attacked directly at PostgREST |
| 6 | Keep testing; everything must actually work | standing |

### 10.1 The Monday flow, in his words

> "Every Monday there's a stand up meeting in the morning, everyone gets assigned their
> tasks, they have to do their backlogs and the usual stuff. Once the meeting is concluded,
> those todos should be set and not editable by the staff. Only admin and founder. GM can
> flag for edits with the founder (LRA) or admin (me) approving the edits."

What existed before tonight: `ops.close_briefing` moves the week out of `planning`, and a
trigger then refuses changes to `is_committed`. **That was the only thing locked** — a staff
member could still rewrite a committed task's title, type (and so its points) or owner after
the meeting, which defeats the lock entirely. The record of what was promised on Monday is
precisely what this system exists to make un-rewritable.

**The distinction that must not be blurred:** the lock is on a task's *definition*, never on
its *progress*. Staff must still move status, add notes, and declare or resolve blocks after
the meeting — otherwise the app is unusable for the people it is for.

The GM's path is a **proposed change that carries its content** and is applied atomically on
approval — not a temporary unlock. An approver must see exactly what they are approving; an
open editing window approves nothing in particular. Modelled on the existing
`ops_cancellation_approval` flow rather than a new pattern. Approval is
`core.is_clearing_founder()`, which admits admin and correctly excludes the read-only ERC and
DCA founders.

### 10.2 Why points exist, restated by Chan

> "The use of the point system is also for the staff to track their progress and stay
> accountable on their own. Velocity and accountability is important."

This is a **design constraint, not a nice-to-have**: points are a self-tracking instrument
for the person doing the work, not only a management readout. It is also why ask #4 is not a
contradiction — a staff member keeps their points and velocity, and it is the *reliability
score and hit-rate* (the judgement of them) that becomes founder-only.

**Judgement call flagged for Chan:** he said "non-founder", so this was implemented as
founder + admin only. Whether the **GM** should see reliability is genuinely ambiguous — the
GM manages the team but is also measured by the same instrument. Including them is a one-line
change; say the word.

---

## 11. Chan's asks, 2026-09-10 (overnight)

Given with the same standing authority as §10 and the same instruction restated:
**"dont stop to report back to me. stop when there's something i actually have to
review."** Nothing here may end in a state that blocks him, and nothing here is a
question put back to him unless proceeding either way would be unsafe.

| # | Ask | Status |
|---|---|---|
| 1 | Now-page tasks must be **interactable** | in flight |
| 2 | **"users cant unblock a task, fix it"** | in flight |
| 3 | Make it **clear which tasks you're blocking and which you're not** | in flight |
| 4 | Scoreboard: denser, no raw points, three buckets, earned-vs-possible, four periods, a card per person in a horizontal rail | in flight |
| 5 | "outside of these, keep going and improve UX as you go" | standing |

### 11.1 Ask #2 had TWO root causes, and the first one was not about permissions at all

**Root cause 1 — every bodyless POST in the web app was dead before it left the browser.**
Reproduced with curl against the running API, not reasoned:

```
POST /api/blocks/:id/resolve   ->  400
{"code":"FST_ERR_CTP_EMPTY_JSON_BODY",
 "message":"Body cannot be empty when content-type is set to 'application/json'"}
```

`apps/web/src/lib/api.ts` set `Content-Type: application/json` on **every** request, and
`api.post(path)` with no second argument sends `body: undefined`. Fastify's JSON
content-type parser was therefore handed a request that declared a JSON body and contained
none, and refused it **before the route handler ran.** The request never reached the
database, which is exactly why the failure looked identical for the block's creator, the
person named in it, oversight and admin alike: **no permission rule was ever consulted.**

It was never only about blocks. Seven call sites were dead the same way:

| Path | What it does |
|---|---|
| `POST /api/blocks/:id/resolve` | resolve a block — from the task modal **and** the board |
| `POST /api/notifications/:id/read` | mark a notification read |
| `POST /api/tasks/:id/commit` | commit a task to the week |
| `POST /api/weeks/:id/generate-recurring` | generate a week's recurring tasks |
| `POST /api/weeks/:id/briefing/open` | **open the Monday briefing** |
| `POST /api/weeks/:id/briefing/close` | **close the Monday briefing** |

That is most of the Monday flow — the thing this system exists for — broken from the UI,
while every one of those endpoints passed its own API-level test, because the tests call
the routes directly and never go through `lib/api.ts`. **The seam between the client and
the API had no test at all, and that is where the bug lived.**

Fixed once, at the source: the header is sent only when there is a body. Verified by
driving all five non-destructive paths with curl — each now returns a real domain refusal
(`404 task not found`, `422 unknown week`, …) instead of the content-type error. `briefing/
close` was deliberately not called: closing a week is irreversible.

**Root cause 2 — and the mirror was on the wrong side of it.**

Underneath the content-type bug there was a second, genuine permission defect — and it is
still real, because with root cause 1 fixed the request now reaches RLS and gets refused.

`ops.task_blocks_update` grants the block's `created_by`, its named `blocking_user_id`,
or `core.is_oversight()`. The board's detail modal gated its Resolve control on
`isOversight || task.owner_user_id === me.id`. **Those are two different sets, and the
mismatch runs in both directions:**

- a task's **owner** who did not declare the block was shown a Resolve button the
  database would refuse — Chan's report, exactly;
- the staff member who **declared** the block was allowed by RLS but had the button
  hidden from them.

So the fix is two-sided, and the database half is the substantive one: **the owner of a
blocked task is a legitimate resolver.** They are the person who finds out first that
the thing they were waiting on has arrived, and denying them the resolve is what turned
the whole Blocked column into a dead end — a card that can enter and never leave.

The lesson generalises past this one policy: **a client-side permission mirror that was
never diffed against the policy it mirrors is not a mirror, it is a second opinion.**
`lib/task-permissions.ts` was written with exactly this discipline for `moveRefusal`
(one refusal string per `raise exception`); the block panel simply never got the same
treatment. Every remaining write surface in the web app should be diffed against its
policy the same way — that is the pattern to search for, not this one instance.

### 11.2 Ask #3 is an information-architecture problem, not a styling one

"Which tasks you're blocking and which tasks you're not" are two different relationships
to a block that the app rendered identically:

- **your work is stuck** — someone or something is holding *you* up. This is the
  exoneration side; PRD §5.2 already promises the reliability formula will not count it
  against you, and the screen should say so.
- **you are holding someone else up** — the accountability side. This never had a
  surface at all, despite `ops.task_blocks.blocking_user_id` existing since Phase 3 and
  the reliability formula already charging a modifier for it (`hoursBlockedByThem`).

A person was being scored on hours of other people's work they had blocked, with **no
screen that told them they were blocking anything.** That is the defect. `/api/now` gains
`blockingOthers[]` and the Now screen gains the section for it.

### 11.3 Ask #4: killing the raw-points readout without hiding the cap

Chan: "i dont see a point in seeing the raw points." He is right that
`cappedScore / rawClearedPoints raw` on every row is noise — it shows a second number on
every row to explain a haircut that applies to some rows some weeks.

But §2.6 is explicit that the recurring cap must never land as a **silent** haircut, and
that constraint outlives the readout that was serving it. So the two-number readout goes
and the disclosure stays, moved to where it actually applies: when a person's capped
score differs from their raw cleared total, the card must still be able to tell them so.
Deleting the readout and the disclosure together would have been the easy reading of the
instruction and the wrong one.

The four buckets (`toDo` / `pending` / `completed` / `atRisk`, against `possible`) are
DESIGN §6's bank-balance metaphor applied to a person instead of a task, which is why
they are named in that vocabulary rather than a new one. `cancelled` is excluded from
every bucket **and** from `possible` — a cancelled task is not a point someone failed to
earn, and putting it in the denominator would quietly punish people for work the company
called off.

### 11.4 Judgement calls made tonight, all one-line reversals

Flagged rather than silently chosen, per Chan's standing rule.

1. **Read-only accounts are off the scoreboard rail.** ERC and DCA are read-only founder
   accounts belonging to the two other brokerages' principals — they watch LRA, they do
   not work in it, and they can never own, submit or clear a task. Their cards were
   therefore permanently empty seats: not "scored zero this week" but *cannot ever
   score*, which is a different claim and one the card had no way to make. They still
   **see** the whole scoreboard — read-only is a flag on the write half, never the read
   half. Filtered in the list handler, not in `buildScoreboard`, so
   `GET /api/scoreboard/:userId` still resolves their own profile instead of 404ing with
   "not an active ops member," which would be false. `routes/briefing.ts`'s standup
   scorecard walks the same roster and **still lists them** — that screen is about who is
   in the room, arguably a different question, so it was left alone rather than changed by
   extension.
2. **The recurring-cap disclosure is scoped to the This-week window.** `cappedScore` is a
   weekly figure by construction, so claiming a this-week haircut against a 13-week total
   would have been a quieter lie than the two-number readout Chan asked to delete.
3. **`periods.all` is not re-anchored on `?weekId=`.** "All time" means all time even when
   the caller is inspecting a past week.
4. **A zero carries no tone.** `.num-pending`'s amber and dashed underline mean "these
   points exist and have not cleared yet"; painted on a `0` it announced a debt that was
   not there, and on a card with three zeroed buckets it was the loudest thing on screen.
5. **Read-only accounts are not offered as a block target, a task owner, or a
   reassignment target either.** Same reasoning as #1, applied to every picker that names
   a person: a read-only founder cannot start, submit, clear or resolve anything, so
   naming one asks for something they are structurally unable to give — and in the block
   case it would still charge them a reliability point every 8 hours the block stayed
   open. Three call sites: `task-detail-dialog.tsx`'s person picker,
   `create-task-dialog.tsx`'s owner select, `task-edit-request-dialog.tsx`'s reassignment
   select. `readOnly` is optional on every client-side `Member` type on purpose — a
   payload that does not carry it must never accidentally exclude a real teammate.

### 11.5 One migration is written but NOT applied — Chan's paste, as usual

`supabase/migrations/20260910190000_ops_task_block_owner_resolves.sql` — the database half
of ask #2 — **has not been applied to `ttrjzyyuktropkufkcoj`.** This is the project's
standing arrangement, not a new obstacle: no agent here has ever held DDL credentials, so
migrations go through the Supabase SQL editor. Paste-ready as
**`supabase/APPLY-BLOCK-OWNER-RESOLVES.sql`**, same convention as the three `APPLY-*.sql`
files already in that directory.

`scripts/run-rls-tests.sh` needs the same credential, so the **nine new assertions written
for this policy have never run.** They will on the next `npm run test:rls`.

**Consequence, stated plainly.** Resolving a block **works today** for the three
identities the live policy already grants — the block's creator, the person it names, and
oversight — because root cause 1 (§11.1) is a client fix and is already in. Verified
end-to-end in the browser: a person-target block was raised from the task modal, appeared
on the named person's Now screen under "Work you are holding up," and was resolved by
them.

The **one** case still refused until this migration is applied is a task's owner who
neither raised the block nor is named in it and is not oversight. The client mirror
(`blockResolveRefusal`) reflects the post-migration policy, so the UI offers them the
action and the database declines it — as `409 BLOCK_NOT_OPEN`, "That block is already
resolved, or it is not yours to resolve." Wrong for that person, but a sentence rather
than a stack trace.

**Verified against the live database after Chan applied it (2026-09-10, in the browser):**
GM raised an external block on Broker's task; Broker — the owner, who neither raised it nor
is named in it and is not oversight — resolved it. The block now reads "Was waiting on
Manila port authority · raised by GM (demo) · resolved by Broker (demo)". That write was
refused an hour earlier. Demo state restored.

### 11.6 A third defect, found while verifying the second

**Choosing an action from a task card's 3-dot menu also opened the task modal on top of
whatever the action opened.** Reproduced, then root-caused from a captured stack trace
rather than guessed:

`TaskCardMenuButton` renders its menu through `DropdownMenu.Portal`. A Radix portal moves
the menu's DOM node to `document.body` but leaves it **a child of the card in the React
tree** — and React dispatches synthetic events along the fiber tree, not the DOM tree. So
clicking "Declare a block" inside that portal propagated up to the card's own `onClick` and
opened the detail dialog over the block dialog the menu item had just opened, inerting it.

The trigger button's existing `stopPropagation` could never have helped: the click that
matters lands on the menu ITEM, in the portal, not on the trigger. **The right-click path
never had the bug, and that is what isolated it** — `TaskCardContextMenu` wraps the card
from the outside, so its portal's fiber chain does not run through the card's handler.

Fixed by comparing against the real DOM subtree in the card's `onClick`
(`if (!e.currentTarget.contains(e.target)) return;`) rather than patching this one menu —
a click that did not physically happen inside the card is not a click on the card, and that
holds for any portalled control put inside a card later. Verified both ways in the browser:
the menu now opens exactly one dialog, and clicking the card body still opens the task.

Everything else this session is applied, built and tested.

---

## 12. Chan's asks, 2026-09-10 (leaving for the day)

> "keep working on the project. i want it to be good and perfect. btw i want you to group
> the columns. backlog and this week should be on the same column just on switchable tabs.
> verified and cleared should also work the same. keep going and ping me on my remote
> control if you need any input but if there are commands to run, run them on your own. do
> not ask me to run anything since i will only have my phone."

**Operating constraint for this stretch: he has a phone and nothing else.** No command may
be handed to him, and no work may end in a state that waits on him. A question worth his
time goes to remote control; anything else gets a defensible decision and a flagged
one-line reversal.

| # | Ask | Status |
|---|---|---|
| 1 | Group the board columns: Backlog+This week tabbed, Verified+Cleared tabbed | in flight |
| 2 | "good and perfect" — keep hardening | standing |

### 12.1 Grouping is an information-architecture change, not a layout tweak

Seven lanes become five (Backlog/This week · In progress · Blocked · Submitted ·
Verified/Cleared), and the full specification with its nine already-made decisions is
`.claude/state/CONTRACT-BOARD-GROUPING.md`. Two of those decisions are the ones that matter,
because they are where this change goes wrong:

- **Dimming is per tab, never per group.** `this_week` is deliberately never a drop target
  ("this week's commitments are set in the Monday briefing, not on the board"), so a lane
  that dims as a whole would look dead on *every single drag*. Both tabs of a group are
  their own droppables, the tab strip stays live during a drag, and a card can be dropped
  onto "Cleared" without switching to it first.
- **A tab may hide cards; it may never hide the existence of work.** Both tab counts are
  always visible, and — the sharp edge — the board's search and owner filter must not be
  able to bury a match in the inactive tab. When the active tab has no matches and its
  sibling does, the empty body offers a control that says so and switches. A person who
  searches for a task and is told nothing exists will conclude the record was lost, which
  is the exact opposite of what this system is for.

`lib/task-permissions.ts` is untouched and `moveRefusal` does not learn about groups. A tab
is a presentation of an existing column; the ladder stays the ladder.

### 12.2 What "keep going" was spent on

An adversarial pass over every screen except the board, aimed squarely at the class of
defect §11.1 exposed: **a client/API seam that no test covers.** Seven write paths were dead
from the UI while every one of their endpoints passed its own API test, because those tests
call Fastify routes directly and never go through `apps/web/src/lib/api.ts`. Endpoint tests
are not evidence that a button works. So the instruction to the tester was to exercise every
write action *through the browser*, not through the router.

### 12.3 The service-role read-only gap, swept to completion

A peer session found that `/admin/settings`, once opened to founders, handed ERC and DCA
eight editable inputs and a live Save that `ops.settings`' RLS would refuse — and then that
`routes/admin.ts` had no read-only guard at all. Both are instances of one mechanism:

**RLS's `not core.is_read_only()` cannot protect a service-role connection.**
`core.is_read_only()` reads `core.auth_user_id()`, which is null as the service role, so it
returns `false` for everyone. Any router whose writes run on `serviceClient` therefore has
no read-only guard unless it makes the check itself.

Rather than stop at the reported instance, the whole pattern was swept: 20 `serviceClient()`
call sites across 10 route/service files. All but two are read-only name/roster joins over
rows already fetched on `userClient`. The service-role **write** paths are exactly two:

| Router | Writes | Status |
|---|---|---|
| `routes/admin.ts` | the provisioning surface — invite, patch, delete, restore, purge | guarded by the peer |
| `routes/jobs.ts` | `drain-outbox` (inserts `core.notifications`), `flag-stale` (flags tasks) | **was unguarded** |

`jobs.ts` is `requireAuthority('admin')`-gated, and an account can hold `authority = 'admin'`
**and** `read_only` simultaneously — `/admin/users` can create one in two clicks. Such an
account kept both jobs while every screen told it, correctly, that it could change nothing.

The guard is now **one** hook, `refuseReadOnlyWrites` in `middleware/auth.ts`, used by both
routers — extracted only once `jobs.ts` became the second real consumer. Two routers making
the same security decision by hand is one of them drifting later, which is the same
hand-copied-mirror defect §11.1 describes. The invariant is recorded on the hook itself:
**any new router that writes on `serviceClient` must add it.**

Pinned by `apps/api/test/read-only-writes.test.ts` (11 assertions: every mutating verb
refused with a readable 403 `READ_ONLY_ACCOUNT`, every read verb allowed, a normal admin
untouched). **Honest gap:** there is no seeded read-only *admin* to drive it end-to-end —
ERC and DCA are read-only *founders*, refused a step earlier — and creating one on the live
project purely to test it was not worth the residue. So the hook is proven at the unit
level, and the live check only confirms the router still loads and refuses non-admins
(`403 This action requires one of: admin` for founder-demo and erc-demo).

**The general rule worth carrying forward:** widening *who can reach a screen* is not the
same decision as widening *who can write from it*. A read-only account makes those two come
apart every single time, and only one of them is ever remembered.

### 12.4 The invariant is now checked, not commented

A peer made the observation that mattered more than either fix: **the invariant in §12.3 was
a comment, and a comment is exactly what silently failed.** "Any new router writing on
`serviceClient` must add this hook" held in `admin.ts` and quietly did not in `jobs.ts` —
and it was unfindable by reading `admin.ts`, because `jobs.ts`' writes live one import away
in `services/`.

`apps/api/test/service-role-guard.test.ts` checks it mechanically:

1. **Detect** the modules that perform a service-role write — a variable bound *solely* to
   `serviceClient()` with a write verb called on it. Variable granularity is load-bearing:
   `db` means the service role in `admin.ts` and the caller's own client in `tasks.ts`, so a
   name-blind or file-membership scan reports the wrong files. Today: `routes/admin.ts`,
   `services/outbox.ts`, `lib/supabase.ts`.
2. **Classify** them in a declared table, one written justification each. A new
   service-role write anywhere fails the test until someone decides which kind it is.
   `lib/supabase.ts` is declared but excluded from the "primary" set: `writeAudit()` and
   `enqueueNotification()` run as the service role *by design regardless of caller* and
   only ever downstream of an action RLS already gated — an audit row must be written even
   for a caller with no right to write the audit table, which is the whole point of one.
3. **Walk** each router's local imports transitively and assert every router that can reach
   a *primary* service-role write registers `refuseReadOnlyWrites`. No depth cap: the shape
   that defeats one already exists (`jobs.ts` → `services/stale.ts` → `lib/supabase.ts`).

**Both controls, because a check can fail in two directions.** A positive control asserts
the detector finds `admin.ts` and `outbox.ts` — a detector matching nothing would pass
forever. Negative controls assert it never flags `catalog.ts` (which mentions
`serviceClient` only in a comment recording that it deliberately avoids one) or
`settings.ts` (whose own write is on `userClient` and which merely imports `writeAudit`).
For a check like this, **matching everything is the likelier failure and the more dangerous
one**, because it trains whoever hits it to add a declaration rather than look. Both
assertions are exact sets, not supersets: a `contains` assertion lets the next real gap hide
inside a long list.

**Proved red twice** — a green invariant test is worth nothing until it has been seen to
fail. Removing the hook from `jobs.ts` produces 2 failures including the named "the instance
this test exists for"; adding a throwaway router that imports `drainOutbox` without the hook
produces 1 failure naming the new file and printing the fix. `apps/api`: 70 → **87 tests**.

**Residual hole, recorded rather than left implicit:** the declared table is a human
artefact. If a *primary* service-role write is later added to `lib/supabase.ts`, the
exact-set assertion stays green because that module is already declared. Closing it would
need symbol-level dataflow; the risk is noted in the table entry itself.

### 12.5 Board grouping shipped, and the sticky header DESIGN asked for

Seven lanes are now five, per §12.1 and the contract's nine decisions. Both hard cases hold:
per-tab dimming (verified mid-drag — the Plan lane stays live with only the This week tab
greyed, carrying `moveRefusal`'s briefing sentence), and filtered counts on both tab chips
with a clickable "3 matches in Cleared" in an empty body. `lib/task-permissions.ts` is
untouched and `moveRefusal` never learned about groups. `lib/board-groups.ts` holds every
decision as pure, tested functions — 16 of the web app's 104 tests.

The tablist is hand-rolled rather than Radix. Each tab header is a `useDroppable`, which
with Radix would need `asChild` plus ref composition — the exact indirection behind §11.6's
portal defect — and all it buys is roving focus, which is a few lines and a unit-tested
`nextTabIndex`.

**Two things I fixed on top of the lane's work.**

**The sticky lane header — DESIGN.md §13's requirement, never implemented, and grouping made
it bite harder.** A 29-card Cleared tab scrolled its own tab strip off the top of the
screen, so the control you need in order to switch back was exactly the thing that
disappeared. The reason it had never worked is worth recording, because it will recur:
`position: sticky` resolves against the nearest scroll container, and the lane scroller
already was one on both axes (per the overflow spec a non-`visible` `overflow-x` computes
`overflow-y` to `auto`) — but with an unbounded height it never actually scrolled
vertically. The page did, and a sticky header inside it slid away with its lane. So the
board now fills `<main>` and scrolls internally: `h-full` flex column, `flex-1 min-h-0` on
the scroller. `min-h-0` is load-bearing, the same trap `app-shell.tsx` already documents for
`<main>` itself.

**What I deliberately did NOT do:** make the five lanes fit at 1440px. Five × 288px + gaps
overflows a 1200px content area, so the board still scrolls horizontally, and the temptation
is to shrink the lanes now that there are fewer of them. DESIGN.md §11 forbids it in as many
words — *"7 columns means horizontal scroll below 2100px — that is correct, do not shrink
the columns to fit"* — and the reason is density: 288px is what a card's title, owner, chips
and point value need without truncating. Grouping bought a shorter scroll, not a scroll-free
board, and that was the right thing to buy.

### 12.6 The adversarial pass, and its four Majors

An adversarial sweep of every screen except the board returned 0 Blocker / 4 Major / 7 Minor
/ 5 Nit, plus 4 whose fix lands in another session's files. All four Majors are fixed and
each was verified in the running app, not reasoned about.

**1. A permanent delete succeeded while telling the person it had failed.** `api.ts`'s
`request()` ended with `return body.data`, and `routes/catalog.ts` answers `204 No Content`
— so `res.json()` rejected, `body` was `null`, `body.data` threw a `TypeError`, and the
delete dialog's `catch` dressed that up as the domain lie *"Could not delete this — it may
already have been used by a task."* The catalog type was already permanently gone.

This is the **same class as §11.1's `Content-Type` defect**: the client assuming every
response looks like the common case. A destructive action that succeeds while reporting
failure is worse than one that fails — the person tries again, or believes the record
survived. Fixed with a no-content check ahead of the error branches, plus its inverse: a
2xx that is *not* no-content must carry `{ data }` or it throws, so a genuinely broken
endpoint cannot silently render as an empty screen. Verified by creating a throwaway catalog
type and deleting it through the UI: row gone, count 16 → 15, no error, nothing else touched.

**2. "Work you are holding up" accused people of blocking already-cleared work.** The held
tasks query had no status filter, unlike `myTasks` beside it, so a row could read `Cleared`
and *"Waiting on you"* side by side — and because nothing auto-resolves a block when its
task clears, the reliability formula kept charging the named person −1 point per 8 hours,
forever, for work nobody was waiting on. "Clear the task, forget the block" is the normal way
of working, not an edge case. The block row is deliberately left open rather than
auto-resolved: `ops.task_blocks` is append-only and a resolve is an attributable act, so
inventing one on a *read* would be the API forging someone's signature. The screen simply
stops reporting it.

**3. Read-only observers were handed an approval queue they can never act on.** ERC and DCA
hold `founder` authority, so an authority-only test showed them *"Verified, waiting on you to
clear"* — as it did any founder without the clearing seat. Fixed server-side, and then the
client's own copy of the rule was **deleted rather than corrected**: `/api/now` now returns
`canActOnApprovals` and the screen renders what it is told. A third place for this rule to
have to agree is how §11.1 happened. Verified: ERC no longer gets the section at all (hidden,
not rendered empty — Chan's "it should just stay blank"), and a GM still does.

**4. "My points" showed the whole company's ledger.** `/api/points/ledger` returns every row
when no `userId` is given — deliberately, because `/admin/everything` is its other consumer
— and `/points` omitted the parameter, rendering all 107 rows for all four people,
unattributed. Not an RLS hole (any ops member may read the ledger, PRD §6.1), but a person
cannot audit their own points against a list that is not theirs, which is the only reason
that screen exists. Its sibling `/api/points/me` defaults to the caller, and that
inconsistency between two endpoints in one router is what made it easy to get wrong.
Verified: founder now sees 7 own rows, and the `+3` cleared row reconciles with the
"Cleared this week 3" figure above it.

**Still open, deliberately:**
- `/queue` and `/digest` hang on the app's loading state forever when the API is down, while
  every other route shows a Retry panel. Root cause is exact (`App.tsx` has a loading branch
  and no error branch) but that file belongs to another session; routed to them.
- **`/admin/everything` and `/admin/audit` have had zero UI coverage**, because none of the
  six demo logins holds `admin` authority. That is a hole, not a pass. Creating an admin demo
  account is a permission change on the highest-privilege class in the platform, so it waits
  for Chan rather than being done quietly.
- The briefing open/close and any Clear/Verify were not exercised: irreversible. **The Monday
  flow's two most important writes remain browser-unverified** — the thing to fix first with
  a disposable week.

### 12.7 Three defects, one lesson about this project's tests

Three of today's worst defects share a shape, and it is worth stating once rather than
rediscovering a fourth time.

| Defect | Endpoint test says | Reality |
|---|---|---|
| `Content-Type` on bodyless POSTs (§11.1) | seven endpoints green | seven buttons dead before the handler ran |
| `204` on a permanent delete (§12.6) | endpoint correct | UI reported the exact opposite of what happened |
| Settings audit row (below) | `PATCH /api/settings` → 200, correct body | the audit row was never written |

**This project's tests verify what a handler returns. Its bugs live in what the handler does
on the way** — the header it sends, the status it answers with, the side effect it writes.
Every one of these was invisible to a test that calls the route directly and asserts on the
response body, and every one was obvious within a minute of driving the real thing.

**The settings audit row does not write, and the reason it went unnoticed is the point.**
`core.audit_logs.entity_id` is `uuid`; the route passes the string `'settings'`; Postgres
refuses it with `22P02`; and `writeAudit` catches that into a `console.error`. So the
business write lands and the audit row silently does not. Verified by changing
`stale_after_days` 3 → 4 through the UI (save succeeded, `audit_logs` stayed at 53 rows, 0
of them settings) and reverting — the row is byte-identical to baseline. The fix belongs to
another session's file and is routed to them: `entityId: undefined`, since `ops.settings` is
a singleton keyed `id = true` and `entity_type` already identifies it.

**Fixed and independently verified (2026-09-10).** The id was dropped rather than invented,
and every other `writeAudit` call site was swept — `admin.ts` and `stale.ts` all pass genuine
uuids, settings was the only one. Re-driven through the UI: `stale_after_days` 3 → 4 → 3
produced **two** audit rows carrying the real before/after (`{"stale_after_days":3}` →
`{"stale_after_days":4}`, then the reverse), `core.audit_logs` went 53 → 55, and the settings
row is back at baseline. The trail is a complete and correct record of exactly what was done.

The deeper problem is `writeAudit`'s own contract. Its comment promises an audit failure is
"logged loudly so the gap is visible rather than silently swallowed" — but `console.error`
on a server nobody is tailing **is** silently swallowed, and what it swallowed here was the
audit trail for the single highest-impact write in the system: the parameters that rescore
every person retroactively across the scoreboard's 13-week windows. Not throwing is correct;
an audit failure must not roll back a legitimate business action. But *not throwing* and
*nobody finding out* are different choices and we currently have the second. **The audit
table can stop working and no one learns until they go looking for a row that was never
there.** Raised rather than changed — `lib/supabase.ts` is shared ground — and then **closed**: audit
failures are now counted and surfaced by `GET /health`, which degrades to `'degraded'` when
any write has failed. A service that is still serving but has stopped keeping the record it
promises to keep should not report `'ok'`; that is the same category of lie as the audit row
that was not there. Live: `{"status":"ok",...,"audit":{"failures":0,"last":null}}`. A counter
was chosen over a boot-time self-test — a self-test that writes and deletes a row on every
boot is more intrusive and catches only schema mismatch at boot, while a counter catches any
failure at any time and costs nothing.

### 12.8 The technique for testing an unreachable API

Both sessions independently reached for `SIGSTOP` on the shared API, and both were wrong.
Mine was worse than useless: server paused, the browser navigation then refused by this
session's own permission classifier, and no way to look at the thing I had just broken.

**The method that works touches nothing shared:** point `apps/web/.env`'s `VITE_API_URL` at
a dead port, restart only the Vite on 5173, drive, then restore. `:3099` stays up for every
other session the whole time, and there is no CORS trap because there is no server there to
refuse the origin. Two people making the same wrong move an hour apart is a good sign it is
the obvious one, which is exactly why it is written down here instead of remembered.

### 12.9 Scoping the disposable week — the trap to avoid

The Monday briefing's `open`/`close` and every Clear/Verify have **never been driven through
a browser**, because they are irreversible. After §12.7 that matters more than it looks:
three-for-three, this project's defects have had a correct response and a broken side
effect, so "the endpoint tests pass" is demonstrably the wrong evidence for exactly these
two transitions — and they are the ritual the whole system exists for.

**The trap, and it is the tempting one:** clicking open and close once, seeing no error, and
calling it verified. The seam these three defects lived in is invisible to a click too.
Opening a week writes a ledger, generates recurring tasks and stamps a briefing; closing it
scores everyone. **Any of those can half-happen behind a 200.** A click proves the request
was accepted; it proves nothing about what the handler did on the way.

So the requirement is that the week be **inspectable after the fact, not merely survivable**:

- seeded and named as disposable, so nothing downstream — scoreboard windows, reliability
  ratios, carry-over counts — silently counts it as a real week;
- assertions on the *side effects*, row by row: the ledger rows written, the recurring tasks
  generated (and the idempotency of a retried generation), the briefing stamp, the closing
  scores;
- reversible or throwaway, so the second run is as cheap as the first. A test you can only
  run once is a test nobody runs.

That is a piece of work to scope, not a brave click at the end of a session, which is why it
is written down here rather than attempted. Credit where due: the framing that a click is as
blind as an endpoint test came from the peer session, and it is the argument that turns
"try it on a quiet Monday" into an obviously bad plan.

---

## 13. Chan's asks, 2026-09-10 (evening)

> "go do everything you said. but make sure for the monday briefing one the admin and
> founder be able to edit stuff. GM can send a request to edit (should be done by bulk like
> an edit feature on google docs), then approve by admin or founder showing what changed
> like before and after"

"Everything you said" is the three items §12.6 left open, plus a new feature. Full
specification: `.claude/state/CONTRACT-BULK-EDITS.md`.

| # | Item | Status |
|---|---|---|
| 1 | Bulk edit suggestions — GM proposes many, founder/admin approves one batch | in flight |
| 2 | Founder/admin edit the briefing directly | in flight |
| 3 | The disposable week, and driving the irreversible transitions | in flight |
| 4 | An `admin` demo login, for the two uncovered admin screens | pending lane C |
| 5 | Rotate the database password | **Chan only** |

### 13.1 Bulk is a wrapper, not a new mechanism

`ops.task_edit_requests` already carries, per item, `change_*` flags paired with `proposed_*`
columns for the five defining fields, plus `before_values` snapshotted at request time and
`after_values` filled from what was actually applied. **That is already Chan's
before-and-after.** So bulk adds `ops.task_edit_batches` and a nullable `batch_id` — NULL
preserving today's single-request behaviour exactly — and one atomic decide function that
sets each child's status so the **existing** apply trigger does the work. One apply path, and
it is the proven one.

Atomicity is the requirement, not a nicety. §12.7 records three defects whose shape was
"correct response, broken side effect"; a half-applied batch of edits to the locked Monday
record would be the worst instance of that pattern this system could produce.

### 13.2 Widening approval, and the trap inside it

Chan said "approve by admin or founder", which **supersedes** 20260910140000's deliberate
choice of `core.is_clearing_founder()`. The migration says so explicitly rather than leaving
a comment that contradicts its own code.

The trap: `core.is_founder()` admits admin — which he asked for — but does **not** exclude a
read-only founder, and ERC and DCA both hold `founder` authority. Without
`and not core.is_read_only()`, two outside observers could approve edits to the record this
entire system exists to make un-rewritable. That is the same defect class found three
separate times on 2026-09-10 (§12.3, §12.6), which is why it is called out in the contract
rather than left to be noticed.

### 13.3 The admin demo account — created, used, then deactivated

`/admin/everything` and `/admin/audit` have never had UI coverage because no demo login holds
`admin`, and Chan's own account is the only admin. He has now said go.

**The judgement, stated because it is a real one:** an admin credential is the most
privileged thing in this platform — admin bypasses `ops.enforce_task_transition` entirely at
statement 1 and holds the whole provisioning surface — and a demo one has a known password on
a live project whose auth endpoint is public. Against that: `apps/web/.env` and
`apps/api/.env` are both gitignored (verified — only `.env.example` is tracked), so no
password reaches git; `getDemoLogins()` gates the buttons behind two independent dev-only
checks; and `founder-demo` already carries comparable privilege by the same mechanism.

So the account is created through the sanctioned path (a persona in `scripts/seed-demo.mjs`,
exactly like the six that exist), used for the coverage pass, and then **deactivated** —
coverage obtained without leaving a standing admin credential live. Reactivating it for the
next pass is one flag. That is strictly better than either leaving it live or not covering
the screens at all.
