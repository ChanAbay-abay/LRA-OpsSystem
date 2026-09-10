# Adversarial pass — the Monday lock and GM edit requests

**2026-09-10, run by the orchestrator against the LIVE project** (ref `ttrjzyyuktropkufkcoj`),
**straight at PostgREST with real user JWTs — the API was not involved.** That is the point:
PostgREST is reachable without going through `apps/api`, so anything the API alone enforces is
not enforced at all. Every result below is the database's own answer.

## The commitment lock — a committed task in a started (`open`) week

| Attack | Result | |
|---|---|---|
| Staff owner rewrites the title | `403` — "a committed task's definition … " | refused |
| **Staff owner moves status `todo → in_progress`** | **`200`, 1 row** | **allowed — correct** |
| Staff owner changes the catalog type (and so its points) | `403` | refused |
| Staff owner reassigns it to someone else | `403` | refused |
| GM rewrites the title directly | `403` | refused |
| Read-only ERC rewrites the title | `200`, **0 rows** | refused |
| Clearing founder rewrites the title | `200`, 1 row | allowed by design |

The second row is the one that matters most. The lock is on a task's **definition**, never on its
**progress** — a lock that also stopped people working would make the app useless for the people
it is for.

ERC's `200 / 0 rows` is not a hole: RLS filters the row out of the UPDATE entirely, so nothing
matched and nothing changed. PostgREST reports that as success-with-no-rows, which is why the row
count, not the status code, is the thing to read.

## The edit-request flow

| Attack | Result | |
|---|---|---|
| Staff raises a request | `403` — "only GM, founder or admin may raise" | refused |
| Read-only ERC raises a request | `403` — "a read-only account may not raise" | refused |
| **GM forges `requested_by` as the founder** | **`403` — "requested_by must be the caller"** | **refused** |
| GM raises a legitimate request | created | allowed |
| GM approves their **own** request | `403` — "only the clearing founder may decide" | refused |
| Read-only ERC approves | `200`, **0 rows** | refused |
| Staff approves | `403` | refused |
| Clearing founder approves | `200`, 1 row — **the task's title actually changed** | allowed |
| **Founder re-approves the same request (replay)** | **`403` — "already been decided (approved)"** | **refused** |

Two of these are worth calling out.

**Identity forgery is closed.** A GM inserting a request stamped `requested_by = <the founder>`
is refused. This is the exact bug class that produced HR's stamp-forgery defects, and it is the
reason `requested_by` is checked against the caller rather than trusted from the payload.

**Replay is closed.** A decided request cannot be decided again, so an approved change cannot be
re-applied later by re-sending the same approval.

## A structural property, not a test result

`ops.task_edit_requests` stores each proposable field as its own typed column
(`change_title` / `proposed_title`, and so on) rather than a free-form `jsonb` patch. So the
strongest attack against this kind of flow — crafting a request that proposes a change to a
column the flow was never meant to touch, such as `points_override`, `is_committed` or `status` —
**cannot be expressed at all.** That is a design choice doing security work, and it should survive
any future refactor of this table.

## Corrections to my own method

Two early runs produced refusals that were **my** fault, not findings:

- Omitting `requested_by` made every insert fail with "requested_by must be the caller", which
  briefly looked like the GM path was broken.
- Reading only the HTTP status would have scored ERC's `200 / 0 rows` as a successful attack. The
  row count is the signal.

Both were re-run correctly before anything was recorded. See `docs/AGENT-LESSONS.md` §4.

## Data touched

The probe mutated one demo task (`0d358ea6…`, "[DEMO] Arrange trucking for shipment #HIST-3") and
restored its title and `todo` status afterwards. The approved probe request row was **deliberately
left in place**: the table is append-only by design and deleting a decided request to tidy up
would contradict the guarantee the feature exists to provide.
