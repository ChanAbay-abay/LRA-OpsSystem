# Full regression pass — 2026-09-10

Tester run against a live `npm run dev:api` (port 3099) + `npm run dev:web` (port 5173)
instance, driven with Playwright as all six demo personas. Ports 3099/5173 were killed and
restarted clean before testing per instructions.

## Verdict
**FIX FIRST** — the core loop (board, lock, edit-request approve/reject, reliability
gating) works and is genuinely solid, but read-only observers cannot open any task on the
Board at all (a real regression on ask #1), and a closed week silently accepts a brand-new
task with no warning. Neither is a security hole and neither corrupts money, but both are
things a real user hits on a normal path tonight.

## Important environmental note — read this before trusting any single finding

For roughly the first 5 minutes of this session, another process was actively editing
`apps/api/src/{middleware/auth.ts, routes/me.ts, routes/admin.ts, routes/tasks.ts,
routes/task-edit-requests.ts, routes/briefing.ts, routes/scoreboard.ts}` and
`packages/ops-scoring`, causing `tsx watch` to restart the API every 5–10 seconds
(`12:23:21 PM` through `12:27:01 PM` in `/tmp/lra-api.log`). This produced two
`net::ERR_CONNECTION_REFUSED` console errors on `/api/me` and `/api/now` during that window.
That is **not a product defect** — it's a live concurrent edit on exactly the auth/edit-
request/scoreboard surfaces this pass was asked to cover. I waited for the log to go quiet
for 40s (confirmed via `git status` showing the same 7 modified files, unchanged) before
treating the API as stable, and re-ran every check below against the settled build. If
these files are touched again before Chan reviews, the read-only and edit-request findings
below should be re-verified once more, since they are the exact area that was moving.

## What I ran

```
lsof -ti:3099,5173 | xargs -r kill -9
npm run dev:api   # -> http://127.0.0.1:3099
npm run dev:web   # -> http://localhost:5173 (vite)
# then drove the app live via Playwright MCP as founder-demo, gm-demo, sales-demo,
# broker-demo, erc-demo, dca-demo (passwords read from apps/web/.env, never printed)
```

No automated test suite or `npm run validate` was run in this pass — scope was live UI
driving per the brief. `docs/AGENT-LESSONS.md` §2/§4 RLS-suite guidance was read but the
adversarial/RLS sweep is explicitly out of scope for this regression pass per the prompt.

## Defects

### [Major] Read-only observers (ERC/DCA) cannot open any task on the Board — a whole read surface is unavailable, not just writes
- **Where:** `/board`, every card, as `erc-demo` (and by the same code path, `dca-demo`)
- **Repro:**
  1. Log in as `erc-demo`.
  2. Go to `/board`. Every card shows `title="Your account is read-only."` and
     `aria-disabled="true"` on the **entire card**, not just its write affordances.
  3. Click any card — nothing happens. Playwright's own click times out waiting for the
     element to become "enabled" (verified live, not a snapshot artifact):
     ```
     TimeoutError: ... element is not enabled ... aria-disabled="true"
     aria-label="[DEMO] Resolve BOC alert on shipment #HIST-102, ... Enter to open."
     ```
- **Expected:** Per this run's brief and the read-only-visitor ask (§10 #1, "done"), ERC/DCA
  "should never be offered a write control, and should still be able to read everything."
  The card itself is a read action (`Enter to open` is literally in its own aria-label) —
  only the drag handle, the flag-for-cancellation icon, the worklog "add note" input and the
  `More actions` menu items should be disabled, not the ability to open the task and read its
  description, worklog and blocks.
- **Actual:** The whole card `<div role="button" aria-disabled="true">` is disabled, so a
  read-only user can see title/owner/points on the board face but can never read a task's
  description, full worklog, block history or change-request history — exactly the things
  the task modal exists to show.
- **Why it matters:** This is the single most-used screen in the app. An observer account
  that is supposed to "see everything" cannot see anything past the card face. It also means
  I could not verify (for ERC/DCA specifically) whether the task modal itself correctly hides
  write controls while showing read content, because the modal never opens for them at all.
- **Confidence:** verified live (real click, real timeout, real `aria-disabled` in the DOM —
  not a code-reading guess).
- **Positive control, so this isn't a broken instrument:** the same ERC session reads
  `/scoreboard`, `/catalog` and `/people/:id` completely normally — every row is a live link,
  nothing is disabled there. So this is specific to the Board card component's read-only
  gating, not a global read-only lockout.

### [Medium] A brand-new task can be created against an already-closed week with no warning
- **Where:** `/board` → "New task" dialog → Week dropdown, as `founder-demo`
- **Repro:**
  1. Open "New task". The Week `<select>` lists `2026-09-07–09-13 (open)` alongside three
     **closed** weeks: `2026-08-31–09-06 (closed)`, `2026-08-24–08-30 (closed)`,
     `2026-08-17–08-23 (closed)`.
  2. Pick the closed `2026-08-17–08-23` week, give it a title, leave catalog type unset,
     click "Create task".
  3. `200`, no toast/error. The new task appears immediately in the **current** board's
     Backlog column (count went 5→6, 13→17... visually confirmed via screenshot
     `new-task-closed-week-result.png`).
- **Expected:** `docs/AGENT-LESSONS.md` §9 already documents the underlying rule this
  contradicts: "an already-closed history week is the finished artifact" and can't take a
  commitment. Creating a brand-new uncommitted task record *against* a closed week — and
  having it silently render on today's Backlog regardless of the week it's tagged with —
  looks like exactly the kind of debris-generating gap that cost two aborted seed runs
  earlier tonight, just from the UI side this time instead of the seed script.
- **Actual:** Silent success, no validation, no filter distinguishing "this backlog item
  belongs to a closed week from a month ago" from a live one.
- **Why it matters:** A founder fat-fingering the week dropdown (it's not sorted with the
  open week visually distinguished beyond the `(open)`/`(closed)` suffix, and it's alphabetized
  newest-first with `open` on top so it's an easy adjacent-row mistake) silently creates a
  task that is invisible in its own week's history and appears to belong to the current week
  in the Backlog view, with no error to catch the mistake.
- **Actual cleanup:** I created and then fully removed this test task (flagged for
  cancellation, approved as founder) — board Backlog count is back to 5/13, verified after.
- **Confidence:** verified live.

### [Minor] Founder/admin have no UI path to directly edit a committed task's definition, despite the backend explicitly granting them that right
- **Where:** `apps/web/src/lib/task-permissions.ts:225-240` (`definitionLockRefusal`),
  cross-checked live in the task modal as `founder-demo`
- **Repro / evidence:** `definitionLockRefusal` returns `null` (i.e., no lock) for any actor
  with `authority === 'founder' || 'admin'` who isn't read-only — so per PLAN §10.1
  ("Only admin and founder [may edit after the Monday lock]"), the founder should be able to
  rewrite a committed task's title/description/type/owner/client-ref directly. But opening
  that same task as `founder-demo` shows no "Definition locked" chip, no "Request a change"
  banner, **and no edit control of any kind** — no pencil icon, no inline-editable title, no
  edit dialog. Grepping the whole web app (`grep -rn "api/tasks/" apps/web/src`) turns up
  every other task mutation endpoint (`status`, `notes`, `blocks`, `commit`) but never a
  `PATCH /api/tasks/:id` call, even though the API defines that route
  (`apps/api/src/routes/tasks.ts:365`).
- **Expected:** Some UI — even a lightweight inline-edit — letting the founder exercise the
  bypass right the migration was explicitly built to grant them.
- **Actual:** The only way anyone, including the founder, can ever change a committed task's
  definition through the UI is the GM's "Request a change" flow — which the founder can't
  even open on their own tasks, because the lock banner (which is what surfaces that button)
  never renders for them.
- **Why it matters:** Low frequency (founder rarely needs to fix their own committed task's
  title mid-week) but it's a real capability gap between what the backend allows and what a
  person can actually do, and it's silent — there's no error, the option simply isn't there.
- **Confidence:** reasoned from code + confirmed live that no such control renders anywhere
  in the modal for the founder persona. Not reproduced as a failed API call (I didn't hand-
  craft a PATCH request), so labeling this Minor rather than Major.

### [Minor / data-hygiene] Real demo task carries 72 fake "Verification note" worklog entries from a prior coder session
- **Where:** Task `[DEMO] Quotation for a lead that went cold` (Backlog), worklog history
- **Repro:** Open the task as any persona who can see it. The worklog shows 72 entries, all
  reading "Verification note #N — checking the worklog scroll region behaves independently
  of the rest of the modal..." authored by "Founder (demo)" between 12:57 AM and 1:10 AM
  today, in 7 repeated batches of ~10.
- **Expected:** Real demo data should not carry a prior agent's scroll-behavior test fixture.
- **Actual:** It's still there, and it's exactly the kind of content Chan will notice in a
  live demo if he opens that card.
- **Why it matters:** This is polish/hygiene, not function — the worklog scroll region itself
  works correctly (see "Held up," below) — but per this project's own lesson #9 I did **not**
  delete it myself, since I can't tell whether removing it would break something else's
  fixture assumption, and deletion is explicitly outside a tester's tools/mandate anyway.
  Flagging for the coder to clean up.
- **Confidence:** verified live.

### [Nit] Rejection banner from a prior cycle persists on a task that has since moved to `in_progress`
- **Where:** Task "Quotation for Meridian Freight" (In progress, owned by Sales), task modal
- **Repro:** Open the task. Status chip reads "In progress," but a red "Returned" banner
  ("Meridian quote is missing the BOC reference number.") is still shown above the
  description, as if the task were currently in a returned state.
- **Expected:** unclear from PRD/DESIGN whether the last-rejection reason is meant to persist
  as permanent context once work has resumed, or should be superseded/cleared once the task
  re-enters `in_progress`. Flagging as a judgment call rather than a clear-cut bug.
- **Actual:** Visually reads as "this is currently returned" at a glance, which is misleading
  next to a chip that says "In progress."
- **Confidence:** verified live; severity/intent unverified against spec.

### [Nit] Assignee dropdown on "New task" lists the two read-only observer accounts (ERC/DCA) as valid owners
- **Where:** `/board` → New task → Assignee `<select>` — options include
  `ERC (demo) · founder` and `DCA (demo) · founder`
- **Repro:** Open "New task" as founder, inspect the Assignee options.
- **Expected/actual:** Not fully verified whether actually submitting a task owned by ERC/DCA
  is accepted server-side or refused — I did not submit this combination, to avoid creating
  another test artifact needing cleanup after already restoring two others. Flagging as a
  reasoned, not-reproduced possibility: an observer account being assignable as a task owner
  seems to conflict with "read-only," but I can't rule out this is intentional (e.g., a
  founder can be tagged as ERC/DCA for administrative reasons in the seed).
- **Confidence:** unverified (code/UI reading only — the option renders, submission untested).

## Held up under attack

- **Right-click context menu vs 3-dot "More actions" menu produce byte-identical items**
  ("Submit for approval" / "Declare a block" / "Open task") for the same card — confirmed by
  opening both live and comparing the accessible menu tree.
- **Task modal comment/worklog scroll region is real and independent of the modal chrome.**
  Verified via `document.querySelectorAll` that the note list is a
  `max-h-[320px] overflow-y-auto` region nested inside a `flex-1 overflow-y-auto` main pane,
  while the header, title, action buttons and "Add note" input never move. Tested against the
  task with 72 real worklog rows (see hygiene defect above) — genuinely tall content, real
  independent scroll.
- **The Monday lock correctly separates definition from progress.** A committed "This week"
  task for GM shows a "Definition locked" chip and an explanatory banner ("ask the GM to
  raise a task edit request"), while "Submit for approval," "Declare a block" and the
  worklog note box remain fully live. This is exactly the distinction PLAN §10.1 called "the
  worst possible defect" to get wrong, and it is not wrong.
- **Full edit-request cycle, both directions, tested live end to end:**
  GM raised a change (rename), founder approved it → title changed on the board immediately,
  and the task's permanent "Change requests" log recorded it with reason and timestamp. Then
  GM raised a second change (rename back), founder **rejected** it with a decision reason →
  the title did **not** change, and GM's own view of the task shows "Rejected" plus the
  founder's decision reason verbatim. Finally raised and approved a third request to restore
  the original title exactly, leaving the task's title as found (the append-only "Change
  requests" log now has 3 entries — expected/harmless, same principle as the points ledger
  being append-only, not something to "clean up").
- **Reliability / hit-rate / median-cycle-time gating, verified with a working positive
  control.** Founder's `/scoreboard` shows Hit-rate and Reliability columns with real numbers
  matching the brief's expectation (Broker 37 "At risk," GM 88 "Solid," Sales 100
  "Excellent"). The identical GM login sees **no** Hit-rate/Reliability columns at all on
  `/scoreboard`, and the identical GM login's `/briefing` "Last week's scorecard" table is
  missing the Hit-rate column that the founder's version has. Because the founder version
  visibly renders the numbers, this proves the hiding on the GM side is a real gate, not a
  broken query returning nulls everywhere.
