# LRA Ops Monitoring System — PRD

**Status:** revision 2, 2026-09-08. Draft for Chan's approval.
**Repo:** `LRA-OpsSystem`. Supabase project `ttrjzyyuktropkufkcoj`.
**Companions:** `PLAN.md` (how it gets built), `DESIGN.md` (binding on everything visual),
`OPEN-QUESTIONS.md` (what is still unknown).

> **Revision 2 changes the foundation.** Chan has decided to drop the HR schema and rebuild
> the database from scratch, knowing HR and CRM are coming. Ops is no longer a guest in
> someone else's database: it is the first module on a shared `core` foundation that this
> repo owns. The product below is unchanged. What changed is underneath it — see `PLAN.md`
> §0, and §2 here for the new authority model.

Everything marked `ASSUMED:` was not confirmed by Chan and is a guess made so the build
can start. Each one is cheap to change before the build reaches the phase named next to it;
several get expensive after.

**Terminology:** "Wave 2" means post-MVP product scope (quotes, cash advances, document
approvals). "Phase N" always means a build phase in `PLAN.md`. They are different things and
an earlier draft conflated them.

---

## 0. The business

**LRA Global Synergy Chain Inc.** — a **customs brokerage and logistics company in Cebu
City, Philippines**. Confirmed by Chan, not inferred.

Lineage: Abay-abay Customs Brokerage (1993) → ACB Worldwide Cargo Inc. (1998, adding trucking
and forwarding) → LRA Customs Brokerage (2006) → LRA Global Synergy Chain Inc. (2025). Thirty
years of the same trade under four names — which is why the now-deleted HR schema carried a
`customs_broker_accreditation` certification type, and why the rebuilt HR module will need it
again.

Services: tariff classification and consultation; import customs clearance; preparation and
filing of import/export documents; storage, distribution and warehousing; transportation
regulations; domestic and international shipping; customs computation.

Two facts from the business that shape this product:

1. **The public site has a "Free Quotation" CTA.** Quotes therefore already originate as
   inbound web leads, not only as phone calls. That is a CRM handoff waiting to happen, and
   it is why the Wave 2 quote model must be portable (§7).
2. **The work is deadline-shaped and externally blocked.** A broker waiting on the Bureau of
   Customs, or on a client's missing document, is blocked by someone outside the company. The
   blocker graph must therefore support a block with no internal owner — recorded, timed, and
   explicitly *not* counted against the person waiting.

This is what the task catalog must describe. A catalog of generic "complete assigned task"
entries would tell nobody anything; a catalog whose rows are *file an entry*, *chase a BOC
release*, *classify a new commodity*, *turn a quotation around inside SLA* is a training
document as well as a scoring rubric.

---

## 1. The problem

LRA runs on three people — a GM, a Sales person and a Broker — plus the founder. The
founder's complaint is not that they are incapable, it is that the week is invisible.
Nobody can say on Wednesday what anyone committed to on Monday, so work slides, and
"I was waiting on someone" is an unfalsifiable excuse. There is a Monday briefing where
plans and targets are agreed out loud, and then no artefact of that conversation survives
into the week.

Three things follow from that, and they are the whole product:

1. **Everyone knows what they must get done this week.** Written down, not remembered.
2. **Everyone is held to it.** A commitment made on Monday is measured on Sunday, by a
   number that cannot be argued with.
3. **Everyone can see what everyone else is doing.** Visibility is the cheap half of
   accountability. If the Broker can see the Sales person is blocked on the GM, the
   Monday meeting starts from facts instead of from claims.

The system is deliberately not a project management tool. It is a **weekly commitment
instrument**. The unit of the product is the week, not the task.

### Root cause, stated plainly

"The team slacks off" is a symptom description, not a diagnosis. The measurable underlying
problems this system actually addresses are:

- **No recorded commitment.** Verbal targets have no denominator, so there is nothing to
  miss. → Commitments are captured in-app and locked.
- **No cost to silence.** Being blocked is currently free and unrecorded. → Blocks are
  first-class objects with an owner and a clock.
