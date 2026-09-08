# LRA Ops — Open Questions

**Revision 2, 2026-09-08.** Unresolved decisions, each with the assumption the plan runs on
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

**Assumption: A.** `core.users.authority` is a plain column, so adding the other two is two
invites and nothing else. But if all three approve points, **any of them can clear a task**,
and that is worth Chan confirming before the first week runs — a task cleared by an uncle who
was not in the briefing is a governance question, not a bug.

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

## 9. Do the invite emails actually land? — **BLOCKS PHASE 2 in practice**

Locked: provisioning uses `inviteUserByEmail`, so no credential ever passes through this
system, an agent, or a chat log. **That depends on the GM, Sales and Broker each having a
working, monitored inbox** — plausible to fail in a four-person office.

The documented fallback is `auth.admin.createUser` with a one-time password Chan reads out in
person and the user must change on first login. It is written up in `scripts/provision.md` but
not built unless invites stall. **If Chan already knows the invites will not be read, say so
and the fallback gets built in Phase 2 instead of after it.**

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
