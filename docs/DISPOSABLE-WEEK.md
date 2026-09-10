# The disposable week

> The instrument for the one ritual this system exists for, and had never
> been driven: PLAN.md §12.9.
>
> `node scripts/disposable-week.mjs run`

## Why

The Monday briefing's `open`/`close`, the week close, and every Verify/Clear
were never driven end to end against the real database, because they are
irreversible. `ops.close_briefing` locks a week's commitments and audit-logs
it; `ops.close_week` rolls over; a `cleared` task is frozen forever.

PLAN.md §12.7 is why "we clicked it and it worked" is not evidence here.
Three of this project's worst defects had a **correct response and a broken
side effect**: seven endpoints returning 200 with dead buttons, a `204` on a
delete the UI reported as a failure, and a settings audit row that silently
never wrote. A click observes the response, exactly like the endpoint test
does. Opening a week generates recurring tasks and stamps a briefing;
closing it locks commitments and writes audit; clearing a task writes a
ledger row, stamps three columns, enqueues a notification, and moves two
balance figures. **Any of those can half-happen behind a 200.**

So every assertion in the harness reads a **row**, not a status code.

## How it is isolated, and why that is enough

The week lives at `week_start >= 2099-01-01` (`DISPOSABLE_EPOCH`). That was
chosen over a schema change after checking how each downstream consumer
actually selects weeks:

| Consumer | How it windows | 2099 week |
|---|---|---|
| `scoreboard` `week` | `week_start === current` | excluded |
| `scoreboard` `month` / `quarter` | 4 / 13 most recent with `week_start <= current` | excluded |
| reliability window | `state = 'closed' and week_start < current`, most recent 8 | excluded |
| `lastClosedWeek`, hit rate, carry-over rate | read off the reliability window | excluded |
| briefing carry-overs, scorecard | `.eq('week_id', …)` / `week_start - 7` | excluded |
| **`scoreboard` `all`** | **every week that exists** — deliberately not re-anchored (`scoreboard.ts`) | **INCLUDED** |
| **`cycleTime`** | **every task ever cleared** — deliberately unwindowed (PRD §4) | **INCLUDED** |
| **`/api/points/me`, `/api/points/ledger`** | no `weekId` ⇒ all weeks | **INCLUDED** |
| **`/api/points/queue`** | by status, not by week | **INCLUDED** |
| **`/api/points/digest`** | no `weekId` ⇒ all tasks | **INCLUDED** |
| **`/api/now`** | the caller's live work | **INCLUDED** |
| **reliability modifiers** (staleness, chronic carry-over) | **all currently-open tasks, no week filter** | **INCLUDED** |
| **blocked hours** | `task_blocks.created_at >= windowStart` — wall clock, not week | **INCLUDED** |

So the far-future date alone is **not** sufficient. Isolation is
`far-future week` **+** `full teardown`, and the harness proves both halves
empirically rather than asserting them from having read the query builders:

1. **While the week is live**, the week-anchored half of the scoreboard must
   be identical to the baseline, and a set of *causal* assertions must hold
   regardless of what any other session is doing: no roster row's "this
   week" points at a disposable week, no `lastClosedWeek` is a 2099 week, no
   reliability window contains one, and the `month`/`quarter` week counts
   equal the number of **real** weeks at or before the current one.
2. **After teardown**, every downstream payload must be identical to the
   baseline taken before the run, and `ops.point_ledger` / `ops.tasks` /
   `ops.weeks` must be back at their exact baseline row counts.

### Two rules that fall out of the table above

- **Never raise a `task_block` inside a disposable week.** Blocked hours are
  windowed by the block's `created_at`, not by its week, so a block raised in
  2099 counts against a real person's reliability score today. The harness
  raises none, and asserts that it raised none.
- **`--keep` is safe for hours, not days.** The reliability modifiers read
  off *all* currently-open tasks with no week filter, so once a disposable
  task's `last_activity_at` passes `ops.settings.stale_after_days`
  (default 3) it begins counting as staleness against real people.

### The one irreversible residue