- **No shared definition of value.** Everyone privately ranks their own work highest.
  → A fixed, written points catalog is the company's statement of what it values.

If Chan disagrees that these are the real causes, the design should change before the board
is built, not after.

---

## 2. Users, authority and roles

**Revision 2.** The old six-value `user_role` enum
(`employee < manager < hr < gm < founder < admin`) is gone with the rest of the HR schema.
It conflated **rank** with **function** — HR sat between a manager and the GM, which means
nothing organisationally — and that conflation is what produced the "a manager can forge
`hr_id`" class of defect. Authority is now designed from first principles.

**Two separate ideas, deliberately:**

**Company authority** — `core.authority`, four values, changes almost never:

| Value | Who | What it means |
|---|---|---|
| `staff` | Sales, Broker, and everyone hired later | Does the work, commits, submits |
| `gm` | Sir Mark | Verifies work, oversees, runs the briefing |
| `founder` | Chan's father (and his two eldest brothers, each their own account) | Final approval — the act that credits points |
| `admin` | Chan | System operator, outside every business ladder |

**Module capability** — `core.memberships`, one row per user per module, carrying a
**position** (`founder`, `gm`, `sales`, `broker`, `hr_officer`, `accounting`, `other`).
Position drives which recurring-task templates you receive and how you are grouped on the
scoreboard. It is **not** an authority level.

| Person | Authority | Ops position |
|---|---|---|
| Founder | `founder` | `founder` |
| GM | `gm` | `gm` |
| Sales | `staff` | `sales` |
| Broker | `staff` | `broker` |
| Chan | `admin` | `other` |

**How HR and CRM slot in later, with no migration.** An HR officer is `staff` authority with
an `(hr, hr_officer)` membership: they are not *above* a broker in the company, they have
HR-module powers. Payroll's "HR prepares → GM → Founder" becomes *HR membership grants
prepare; the GM and founder authority tiers approve* — which is both more accurate and
structurally immune to the forgery bug. Adding a module is one enum value plus rows.

**`core.people` and `core.users` are separate on purpose.** A person can exist without a
login (a new hire, someone who has left). That split is agonising to retrofit — it means
backfilling every foreign key in the system — so it is built now even though Ops has no use
for a person without a login today. `core.people` is deliberately thin: name, code, email,
active. **No salary, no government IDs, no manager relation.** Those are HR-module data and
they arrive as additive columns in `hr` when HR is built. See `PLAN.md` §0.3 for where that
line was drawn and why.

**Only one login exists today.** Chan's admin account, plus nothing else. The GM, Sales and
Broker have no Supabase auth identity at all, so provisioning them is a feature of the MVP,
not a setup chore — `PLAN.md` Phase 2. Nothing after Phase 2 can be honestly tested until
three more real people can log in.

### Access rules

- A **member** sees every task, block, commitment and scoreboard in the company. Intentional:
  the stated purpose is that everyone is in the loop. A member writes only their own tasks and
  their own commitments.
- A member **cannot** verify, approve, override points, edit the catalog, or open/close a week.
- The **GM** verifies submitted work and edits the catalog. **The GM cannot verify their own
  task** — that rung is skipped and the founder does both. A two-person control where one
  person can be both people is not a control.
- The **founder** gives final approval, the act that credits points, and can do anything the
  GM can.
- **Admin** (Chan) sits outside every ladder.

## 3. Core concepts

### 3.1 The week

A week runs **Monday 00:00 to Sunday 23:59, Asia/Manila**. All week boundaries are computed
from Manila local time, never from UTC and never from the browser. Currency is PHP.

A week has three states:

- `planning` — created, recurring tasks generated, not yet briefed. Nothing is locked.
- `open` — the Monday briefing has closed. Commitments for this week are **locked**: no task
  may be added to or removed from the committed set. New tasks may still be created and
  worked all week; they simply are not commitments.
- `closed` — Sunday has passed and the week has been rolled over. Scores are final.

