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

## `simulate`: several consecutive weeks, so cross-week behaviour has something to run on

`run` proves one Monday works. It cannot show what only emerges **across**
weeks: a carry-over's age growing, a reliability score computed over a real
multi-week window, a blocked commitment being exonerated and that exoneration
surviving into the following week, or points accumulating while a still-open
week stays outside a closed-only aggregate. None of that exists inside a
single week, so `run` structurally cannot test it.

```
node scripts/disposable-week.mjs simulate <n>       n >= 4
node scripts/disposable-week.mjs simulate-red <n>    the negative control for the above
```

**This is not a container.** There is no `supabase start` here (Docker is
not available in this environment) and no snapshot/restore. `simulate` is
the same mechanism `run` already uses, repeated: real Mondays, at
`week_start >= 2099-01-01`, driven through the real API on `:3099` with each
persona's real JWT, torn down by deleting exactly the rows this harness
created. "Several weeks passing" is entirely **date arithmetic** — `n`
consecutive Mondays 7 days apart, starting at `DISPOSABLE_WEEK_START` — not
elapsed wall-clock time and not a rewound clock. That is sound for
everything this harness asserts, because every mechanism it drives
(`ops.close_week`'s rollover, the reliability window's `state = 'closed'`
filter, `carry_over_count`, `committed_week_id`, `cleared_at`) keys off
`ops.weeks.week_start`/`week_end` and row timestamps, never off how much
real time actually passed between one week and the next. It is NOT sound for
anything that keys off wall-clock elapsed time instead of week arithmetic —
concretely, `ops.settings.stale_after_days` staleness and any
`task_blocks.created_at`-windowed figure — which is exactly why `simulate`
raises exactly one block (an `external`-target block, so it cannot pollute a
real person's "blocking others" modifier) and otherwise leaves every task's
`last_activity_at` untouched by anything but the state transitions the
scenario actually calls for.

**The fixed scenario** (not randomised, so the log and the hand-computed
expectations below are exact): `sales` never misses — a fresh task,
committed and cleared, every single week including the last, still-open
one. `broker` is blocked in week 0 (an external block declared before week 0
ends), has that block **resolved in week 1** — proving a block crosses the
week boundary — but the task is deliberately never cleared afterward,
because `ops.tasks.status === 'cleared'` is checked *before* the block
lookback in the exoneration query, so clearing it later would silently turn
week 0 from an exonerated miss into an ordinary hit and there would be
nothing left to assert. `broker` also picks up a fresh, ordinary task every
other closed week, so their reliability is a real RATED score, not
UNRATED. `gm` commits exactly once, in week 0, to a task that is never
touched again — the control case: no block, so no exoneration, a plain miss
that keeps carrying every week after. Both `broker`'s week-0 task and `gm`'s
task are therefore carry-overs from week 1 onward, their age growing by
exactly 1 every week — "something carries over twice" happens on its own
once `n >= 4`. The last week is opened and its briefing closed (so
commitments lock) but `ops.close_week` is never called on it, so there is
always exactly one still-open week to prove a closed-only aggregate excludes.

**What it asserts, and how "hand-computed" is enforced**, not just claimed:
reliability/hit-rate is checked two independent ways — weight-invariant
identities (`0/x = 0`, `x/x = 1`, true regardless of the recency-weighting
scheme, so they catch a broken exclusion or a flipped numerator/denominator)
**and** an independent re-transcription of PRD.md §5.2's own formula that
does not import anything from `packages/ops-scoring/src/reliability.ts`, so
a weighting bug (wrong half-life, wrong window order) is caught too. Because
`/api/scoreboard`'s real reliability window is anchored on the **current
real week** and a 2099 week can never be `< currentWeek.week_start`, none of
this can be observed through that endpoint at all — by design, that is the
isolation the whole harness rests on. So `simulate` re-derives
`weeksByUser` from the driven rows itself (a second, independent
transcription of `scoreboard.ts`'s own construction, scoped to just the
disposable weeks) and feeds that into the actual, imported
`reliability()` from `@lra/ops-scoring` — the real production function, not
a copy of it — so a bug in the real formula is a bug this harness catches,
even though the real endpoint structurally cannot see the data.

**A residue `run` cannot reach.** `chronicCarryOverByUser` in
`scoreboard.ts` reads every currently-open task with **no week filter at
all**. Once a disposable task's `carry_over_count` reaches 3 — guaranteed by
`n >= 4` leaving the last week open — it is structurally indistinguishable
from a real chronic carry-over belonging to whichever demo persona owns it,
**live, before teardown, inside a single run**. This is the same class of
residue `--keep` already warns about, just reachable now without `--keep`
because `simulate` is the first caller that pushes a disposable
`carry_over_count` past 3 before its own teardown runs. `simulate` asserts
this causally against each affected persona's own live
`GET /api/scoreboard` row, before vs. during vs. after, rather than assuming
it away — see the run's own output for the actual result.

## Proving `simulate` can go red

```
node scripts/disposable-week.mjs simulate-red <n>
```

creates the `n` weeks and the ad-hoc tasks (creation is not a transition,
exactly like `prove-red` above) and then skips every transition — no
commits, no briefing open/close, no blocks, no status changes, no
`close_week`.

### What made the control lie, and the fix

The first version of this control was worthless: `simulate-red 4` reported
52 pass / 0 fail with **0 of the assertions in any cross-week group actually
going red**, for two separable reasons.

1. **Skipping the transition was silently skipping the assertion too.**
   Every cross-week check was written as `if (act) { ...assert... }` — so in
   RED mode, where `act` is `false`, the assertion body never ran at all.
   Nothing failed because nothing was even asked. The carry-over group alone
   lost 9 of its 12 assertions this way (12 ran green, only 3 ever ran red).
2. **The checks that DID run in both modes computed their own expectation
   by reading back the same rows they then compared against** — e.g. the
   reliability block built `expectedByDay`/`expectedRatedWeeks` from the
   harness's own `clears`/`act` bookkeeping, which is *also* empty in RED
   for the same reason the actual rows are empty. Two empty things agreeing
   with each other proves nothing; it's the "assert the query against
   itself" failure mode this codebase has been bitten by before (PLAN.md
   §12.7, `docs/AGENT-LESSONS.md`).

