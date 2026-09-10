# LRA Ops — Open Questions

**Revision 3, 2026-09-09.** Unresolved decisions, each with the assumption the plan runs on
until Chan answers.

Items marked **BLOCKS PHASE N** must be answered before that build phase in `PLAN.md`.
**Wave 2** means post-MVP product scope (quotes, cash advances, document approvals) — not a
build phase. **Nothing here blocks starting Phase 0.**

Answered items are kept at the bottom rather than deleted, so a future session does not
re-ask them.

---

## 1. The real lifecycle of a Quote — **BLOCKS WAVE 2**

Confirmed: LRA is a customs brokerage, and the public site has a "Free Quotation" CTA, so
quotes originate partly as inbound web leads. Not known:

- Who creates a quote — Sales only, or the Broker too?
- What is on it: brokerage entity (DCA / ERC / LRA), client, commodity, HS code, estimated
  duties and taxes, brokerage fee, validity period, attachment?
- Is there a revision cycle — client counters, quote is revised, re-approved?
- Does an approved quote become a job/shipment, or is it just filed?
- Who approves at what amount? `APPROVALS-MODULE.md` says it depends on the brokerage.

**Assumption:** a `core.approval_documents` row typed `quote`, carrying `source`
(`web` / `phone` / `email` / `walk_in`) from version one, routed on
`(quote, brokerage, amount_band)`, with its history in `core.audit_logs`. Not built in the
MVP, and nothing in the MVP schema depends on the answer.

**This is also what blocks building `core.approval_flows` now** — see #12.

## 2. The real lifecycle of a Cash Advance — **BLOCKS WAVE 2**

- Who requests, who approves, at what amount bands?
- Is there a **liquidation** step with receipts? (Almost certainly yes.)
- **The overlap:** the deleted HR schema had `loan_type = 'company_cash_advance'` on a `loans`
  table with an approval chain, a running balance and payroll deduction wiring. Nothing is
  broken today because that schema is gone — but the concept returns the moment HR is rebuilt.
  Is an Ops cash advance the *same object* as an HR loan, or the *request* that produces one?

**Assumption:** two objects — the request and its history on one side, the payroll recovery on
the other — and an approved advance **creates** the loan row rather than duplicating it. Needs
Chan and the accountant, not an agent. Do not let the HR rebuild decide it unilaterally.
See `PRD.md` §7.5.

## 3. Point values in the seeded catalog — **BLOCKS PHASE 6**

Phase 3 seeds ~15 task *types* grounded in real brokerage and sales work — filing entries, BOC
clearance follow-ups, tariff classification, quotation turnaround, client follow-ups. The
**point values are deliberately not proposed**, and the guideline notes are drafts.

The catalog is the company's written statement of what it values. Ranking the value of work is
the founder's judgement about his own business, and an agent guessing it would launder a guess
into company policy. Every seeded note begins `DRAFT —` and `/catalog` shows a banner while any
remain.

**The founder must review and price the catalog before the first real Monday briefing.**
Commitments made against DRAFT values are not commitments. No assumption is safe here.

**Chan, 2026-09-09 — partially answered.** Arbitrary Fibonacci values were assigned so the
system can be exercised end to end during testing. **The `PLACEHOLDER —` prefix and the
`/catalog` banner deliberately stay**, because the numbers are a stand-in, not a decision.
Chan will sit down with the team to value each standard task. Until he does, this item is
still open and the gate on Phase 6 still stands.

## 4. Do the three new people need `core.people` codes assigned by hand?

**Assumption:** provisioning generates `LRA-002`, `LRA-003`, `LRA-004` sequentially, with Chan
as `LRA-001`. If LRA already uses employee numbers on paper, say so and they are used instead —
it is a text column and changing it later is a one-row update, but only before HR is rebuilt
and starts referencing them.

## 5. Founder accounts — one or three?

The old HR README said Chan's father *and his two eldest brothers* each get their own
`founder` account. The Ops brief names only "the founder."

- **A)** One founder account for now; the other two are added when they want in.
- **B)** All three provisioned in Phase 2.

**ANSWERED — Chan, 2026-09-09: three founder accounts, but only one of them can act.**

- **LRA** — the clearing founder. Clears points. `is_clearing_founder = true`.
- **ERC** and **DCA** — **strictly read-only.** They exist so the other two brokerages can
  keep tabs on everyone's progress. They see everything oversight sees and change nothing.
- Chan's admin account also clears, unchanged.

This is why "founder" is no longer sufficient as a write permission. Read-only is implemented
as `core.users.read_only` + `core.is_read_only()`, guarded on **every** write policy, trigger
and `security definer` RPC — not as a fourth authority value, because the read scope is
identical to a founder's and only the write half differs. The governance worry above is
resolved by construction: an uncle who was not in the briefing cannot clear anything.