`core.audit_logs` refuses `DELETE` to every role including the service role,
by design — "the audit trail outlives even the data it describes". So the
single `ops.briefing.closed` row that `ops.close_briefing` writes **survives
teardown**, pointing at a week id that no longer exists. That is intended
behaviour, not a leak, but it means `/admin/audit` accumulates one
`ops.briefing.closed` row for a 2099 week per run. The harness asserts the
growth is *at most one row per run* — more than that would mean the
idempotency guard failed.

`prove-red` never closes a briefing, so the negative control leaves no
residue at all.

## Cheap enough to run twice

`run` tears down any leftover disposable week **before** it starts and again
in a `finally` when it finishes, so a crashed run does not make the next one
more expensive. Nothing outside `week_start >= 2099-01-01` is ever written or
deleted. Verified by running it back to back and comparing `ops.weeks`,
`ops.tasks`, `ops.point_ledger` and `core.notification_outbox` row counts
against the pre-run values: identical every time, with `core.audit_logs`
+1 per run as described above.

Teardown order matters. `ops.tasks.week_id` has no `on delete cascade`, and
both `ops.point_ledger` and `ops.task_notes` refuse `DELETE` unless the
caller is `core.is_system_caller()` — which the service role is
(20260909100100, 20260910100000).

## Proving the harness can go red

A green suite that cannot fail is worse than none.

```
node scripts/disposable-week.mjs prove-red
```

creates the week and the tasks and then **skips every transition** — no
generation, no briefing open/close, no submit/verify/clear, no week close —
while running the *identical* assertion battery with the *identical*
expectations. Expectations never soften in the control; only the actions are
skipped. It exits 0 only if each of the five side-effect groups reported at
least one failure. Measured: **42 assertions go red across all five
groups**, versus 0 in a normal run.

## Commands

```
node scripts/disposable-week.mjs run           seed, drive, assert, tear down
node scripts/disposable-week.mjs run --keep    ... but leave the week (see the warning above)
node scripts/disposable-week.mjs run --verbose  print detail on passing checks too
node scripts/disposable-week.mjs teardown      remove every disposable week
node scripts/disposable-week.mjs inspect       print weeks, templates, roster, row counts
node scripts/disposable-week.mjs prove-red     the negative control
```

Credentials come from `apps/api/.env` (Supabase URL + service role, for
reading rows back and for teardown) and `apps/web/.env`'s `VITE_DEMO_LOGINS`
(the demo passwords, so the harness can sign in as each persona). The HTTP
calls go to the real API on `:3099` with each persona's own Supabase JWT —
the same server and the same tokens the browser uses.

## What it drove, and what it did not

**Driven end to end** against the live database, with row-by-row assertions
on every side effect: week creation and its idempotency; recurring
generation, its exact expected set, and the idempotency of a retried
generation including a direct proof that `uq_ops_tasks_recurring` refuses a
duplicate `(owner, week, template)` with `23505`; commit/uncommit;
`open_briefing`; `close_briefing` including its single audit row and the
commitment lock actually engaging afterwards; `todo → in_progress →
submitted → verified → cleared` with every ledger row, stamp, notification
and `v_point_balances` figure checked; the cleared-task freeze; `close_week`
with rollover, carry-over counts, `first_week_id` preservation and full
idempotency; and the closed-week insert refusal.

**Not driven through a browser.** The briefing screen reads
`GET /api/weeks/current` and has no week selector, so a disposable week is
unreachable from it. That is also the reason this ritual was never
browser-verified in the first place. Verify and Clear *are* reachable in a
browser (the `/queue` screen is filtered by status, not by week), so a
disposable task does show up there while the run is live.

## Concurrency

Other sessions work this repo against the same live Supabase project. A
before/after byte-comparison of a whole payload can therefore move for
reasons that have nothing to do with the disposable week. The harness
fingerprints everything outside the disposable range before and after; if
that fingerprint moved and a payload differs, the check is reported
`INCONCLUSIVE` — named as such, with the fingerprint delta — rather than
passed or failed. The causal assertions never need that escape hatch.

Fields derived from `now()` against an unresolved row (`hoursBlockedByThem`,
`hoursOpen`, `ageHours`, …) tick upward on their own; they are stripped
before comparison and paid back by the causal "no block exists on a
disposable task" assertion. This was reproduced, not guessed: a six-minute
run reported `hoursBlockedByThem: 25.7 -> 25.8` for a block that predates the
harness.