The fix applied throughout `simulate`'s five cross-week groups (carry-over,
reliability, blocked-time exoneration, scoreboard accumulation, per-day
activity):

- **Every assertion now runs unconditionally, in both modes.** The `if
  (act)` guards around assertion bodies are gone; only the guards around the
  actual API calls that *drive* the transitions remain (that part is
  correct and unchanged — RED mode is defined by skipping transitions, not
  by skipping checks).
- **Expectations are fixed at what the scenario intends to drive** —
  `n - 1` closed weeks, `P` committed points, carry-over age `i`, a reliable
  base of `1` for sales/broker and `0` for gm, `2n - 2` cleared tasks — never
  re-derived from the same rows/bookkeeping being asserted against. In GREEN
  this is the same number it always was. In RED, nothing was driven, so the
  real row (or its absence) disagrees with the fixed expectation and the
  assertion fails for a genuine reason.
- **Where an assertion structurally cannot evaluate without a driven
  transition** — resolving a block that was never created, or comparing a
  per-day cleared-task distribution when nothing was ever cleared (there is
  no way to predict *which* calendar day a hypothetical clear would have
  landed on) — it now records an explicit `record(group, name, false, ...)`
  failure naming exactly why, instead of being skipped or silently agreeing
  with itself.
- A latent robustness bug in the assertion engine surfaced once real rows
  started coming back `undefined` in RED (a week that never closed can't be
  found by a query scoped to closed weeks): `eq()` called `JSON.stringify()`
  and then `.length` on the result without handling `JSON.stringify(undefined)`
  returning the *value* `undefined`, not the string `"undefined"`, which
  crashed the harness the first time an assertion legitimately needed to
  compare against a missing row. `eq()` now stringifies through a
  `safeStringify()` helper that treats `undefined` explicitly, so the
  comparison runs — and fails — instead of throwing.

With nothing ever committed, every person's `ratedWeeks` is 0 against a
fixed nonzero expectation; with nothing ever closed, `carryMap` is empty
against a fixed nonzero carry-over age; with nothing ever cleared, both the
closed/open points split and the per-day heatmap total are 0 against a fixed
nonzero expectation. It exits 0 only if each of the five cross-week groups
(carry-over, reliability, blocked-time exoneration, scoreboard accumulation,
per-day activity) actually reported at least one failure.

**Measured**, run against an isolated local stack (`supabase start` +
`db reset`, `OPS_API_URL`/`SUPABASE_*` pointed at `:54321`/`:3199` — see
"How to run it" below): `simulate-red 4` now reports **33 of 53 cross-week
assertions going red**, with every one of the five required groups showing
at least one failure —

```
=== RED CONTROL ===
  Every transition was skipped, so every side-effect assertion MUST fail.
  ok   cross-week: carry-over age        12 of 12 assertions went red
  ok   cross-week: reliability / hit-rate 7 of 12 assertions went red
  ok   cross-week: blocked-time exoneration 6 of 6 assertions went red
  ok   cross-week: scoreboard accumulation  6 of 6 assertions went red
  ok   cross-week: per-day activity (heatmap data) 2 of 2 assertions went red

  All side-effect groups can go red. The green run above is therefore meaningful.
```

The reliability group's remaining 5 green checks in RED are not a gap: 3 are
the base-vs-hand-computed *cross-check* (both sides read the same driven
rows, so both are legitimately `0` when nothing is driven — it is a
GREEN-mode formula check, not a red-control check, and the group's other
assertions, `ratedWeeks` and `base is exactly N`, catch the same
discrepancy for real), and 2 are `gm`'s `base`/`RATED-UNRATED` checks, which
coincidentally land on the same value (`0`, `UNRATED`) whether gm's single
miss was genuinely un-exonerated or nothing was driven at all — `gm`'s
`ratedWeeks` assertion (expected `1`, actual `0`) still catches the
discrepancy in the same group.

Re-running `simulate 4` (GREEN) afterward confirms the fix did not change
the product's behavior, only the control's honesty: still **52 pass, 0
fail** — the same result as before, but now backed by assertions that were
just proven capable of catching a real regression.

## Commands

```
node scripts/disposable-week.mjs run              seed, drive, assert, tear down
node scripts/disposable-week.mjs run --keep       ... but leave the week (see the warning above)
node scripts/disposable-week.mjs run --verbose     print detail on passing checks too
node scripts/disposable-week.mjs teardown         remove every disposable week
node scripts/disposable-week.mjs inspect          print weeks, templates, roster, row counts
node scripts/disposable-week.mjs prove-red        the negative control for `run`
node scripts/disposable-week.mjs simulate <n>      n >= 4 consecutive disposable weeks
node scripts/disposable-week.mjs simulate-red <n>  the negative control for `simulate`
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