**Chan, 2026-09-09: ERC and DCA are placeholders for now**, exactly like the existing founder
demo account, and both get a quick-switch pill on `/login`. Provisioned as
`erc-demo@ops-demo.invalid` and `dca-demo@ops-demo.invalid` by `scripts/seed-demo.mjs`,
`authority = 'founder'`, `is_clearing_founder = false`, `position = 'founder'`.

**They ARE read-only as of 2026-09-10.** Chan applied the migration and re-ran the seed;
verified directly against the database: `erc-demo` and `dca-demo` both carry
`read_only = true`, `founder-demo` carries `read_only = false`. Chan also confirmed by hand
that ERC cannot make edits in the app. The RLS suite passes 109/0 against these rules (#14).

Remaining on this: the write controls are still **visible** to an observer and merely fail
when used, which violates this app's own rule that the UI must never offer what the database
will refuse. The UI gating is in progress.

**Still needed from Chan, when the real accounts are made:** the actual email addresses, and
whether the LRA founder account is his father's or a shared brokerage inbox.

## 6. Leaderboard visibility — settled, but worth watching

Locked: everyone sees everyone, with `ops.settings.leaderboard_visibility` switchable to
`oversight_only`. With **three people** there is no anonymity in the middle of the pack, and a
public reliability score is a strong management instrument. Recommend Chan reviews it after two
real weeks and switches if it is generating friction rather than movement.

## 7. Who runs and closes the Monday briefing

**Assumption (locked as a default):** the GM opens and closes it; the founder can also do
either. Closing is audit-logged and cannot be undone from the UI; reopening requires the
founder.

## 8. Deployment target

**Assumption:** the same VPS as the old HR API, different port, separate systemd unit, own
subdomain, own `CORS_ORIGIN`. Built in CI and shipped as `dist/` — the box has 1 core and must
not build anything. Confirm the subdomain once Porkbun is set up.

**Chan, 2026-09-09 — deliberately deferred.** Deployment waits until the system is as complete
as it can be locally; he does not want to add hosting cost this early. Phase 9 stays last, and
nothing before it should assume a deployed URL.

## 9. Do the invite emails actually land? — **ANSWERED: yes**

Locked: provisioning uses `inviteUserByEmail`, so no credential ever passes through this
system, an agent, or a chat log. **That depends on the GM, Sales and Broker each having a
working, monitored inbox** — plausible to fail in a four-person office.

The documented fallback is `auth.admin.createUser` with a one-time password Chan reads out in
person and the user must change on first login. It is written up in `scripts/provision.md` but
not built unless invites stall. **If Chan already knows the invites will not be read, say so
and the fallback gets built in Phase 2 instead of after it.**

**Tested 2026-09-09, 21:45.** A live invite was sent to `ckca1221@gmail.com` (Chan's second
address, deliberately not accepted — this was a deliverability probe, not a provisioning run).
Supabase Auth returned **HTTP 200** with `confirmation_sent_at` set, so the invite was accepted
and handed to the mail sender. **That proves the API call, not the inbox** — Supabase's built-in
SMTP is rate limited on the free tier and is a common spam-folder casualty. The open half of
this question is now only whether Chan actually *received* it.

**ANSWERED — Chan, 2026-09-09: the email arrived.** Supabase's built-in SMTP works for this
project, and the `createUser` + one-time-password fallback is not needed. What remains open is
**9b below**, which is a different failure entirely: the mail lands, but the link inside it
goes nowhere useful.

The `auth.users` row `1a4a6ca2-cbab-477a-90f5-29f54b198d68` exists for that address as a
by-product and has no `core.people` / `core.users` / `core.memberships` rows behind it. It is
inert, but it should be deleted once Chan confirms receipt, or it will show up as a ghost in
`/admin/users`.

### 9b. The invite redirect is silently discarded — **BLOCKS PHASE 2 in practice**

Found and **reproduced** 2026-09-09 night, and it is the more serious half of this question.

`inviteUserByEmail` now passes `redirectTo: <web app>/set-password`, and `/set-password` is
built. **Supabase throws the redirect away.** Every value tested came back rewritten to the
project's Site URL:

| requested `redirect_to`                  | what Supabase returned  |
|------------------------------------------|-------------------------|
| `http://localhost:5173/set-password`      | `http://localhost:3000` |
| `http://localhost:3000/set-password`      | `http://localhost:3000` |
| `http://localhost:5175/`                  | `http://localhost:3000` |

Note the third row: even the **path is stripped**. This is not a near miss, it is a total
fallback to Site URL, which means the redirect allow-list does not contain these URLs at all.

**Consequence today: an invited person lands on `http://localhost:3000`, where nothing is
running, and can never set a password.** The whole invite path is cosmetically complete and
functionally dead. This, not deliverability, is what actually blocks provisioning the three
founder accounts.

**Chan's fix, in the Supabase dashboard — Authentication → URL Configuration:**
1. Set **Site URL** to the real web app origin (`http://localhost:5173` for now).
2. Add to **Redirect URLs**: `http://localhost:5173/**`, and the production origin when
   Phase 9 happens.

Nothing in the codebase needs to change; the API already sends the right value.

**The happy path itself is verified.** A genuine invite token was minted with
`admin/generate_link` (which returns the link without sending mail), and the flow was driven
in a real browser: token accepted, password set, signed in, landed in the app. So
`/set-password` works — it is simply unreachable by anyone who gets a real invite until the
dashboard is fixed. Three throwaway probe accounts were created for this and **all three were
deleted**; only `ckca1221@gmail.com` remains, on purpose.

## 10. Where does the database live once HR and CRM are rebuilt?

`LRA-OpsSystem` is currently the database's **system of record** — it owns every migration for
`core` and `ops`, and the Supabase CLI is adopted on that basis.

That works until HR is rebuilt in its own repo. Two repos owning one database is the exact
problem the wipe just escaped.

- **A)** HR and CRM repos consume the schema and never get a migrations folder; this repo keeps
  owning it. *(Planned, and written into the HR legacy banner.)*