### 3.2 Tasks

A task belongs to exactly one person and one week. It is created from the **task catalog**
(a type with a point value) or as a free-form task that must still be assigned a catalog
type before it can be submitted for points.

Task lifecycle (one state machine, enforced by a database trigger):

```
  todo ⇄ in_progress ──> submitted ──> verified ──> cleared      (points credited)
     │        │              │             │
     │        │              └──> rejected └──> rejected
     └────────┴──> cancelled       │
                                   └──> todo   (rework, resubmit later)
```

- `submitted` — the employee says it is done.
- `verified` — the GM confirms it is done.
- `cleared` — the founder approves. **This is the only transition that credits points.**
- `cleared` is terminal and immutable, following the same rule as HR's settled payroll.
- Rejection at either rung requires a written reason.

**"Blocked" is deliberately not a status.** A task is blocked if and only if it has an
unresolved row in `ops.task_blocks`. Storing it in `status` as well would create two
systems controlling one field, and they would fight. The board renders a Blocked column
from the block table; the underlying status is untouched.

### 3.3 Points

**Points measure value and impact, not effort or time.** A hard afternoon spent on something
that did not matter is worth fewer points than an easy phone call that landed a client.
Everyone must understand this or the number is meaningless.

Scale: **Fibonacci, capped — 1, 2, 3, 5, 8, 13, 21.** No other values exist. The gaps are
the point: they force a real judgement between "medium" and "large" rather than allowing
a slide from 6 to 7.

Each catalog entry carries a point value **and a mandatory written guideline note** saying
what that value means at LRA. The catalog is therefore the company's written statement of
what it values, and reading it should tell a new hire what the business cares about. A
catalog entry cannot be created without its note.

- **GM and founder can edit the catalog.** Every edit is recorded in an append-only
  revision table.
- **GM and founder can override a task's points**, with a required written reason. The
  reason is shown on the task and in the ledger forever.
- **Editing the catalog never changes history.** Each task snapshots the catalog's point
  value at creation time. Last month's scores do not move because someone re-priced a task
  type this month. (This is the same rule as HR's payslip rate-config snapshot, and it
  exists for the same reason.)

### 3.4 The recurring cap

Recurring/baseline tasks are worth fewer points than new work, but that alone does not stop
farming — twenty 2-point routine tasks still beats one 13-point deal.

So: **recurring work may contribute at most `recurring_cap_pct` of a person's weekly
score. Default 40%, configurable in `ops.settings`.**

Let, for one person in one week:
- `N` = cleared points from non-recurring (new) work
- `R` = cleared points from recurring work
- `c` = `recurring_cap_pct` (default 0.40)
- `f` = `recurring_floor_points` (default 3)

Counted recurring points:

```
R' = min( R,  max( f,  floor( c / (1 - c) * N ) ) )
weekly_score = N + R'
```

With `c = 0.40`: `c / (1 - c) = 0.6667`, so `R' ≤ 0.6667 × N`, which gives
`R' / (R' + N) ≤ 0.40` exactly. The formula is non-circular — the naive "cap recurring at
40% of the total" is, because the total contains the thing being capped.

The floor `f` exists so that a genuinely quiet week of pure maintenance still earns
something rather than zero. **Judgment call, flagged:** `f = 3` is my pick, not Chan's.
Set it to 0 if he wants the cap to bite absolutely.

**The cap applies to the score, never to the ledger.** The ledger always records the true
cleared points. The scorecard computes the capped figure. Both are shown, with the capped
amount labelled, so nobody discovers a silent haircut.

### 3.5 The points ledger — "money waiting to clear"

Points behave like a bank balance, because that is exactly how they should feel.

| Ledger state | What the employee sees | Who moves it |
|---|---|---|
| `submitted` | **Pending — with the GM** | Employee submits |
| `verified` | **Pending — with the Founder** | GM verifies |
| `cleared` | **Cleared** — counted in the balance and the score | Founder approves |
| `rejected` | **Returned** with a reason | GM or Founder |
| `cancelled` | Withdrawn before anyone reviewed it | Employee, `ASSUMED:` allowed |

