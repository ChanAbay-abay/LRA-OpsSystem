# LRA Global Ops Monitoring System

A weekly commitment instrument for LRA Global Synergy Chain Inc. — customs brokerage and
logistics, Cebu City. Read `PRD.md` first, then `PLAN.md`, then `DESIGN.md` (binding on
everything visual). `OPEN-QUESTIONS.md` records what is still unresolved.

**Status:** Phases 0–2 of `PLAN.md`. See the coder's Phase 0–2 report for exactly what
runs versus what is prepared and waiting on Chan. This README will grow into the full
operating manual `PLAN.md` §9 describes as later phases land; right now it covers what
exists.

## Repository shape

```
package.json              workspaces: packages/*, apps/*
supabase/
  migrations/              timestamped, one topic each — see below
  APPLY-TO-PRODUCTION.sql   consolidated Phase 0+1 DDL, ready to paste
  tests/rls_test.sql        RLS + write-path regression suite
  seed.sql                  local-only fixtures for `supabase start`
scripts/
  run-rls-tests.sh          runs the suite against $DATABASE_URL
  verify-db.mjs             post-migration acceptance check via PostgREST
  provision.md              the documented fallback if invite emails don't land
packages/ops-scoring/       @lra/ops-scoring — pure math, no I/O
apps/api/                   @lra/ops-api — Fastify 5 + zod + supabase-js
apps/web/                   @lra/ops-web — Vite 8 + React 19 + react-router 7
reference/                  statutory-rates-2026.json — kept for the future HR module
backup/                     pre-rebuild-snapshot.json — gitignored, PII
```

## The database

Three schemas after the rebuild: `core` (identity, authority, membership, notifications,
audit — the layer HR and CRM will sit on), `ops` (the only module built), and an
intentionally empty `public`. See `PLAN.md` §0 and §2 for the full design and reasoning.

**Migration tooling is the Supabase CLI**, invoked via `npx supabase@latest` — it is not
installed globally in this environment, by instruction. `supabase/config.toml` exposes
`core` and `ops` locally in addition to `public`; on the linked project, Chan appends the
same two schemas under **Supabase → Data API → Exposed schemas** by hand (append, never
replace — `public` must stay listed).

**There is no database password available to this environment.** DDL cannot go through
PostgREST, so:

- Every migration is a real file under `supabase/migrations/`, exactly as `PLAN.md`
  specifies, for when a connection string or CLI link exists.
- `supabase/APPLY-TO-PRODUCTION.sql` is the same SQL, concatenated in order, ready to
  paste directly into the Supabase SQL editor. **It drops the entire `public` schema.**
  Read its header before running it.
- **Chan applies it, not an agent.** After it is applied and the schemas are exposed,
  `node scripts/verify-db.mjs` (with `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` set) is
  the acceptance check: which `core`/`ops` tables are reachable, their row counts, and
  that `auth.users` still contains exactly Chan's one account.

### Local development

```bash
npx supabase@latest start        # requires Docker — not installed in this environment
npm run db:reset:local           # applies every migration + seed.sql, LOCAL ONLY
npm run test:rls                 # DATABASE_URL defaults to the local stack
```

There is deliberately no `db:reset` script — only `db:reset:local` — so the destructive
form against a *linked* project has to be typed out by hand, on purpose, by whoever
decides that's really what they want. `npm run db:push` applies migrations to the linked
production project via the CLI; it needs `supabase login` (or `SUPABASE_ACCESS_TOKEN`)
and `supabase link --project-ref ttrjzyyuktropkufkcoj` first, neither of which this
environment has credentials for.

### The RLS suite

`supabase/tests/rls_test.sql` runs inside one transaction that is rolled back, as
`authenticated` (never as the table owner, which bypasses RLS entirely), and ends with a
canary that **must fail** — if it passes, the suite is not exercising RLS and every result
above it is void. `.github/workflows/ci.yml`'s `rls` job runs it on every pull request
against a throwaway `supabase start` Postgres and greps the log for the canary line rather
than trusting a green tick.

Running it locally needs Docker, which is not installed in this build environment —
verified only by reading the suite and running it in CI, not by hand here.

## API — `apps/api`

Fastify 5. Two Supabase clients: `userClient(token)` (RLS applies — the default) and
`serviceClient()` (system-level only: audit writes, the outbox, provisioning, the auth
middleware's own profile lookup — each use is commented with why). Authority is read from
`core.users` on every request, **never from the JWT payload**.

```bash
cp apps/api/.env.example apps/api/.env   # fill in from Supabase → Project Settings → API
npm run dev:api
curl localhost:3001/health
```

## Web — `apps/web`

Vite + React 19 + react-router-dom 7. Tailwind + shadcn/ui over Radix, tokens copied from
`design/tokens.css` into `src/index.css` — `DESIGN.md` is binding on every visual value.

```bash
cp apps/web/.env.example apps/web/.env
npm run dev:web
```

## Provisioning

`POST /api/admin/users` (admin/Chan only) invites a teammate by email — idempotent, no
credential ever passes through this system. `scripts/provision.md` documents the fallback
if an invite email genuinely does not land.