- **`/people/:id` profile hides reliability/hit-rate for GM viewing their own profile** —
  shows raw cleared count, capped score, last-closed-week committed/cleared/carry-over and
  blocked-time, nothing else.
- **XSS / unicode / emoji title input is safe.** Submitted
  `<script>alert(1)</script> Ünïcödé 测试 🚀 title-XSS-test` as a task title — rendered as
  literal escaped text everywhere (card, aria-label, dialog), never executed, no console
  error, no layout break.
- **No page-level horizontal scroll** at 375 / 768 / 1024 / 1440 on `/`, `/board`,
  `/scoreboard` (`document.documentElement.scrollWidth === window.innerWidth` at every
  width). The board's own horizontal column-scroll stays correctly contained inside its own
  scroll region and does not leak to the page.
- **Catalog reads correctly for read-only ERC** — full list of 15 catalog types with
  placeholder-pricing warnings, no write affordances, nothing disabled/broken (this is the
  positive control that shows the Board card lockout above is specific to Board, not a
  blanket read failure).
- **Console is clean.** Across the whole session, the only console errors seen were: (a) one
  expected `400` on a stale refresh-token exchange on cold load (normal Supabase behavior,
  not app-caused), and (b) the two `ERR_CONNECTION_REFUSED` during the concurrent-edit window
  described above. Zero new console errors during any of the flows tested after the API
  settled.