Every member's home screen shows three figures, always: **Cleared this week**,
**Pending (₱-style "waiting to clear")**, and **Committed but not yet submitted**. The
pending figure is the one that makes the approval chain feel like a queue rather than a
black hole, and it is also the number that makes a slow GM visible — if ₱-equivalent 30
points sit at `submitted` for four days, that is the GM's staleness, not the employee's.

`ops.point_ledger` is **append-only**. One row per point-bearing transition, recording
from-state, to-state, actor, points, whether the task was recurring, and any override
reason. Nothing in it is ever updated or deleted. Balances are computed, not stored.

### 3.6 Commitments

At the Monday briefing each person selects the tasks they commit to finishing this week.
The commitment records the task and its effective points at commit time.

**When the briefing closes, commitments lock.** After that:
- Tasks **can** still be created and worked mid-week. Chan asked for this explicitly.
- Mid-week tasks earn points normally and appear on the leaderboard.
- Mid-week tasks **do not** enter the commitment hit-rate denominator.

That last rule is what makes hit-rate honest. If mid-week work counted, a person could
dilute a missed commitment by adding easy tasks on Friday; if mid-week work earned nothing,
nobody would ever respond to something urgent.

### 3.7 Carry-over

At week close, every unfinished task (`todo`, `in_progress`, `submitted`, `verified`,
`rejected`) moves to the new week with:

- `carry_over_count` incremented,
- `first_week_id` preserved, so its true age is known,
- **no points lost** — points were never credited, so there is nothing to take away.

**Carry-over does not erase the miss.** The original week's commitment record stays exactly
as it was, so the hit-rate for that week correctly shows a failure. Moving the work forward
is a scheduling convenience, not an amnesty. Per-person carry-over counts and the oldest
carried task are surfaced at the top of the next Monday's briefing.

### 3.8 Blockers

A block is a first-class row: **task X is blocked by task Y, by person P, or by an external
party** - with a written reason, a creator, a created-at and a resolved-at.

The **external** target matters more here than in most businesses. A broker waiting on a
Bureau of Customs release, a shipping line, or a client's missing commercial invoice is
genuinely blocked by someone nobody in this system can chase. Those blocks are recorded and
timed exactly like internal ones, they exonerate the person waiting in the same way, and they
are attributed to a free-text counterparty rather than to a user - which, aggregated over
months, quietly answers: which external party costs us the most days?

- The blocking person is **notified immediately** — "the Sales person is waiting on you."
- Time spent blocked is measured, and attributed to the blocking party.
- Blocked time is **excluded from the blocked task's cycle time**, and a commitment missed
  while genuinely blocked is annotated as such on the scorecard.
- Task→task blocks are checked for **cycles** and refused, so two people cannot deadlock
  the board silently.

This is the feature that converts "I was waiting on the GM" from a meeting excuse into a
line item with a number of hours next to it. It cuts both ways on purpose: it exonerates
the person who was genuinely blocked, and it names the person who blocked them.

---

## 4. Metrics

Definitions are exact because a metric everyone interprets differently is worse than none.

| Metric | Definition |
|---|---|
| **Commitment hit-rate** | For a person in a week: `cleared committed points / committed points`. Points-weighted, not task-count-weighted, so five 1-pointers do not outrank one 13-pointer. "Cleared" means the founder approved it before Sunday 23:59 Manila. |
| **Weekly score** | `N + R'` from §3.4. The headline output number. |
| **Cycle time** | For a cleared task: `cleared_at − first_in_progress_at`, **minus total blocked time**. Reported as a per-person median, not a mean — one 3-week task should not swamp the number. |
| **Staleness** | A task in `todo` (and committed) or `in_progress` with no status change, comment or block activity for **3+ days** is flagged stale. Counted per person per week. |
| **Blocked time** | Σ`(resolved_at − created_at)` over a task's blocks, in hours. Also aggregated **per blocking person** — "the GM blocked 41 hours of other people's work this week" is the number that matters. |
| **Carry-over rate** | `tasks carried out of week / tasks owned during week`. Plus `oldest_carry_over_weeks` per person. |
| **Week over week** | Δ weekly score, Δ hit-rate, Δ carry-over rate, per person and for the team. Shown as an arrow and a number, never as a percentage of a percentage. |
| **Reliability** | §5. |