- **B)** A dedicated `LRA-Platform-DB` repo is split out when the second module starts.

**Assumption: A now, B when HR actually starts.** A repo named `LRA-OpsSystem` owning the
company's identity schema is a naming problem long before it is a technical one.

## 11. Marking LRA-HR as legacy

**Assumption: yes**, and it is the only change to that repo:
a banner at the top of `README.md` and a rewritten paragraph in `docs/STATUS.md` saying the
`public` schema **was dropped and rebuilt** as `core` + `ops`, that nothing in that repo runs,
and that `packages/payroll` is the reason it is kept. No code is touched.

## 12. Should `core.approval_flows` be built now anyway? — **the one judgment call I flagged**

The brief named generic approval routing as part of the foundation. **I did not build it.**

Reasoning: zero consumers today (Ops task approval is a fixed two-rung ladder on a task, not a
routed document); Chan's standing rule forbids speculative abstraction; and the routing key is
`(document_type, entity/brokerage, amount)` — which cannot be designed correctly while #1 is
unanswered. Building it now risks a shape we have to migrate away from, in the one table whose
whole purpose is to never need migrating.

The seam is preserved instead: history (`core.audit_logs`) and delivery
(`core.notification_outbox`) are generic and built; the routing schema is written down in
`PRD.md` §7 and created in the same migration as its first consumer.

- **A)** Leave it designed-not-built. *(Planned.)*
- **B)** Build it now anyway — but then #1 must be answered first, and it becomes Phase 9.

**Assumption: A.** Say the word and it becomes B.

---

## 14. The RLS suite cannot be run from the Supabase SQL editor — **resolved, worth remembering**

Chan tried to run `supabase/tests/rls_test.sql` by pasting it into the dashboard's SQL editor
on 2026-09-10 and got:

    ERROR: 42P01: relation "t_results" does not exist

**Not a broken suite.** The web SQL editor splits a pasted script into separate statements, so
the temp tables the suite builds (`t_results`, `t_ids`, `t_meta`) vanish between them. The file
is deliberately one transaction, `begin;` through `rollback;`.

**What works, in order of preference:**

1. `psql "$DATABASE_URL" -f supabase/tests/rls_test.sql` (or `npm run test:rls`) — needs psql,
   which is not installed on Chan's machine.
2. **A single Supabase MCP `execute_sql` call containing the whole file verbatim.** One call is
   one session, so the temp tables survive. This is how the run below was produced.

**Result, 2026-09-10, against the live project:** `ALL PASS (canary correctly failed)`,
**109 passed / 0 failed**, both canaries correctly red. This is the first time the suite has
been run since attack 12 and the ~20-assertion read-only block were added, and it is what
turns the read-only sweep from "correct on paper" into "enforced by the database."

---

## 15. The migration ledger had drifted from the repo — **fixed, but worth knowing**

Found 2026-09-10 while checking whether CI would catch tonight's defects.

`supabase_migrations.schema_migrations` and `supabase/migrations/` had disagreed since Phase 0.
The seven Phase 0/1 migrations were recorded under the timestamp they were **applied**
(`202609081701xx`) rather than the version in their **filename** (`202609081200xx`), because
they went in by hand through the SQL editor.