- **"Zero vs nothing" rule holds.** A task with no catalog type shows `—` (em dash) for
  points, not `0`; reliability for a thin file (Founder, ERC, DCA — all under 3 weeks of
  history) renders `—` / "Unrated," never `0`.

## Not tested

- **Drag-and-drop physically** (mouse-drag a card between columns) — I exercised every
  transition via the equivalent menu actions (context menu / 3-dot / status buttons) instead,
  which the app's own copy states goes through "the same check a button click would." I did
  not separately verify the `@dnd-kit` keyboard sensor, drop animations, or the
  illegal-target cursor states from DESIGN.md §7.3.
- **Submit → GM verify → Founder clear full chain with real point-banking**, and the points-
  clearing animation (DESIGN §7.4) — I avoided pushing a real task through to `cleared`
  because that would have changed the founder's actual points ledger and this week's
  reliability inputs, which the brief asked me not to disturb.
- **`/admin/*` routes** — not reachable from the six demo persona pills; I did not attempt to
  construct an admin login separately, since the brief listed `/admin/*` as in scope but gave
  no admin credentials alongside the demo logins.
- **`/set-password`** — no invite token was available to drive this flow in this session.
- **Sales and Broker staff personas** — logged into board/queue implicitly via data shown to
  founder/GM, but did not separately drive `/now`, `/points`, `/inbox`, `/digest` as
  `sales-demo` or `broker-demo` directly.