---

## 5. The reliability score

### 5.1 What it is for

Points say **how much you did**. Reliability says **whether you keep your word**. They must
be separate numbers, because conflating them lets a high-output person hide chronic missed
commitments, and punishes a person whose week was quiet through no fault of theirs.

Chan described wanting something like a credit line — a standing rating that reflects when
things are missing. That metaphor is right and it should be followed all the way, including
the part where **no history means no rating**, not a perfect rating.

### 5.2 The formula

**The spine is commitment hit-rate.** Nothing else is as directly within the person's
control, and nothing else is as directly the thing the founder is complaining about.

Over the last 8 completed weeks, with `i = 0` being the most recent:

```
λ = 0.5 ^ (1/3)          ≈ 0.7937      (a 3-week half-life)

        Σ  λ^i × cleared_committed_points(i)
base =  ────────────────────────────────────
        Σ  λ^i × committed_points(i)

reliability = clamp( 0, 100, round(100 × base) + modifiers )
```

- **Points-weighted**, so committing to something big and delivering it counts for more
  than clearing trivia.
- **Recency-weighted** with a 3-week half-life, so a bad month is recoverable in about a
  month of good behaviour — fast enough to motivate, slow enough that one good week does
  not launder a quarter of misses.
- **Weeks with zero commitment contribute nothing to either sum.** They neither help nor
  hurt, because a zero-denominator week is not evidence of reliability. Committing to
  nothing must never look like perfect reliability — so a person who fails to commit at the
  briefing gets a separate, visible `missed_briefing_commitments` counter and, if they have
  fewer than 3 committed weeks in the window, their score renders as **UNRATED**, exactly
  like a thin credit file.

**Modifiers**, deliberately small and capped so the headline stays interpretable:

| Modifier | Value | Cap |
|---|---|---|
| Chronic carry-over | −2 per task carried 3+ consecutive weeks | −10 |
| Staleness | −1 per stale-flagged task | −5 |
| Blocking others | −1 per 8 hours of other people's work you blocked | −10 |
| Clean sweep | +3 for a week where 100% of commitments cleared | +3 (this week only) |

**Blocked time never counts against you.** If your commitment failed while a declared,
unresolved block was open against it, that commitment is excluded from your denominator for
that week — provided the block was declared **before** the end of the week, not
retroactively at the briefing. This is the mechanism that makes honest early escalation the
winning strategy, which is exactly the behaviour the founder wants.

### 5.3 Bands

| Score | Band | Reading |
|---|---|---|
| 90–100 | **Excellent** | Says it, does it |
| 75–89 | **Solid** | Reliable with occasional slip |
| 60–74 | **Watch** | Discuss at the briefing |
| 0–59 | **At risk** | Structural problem, not a bad week |
| — | **Unrated** | Fewer than 3 committed weeks on file |

### 5.4 Why not something else

- *Task completion percentage* — ignores value, rewards trivia.
- *Points per week* — measures the workload available, not the person.
- *On-time-ness in days* — nothing here has a per-task deadline; the week is the deadline.
- *Manager rating* — subjective, and the whole point is a number the GM cannot argue with.

---

## 6. MVP feature specs

### 6.1 The board (Trello-style)

Columns: **Backlog · This week · In progress · Blocked · Submitted · Verified · Cleared**.

- Drag to move. Every drop goes through the same state-machine endpoint as a button click —
  the UI never has a privileged path.
- Dropping into **Blocked** opens a required dialog: what is blocking this, a task or a
  person, and why. There is no way to be blocked anonymously.