**Why that mattered:** Supabase therefore considered those seven files unapplied, and
`npm run db:push` — a documented command in this repo's own `package.json` — would have run
them again. The first is `20260908120000_000_drop_legacy_hr.sql`, whose opening statement is
`drop schema public cascade`. It would have aborted on the next file (`core.people` already
exists), so it fails loudly rather than silently destroying data — but it drops a schema on the
way there, and nobody should discover that by running a documented command.

The seven ledger rows were renamed to match their filenames; nothing was re-run. `db push` is
now a no-op against this project.

Three ledger rows remain with no matching repo file
(`ops_view_security_invoker_and_rpc_lockdown`, and early duplicates of
`ops_restore_week_rpc_to_authenticated` / `ops_recurring_created_by_is_the_caller`). Those are
harmless — an extra recorded row means "already applied", which is true — and they are left
alone deliberately rather than deleted, since deleting ledger rows is the direction that causes
re-runs.

**Standing rule this produces:** any migration applied outside the tooling must be recorded
with the version in its filename. `apply_migration` stamps the current time, which sorted
**before** a dependency three times in one night — always check the recorded version and
correct it. See `docs/AGENT-LESSONS.md` §3.

---

## 13. HIBP leaked-password protection is off — a paid upgrade, not an oversight

Chan tightened the project's password policy tonight (min length 10, requires lower +
upper + digit). Supabase Auth also offers a "have I been pwned" leaked-password check on
top of that, but enabling it on this project returns `402` — it is gated to the Pro plan.
It is **off**, not misconfigured. Turning it on later is a dashboard toggle once the
project is on a paid tier, nothing structural.

---

## Answered — do not re-ask

- **The wipe.** Verified safe by a live row census: 47 rows total, all seed or derived from one
  employee, zero transactional data, an empty `audit_logs`, and one `auth.users` account
  (Chan's) which survives the rebuild. Snapshot at `backup/pre-rebuild-snapshot.json`,
  gitignored, PII.
- **What LRA's business is.** LRA Global Synergy Chain Inc., customs brokerage and logistics,
  Cebu City. `PRD.md` §0.
- **Whether GM / Sales / Broker have accounts.** **No.** Provisioning is `PLAN.md` Phase 2.
- **Architecture.** Shared `core` foundation + per-module schemas; `ops` is the only module
  built; `hr` and `crm` are designed for, not created. `public` is left empty. `PLAN.md` §0.2.
- **Authority model.** `core.authority` = `staff` / `gm` / `founder` / `admin`, separate from
  `core.memberships` (module + position). The old six-value `user_role` ladder is gone, and the
  rank-vs-function conflation that caused the stamp-forgery bugs with it. `PLAN.md` §0.4.
- **The forgeable-notification defect.** Designed out, not patched: no INSERT policy for
  authenticated callers on `core.notifications`; delivery goes through the outbox on the
  service path.
- **Migration tooling.** **Supabase CLI, adopted.** The revision-1 objection — that this repo
  would never contain HR's migrations — died with HR's schema. The decisive gain is
  `supabase start` giving CI a real Postgres, so the RLS suite runs on **every PR** instead of
  by hand. `db reset` is local-only and there is deliberately no `db:reset` script.
  `PLAN.md` §0.6.
- **Exposed schemas.** Chan appends `core` and `ops` in Supabase → Data API. Append, never
  replace.
- **Provisioning method.** `inviteUserByEmail`; admin-set passwords are the documented fallback
  only.
- **Web stack.** Tailwind + shadcn/ui + Radix, `@dnd-kit` for the board, driven by the 21st.dev
  MCP tooling.
- **Brand and design.** `DESIGN.md` exists at the repo root with `design/tokens.css` and is
  **binding**. LRA's public brand (navy / bright blue / cyan, Urbanist + Geist Mono), **light
  mode only** for the MVP, input borders `#CBD2E0` with the WCAG 1.4.11 gap documented rather
  than hidden. `PLAN.md` specifies no visual values.
- **Preserved assets.** `packages/payroll` stays in LRA-HR, untouched, with ~45 passing tests —
  it is the reason that repo is kept. `statutory_rate_config` seed copied to
  `reference/statutory-rates-2026.json` **with its warning**: the SSS salary credit is one
  bracket low for roughly half of all salaries, and the existing test locks in the wrong
  answer. Whoever rebuilds HR needs the real schedule from the accountant.
- **Standing defaults.** Recurring-cap floor of 3 points; the GM cannot verify their own task;
  GM and founder open and close the briefing.