- **DCA persona** — assumed to share ERC's code path (`authority: founder, readOnly: true`)
  based on the identical `definitionLockRefusal` and gating logic; did not independently
  re-drive every screen as `dca-demo` given time constraints. The Board-card-disabled defect
  above should be assumed to reproduce identically for DCA but was not independently clicked.
- **Full RLS/security adversarial sweep** — explicitly out of scope per this run's brief
  ("a separate adversarial sweep already covered security").
- **`npm run validate` / `npm run build`** — not run in this pass; scope was live UI driving,
  not build honesty.

---

# ORCHESTRATOR TRIAGE — 2026-09-10

## The [Major] is a FALSE POSITIVE. Do not act on it as written.

> "Read-only observers (ERC/DCA) cannot open *any* task card on `/board`"

**They can.** Re-tested live as `erc-demo`, dispatching a genuine `click` event the way a mouse
does rather than Playwright's `.click()` helper:

```
cards on board: 42
card aria-disabled: "true"     pointer-events: auto
dialog opened: YES
dialog text: "[DEMO] Quotation for a lead that went cold / Returned /
              Your account is read-only. / Rework it / Owner ... "
```

The task modal opens, renders the full detail, and shows the read-only notice.

**Why the original test failed:** Playwright's `.click()` runs an actionability check that
**refuses to click an element with `aria-disabled="true"`** and waits for it to become enabled,
which never happens — so it times out. The timeout was the test harness declining to act, not
the app refusing to respond.

The agent's stated "positive control" was other *pages* (catalog, scoreboard) rendering for ERC.
That controls for "is ERC's session working", which was never in doubt. It does not control for
"can Playwright click an aria-disabled element", which is the thing that actually varied. A
control has to vary the suspected cause, not merely produce a success somewhere.

## There IS a real defect here, and it is smaller

`aria-disabled="true"` sits on the whole card because dnd-kit's `useDraggable({ disabled })`
puts it there — and for a read-only user the card is not draggable. But the card is **fully
readable and clickable**: it opens the modal, which is the primary way to read a task.

Announcing "disabled" to a screen-reader user for a card they can open and read is wrong, and
it is what broke the automated test. **Severity: Minor (accessibility), not Major (blocked
functionality).** The distinction matters — as written, the finding says observers cannot read
tasks at all, which would be a serious regression in the feature Chan asked for, and it is not
true.

`aria-roledescription` already carries the honest distinction: `"task card"` when it cannot be
dragged, `"draggable task card"` when it can.

## Note on this run's conditions

The report's caveat is fair and it was my fault: I started an agent editing `apps/api/src` while
this regression was running, which restarted the API mid-pass. The affected findings were
re-checked above. Do not run an editing agent against the same tree as a live regression.