- Filters: by person, by position, by week, by committed/uncommitted, by stale.
- Cards show: owner avatar/initials, effective points chip, catalog type, carry-over age
  badge, stale flag, block count.
- Illegal drops fail with the database's own message, not a silent revert.

### 6.2 The Monday briefing screen

One screen, run live on a shared display during the meeting. Four sections, in order:

1. **Last week's scorecard.** Per person: committed vs cleared, hit-rate, weekly score,
   reliability, week-over-week arrows. Team totals.
2. **Carry-overs.** Every unfinished task, oldest first, with its age in weeks and who owns
   it. The oldest three are highlighted.
3. **Blocks.** Open blocks and hours-blocked by person, from last week. This is where "who
   is holding up whom" gets said out loud with a number attached.
4. **Commit.** Each person, in turn, picks this week's tasks from their board and their
   generated recurring tasks. Running total of committed points shown per person.

Then **Close the briefing** — a single button, GM or founder only. It sets the week to
`open` and locks every commitment. It cannot be undone from the UI; reopening requires the
founder and is audit-logged. `ASSUMED:` the GM runs the meeting and presses the button.

### 6.3 "Who is working on what right now"

A single always-current screen: one column per person, showing

- what they have **in progress** right now, with how long it has been in progress,
- what they **committed** to this week and have not started,
- what they are **blocked on**, and by whom,
- what is sitting in their approval queue if they are the GM or founder.

No interaction, no filters, deliberately. It is a status board, and it should be readable
from across a room.

### 6.4 Approvals queue

GM and founder each get a queue of what is waiting on them, oldest first, with the age of
each item shown in hours. A GM who sits on verifications is visible to everyone, which is
the point.

Approve / reject in one click; reject requires a reason. Points override lives here too,
with its own required reason field.

### 6.5 Person profile / scoreboard

Per person: reliability score and band, sparkline of the last 8 weeks' hit-rate, weekly
score trend, carry-over rate, median cycle time, hours blocked by them, hours they were
blocked. Team leaderboard: this week's capped score, this week's hit-rate, reliability.

**Judgment call, flagged:** a leaderboard between three people is at least as likely to
breed resentment as motivation, and a public reliability score is a strong management
instrument. Chan asked for both, so both are in — but the founder should be able to set
`leaderboard_visibility` to `all` / `oversight_only` in settings. Default `all`.

### 6.6 Notifications

In-app only in the MVP, but the delivery layer is abstracted from day one via an
**outbox in `core`**: every notifiable event writes one `core.notification_outbox` row
(recipient, module, event type, payload, channel, state). The in-app drainer turns those into
`core.notifications`. Adding email or WhatsApp later means writing a second drainer, not
touching a single call site — and because the outbox lives in `core`, HR and CRM inherit it
rather than reinventing it. That is the difference between an abstraction and a promise.

**The inbox cannot be forged.** The old HR schema shipped
`create policy notifications_insert ... with check (true)`, so any authenticated user could
put a message, with a link, into anyone's inbox. In an accountability system a spoofable
"the founder approved your points" is a product defect. In the rebuild there is **no INSERT
policy for authenticated callers at all** — notifications originate only from the outbox
drain — and the only authenticated write is marking your own row read.

Events in the MVP: task submitted (→ GM), verified (→ founder), cleared/rejected (→ owner),
you are blocking someone (→ blocker), block resolved (→ blocked person), task stale 3 days
(→ owner, cc GM), briefing opens Monday 08:00 (→ everyone), week closes Sunday 20:00
(→ anyone with uncleared commitments).

---

## 7. Wave 2 (post-MVP) — specified, not built

Quotes, cash advances and file approvals are **not built in the MVP**. Chan: *"we're purely
focusing on the simple needs of the founder for now, and we will advance and make it better
later."* This section exists so the foundation does not paint them into a corner.

### 7.1 Designed, not created — and why that is the right call

The database rebuild puts a shared `core` foundation under Ops, and the obvious temptation is
to build the generic approval-routing service into it now, while the schema is fresh.

**I did not, and the reasoning matters.** Chan's standing rule is *"extract to a shared
location only once a second real consumer needs it — avoid speculative abstraction."*
Approval routing has **zero consumers today**: Ops task approval is a fixed two-rung ladder on
a task, not a routed document, and it must not become the generic service by accident.
Worse, `APPROVALS-MODULE.md` says the routing key is
`(document_type, entity/brokerage, amount)` — and **we do not yet know what a quote's fields
are** (`OPEN-QUESTIONS.md` #1). Building a routing table before knowing what it routes is how
you get a shape you have to migrate away from.

So: the schema below is **written down and agreed**, and it is **created in the same
migration as its first consumer**. That is the difference between a designed seam and a
speculative table. `PLAN.md` §0.3 lists everything else that was and was not built on the same
test, so the line is auditable rather than a matter of taste.

### 7.2 Portability is the hard requirement

Chan: *"the quotes will be reused later for the CRM. Cash advances will be reused later in the
HR."* So these entities must move between modules **without a migration**:

- They live in **`core`**, not in `ops`. A quote that belongs to the CRM tomorrow cannot sit
  inside a schema named after this week's module.
- **Recommendation: one `core.approval_documents` table typed by `document_type`, with a
  `details jsonb` payload**, rather than separate `quotes` and `cash_advances` tables. Two
  reasons: routing is defined per `document_type` and wants one place to attach to; and the
  CRM adopting quotes then means the CRM reading rows it already has, not a data move.
- Nothing references anything Ops-specific. Submitter is a `core.users.id`. Approver is
  resolved from routing, never from a membership.
- Ops *consumes* the service — it renders a queue and a status. It does not own the ladder.

Binding on the shape, from `LRA-HR/docs/APPROVALS-MODULE.md`:

- Routing lives in a **`core.approval_flows`** table keyed on
  `(document_type, entity/brokerage, amount_band)`. **Never a hardcoded person, and never a
  rule expressed in application code where a sibling module cannot see it.**
- HR's fixed four-rung chain is named there as **the shape not to copy**, because it cannot
  express "who approves depends on the document." Petty cash → the father. A quote → depends
  on which brokerage (DCA / ERC / LRA).
- Enforce the ladder in the **database** (PostgREST is reachable without the API); guard
  **every** write path, not just UPDATE; an UPDATE policy needs an explicit `WITH CHECK` and
  **cannot** express a state machine — use a trigger.

### 7.3 Full immutable history — already solved

Chan: *"we need to have a real history of those."* Every state change, actor, timestamp and
field diff must be queryable as a timeline.

**This is why `core.audit_logs` is built in Phase 1 rather than deferred.** It is generic
(`entity_type` / `entity_id`), carries `old_values` / `new_values` as jsonb, stamps the actor
and their authority, is indexed for exactly the per-document timeline query, and is
**append-only even to the service role**. A history a service key can rewrite is not a
history.

Wave 2 entities write there under **unprefixed** `entity_type` values — `quote`,
`cash_advance`, `document` — not `ops.quote`. The prefix would encode an ownership that is
temporary by design.

The one thing HR got wrong here is fixed in the rebuild: **the read side.** A submitter can
read their own document's timeline via `core.can_read_audit(entity_type, entity_id)`. A
system where you cannot see the history of your own request is a system people stop trusting.

**The Ops-internal split, for contrast:** task and points history lives in `ops.point_ledger`,
also append-only. That is a *domain ledger* on the hot path of every score computation, not an
audit log, and it should not be a filtered scan of a shared generic table.

### 7.4 Quotes

Inbound "Free Quotation" leads from the public site, plus phone and email enquiries. Fields
will include brokerage entity (DCA / ERC / LRA), client, commodity, amount, validity and an
attachment. Approver resolved from `core.approval_flows` on
`(quote, brokerage, amount_band)`.

**Unknown and blocking Wave 2:** who creates a quote, which fields are mandatory, whether
there is a revision cycle before approval, and whether an approved quote becomes a job.
See `OPEN-QUESTIONS.md` #1.

**CRM handoff note:** because leads already arrive from the website, the quote record should
carry a `source` (`web` / `phone` / `email` / `walk_in`) from its very first version. It costs
one column now and is the difference between the CRM inheriting a pipeline and the CRM
inheriting a list.

### 7.5 Cash advances

Submit an amount and purpose; route by amount band; and — almost certainly — a **liquidation
step with receipts**. An advance without liquidation is a loan nobody closed.

**The overlap to reconcile, flagged not solved.** The old HR schema had
`loan_type = 'company_cash_advance'` on a `loans` table with its own approval chain, a running
balance and payroll deduction wiring. That schema is deleted, so nothing is broken today — but
the *concept* returns the moment HR is rebuilt, and there will again be two plausible objects
for the same money:

- an approvals-side `cash_advance` document — request → approve → release → liquidate, and
- an HR `hr.loans` row — balance → deducted from payroll until repaid.

Both are probably right: the first is the *request and its history*, the second is the
*recovery*. If so, an approved cash advance should **create** the loan row rather than
duplicate it. **Do not decide this in the MVP**, and do not let the HR rebuild decide it
unilaterally either — it needs Chan and the accountant. Building the request side in ignorance
of the recovery side is how two systems end up owning the same peso.

### 7.6 File / document approvals

Generic `document_type` through the same routing table. Needs Supabase Storage buckets; none
exist yet. Reserve `approval-documents` and `ops-attachments`, and leave `employee-documents`
and `payslips` unclaimed for the HR rebuild.

## 8. Non-goals

Stated so they do not creep in.

- **Not a time tracker.** No timesheets, no hours logged against tasks. Points are value,
  not effort. HR owns attendance.
- **Not a CRM.** Clients, deals and pipeline are out. Sales tasks reference a client as free
  text in the MVP.
- **Not a chat tool.** Task comments only, if at all. Discussion happens on Monday.
- **Not mobile-native.** Responsive web. `ASSUMED:` desktop-first, since the briefing runs
  on a shared screen.
- **No email or WhatsApp delivery in the MVP.** The outbox exists; the drainers do not.
- **No public or client-facing surface.** Internal, authenticated, four users.
- **Does not rebuild HR or CRM.** The foundation is shaped for them and the seams are named,
  but no `hr` or `crm` table, column or route is created. Empty schemas are clutter that look
  like progress. See `PLAN.md` §0.3 for exactly where that line falls.
- **Does not migrate `packages/payroll`.** It stays in LRA-HR, untouched and passing, until
  HR is actually rebuilt. It has no consumer today.
- **No offline mode, no realtime websockets in the MVP.** The "now" screen polls every 20s.

---

## 9. Definition of done for the MVP

The system is done when, without anyone touching SQL:

0. Chan invites the GM, Sales and Broker from an admin screen; all three accept, set a
   password and log in. Today none of them has an account at all, so this is step zero in
   the literal sense.
1. A week is created, recurring tasks appear for each position, and the briefing screen
   shows last week's scorecard and carry-overs.
2. Each of the four people logs in, commits to tasks at the briefing, and the GM closes the
   briefing — after which no commitment can be added or removed for that week.
3. A member works a task on the board, submits it, sees the points appear as **pending**,
   the GM verifies, the founder approves, and the points move to **cleared** — with each
   step notified in-app.
4. A member declares a block on the GM; the GM is notified; the hours accumulate; the
   scorecard at the next briefing shows the blocked hours attributed to the GM.
5. Sunday passes, the week rolls over, unfinished tasks carry with an incremented age, and
   the missed commitments still show as missed for the old week.
6. Each person's profile shows a reliability score computed by the §5.2 formula, and the
   leaderboard shows week-over-week movement.
7. `npm run build && npm test` are green, and the **27-attack RLS suite runs in CI on every
   pull request** and passes with its canary correctly failing. Not by hand, not once — every
   PR. The old system's entire security history was "found by hand, in production, five rounds
   late"; this is the change that stops that repeating.
