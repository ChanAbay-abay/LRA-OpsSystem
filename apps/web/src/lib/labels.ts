/**
 * LRA Global Ops :: the label layer — DESIGN.md §17
 *
 * > "`apps/web/src/lib/labels.ts` is the only file in the web app that
 * > may contain a display string for a database enum." A component that
 * > needs a word calls one of the functions below. A component that
 * > contains `'In Progress'` as a literal is a defect.
 *
 * Chan: "things like in_progress should be In Progress." He was
 * describing a symptom — the cause was seven different modules each
 * holding their own copy of the same handful of words, and
 * `routes/points.tsx` holding none at all (it printed
 * `row.from_status → row.to_status` straight from the database). This
 * file is the fix: one table per enum, one typed accessor per table.
 *
 * Every accessor takes a plain `string` — the shape a Postgres enum
 * actually arrives in over JSON — and never throws. An unrecognised key
 * renders as itself (the caller styles that in `--ink-3`, per §17.2) and
 * `console.warn`s in dev, so a schema change that ships without a label
 * update is loud in the console and never a blank chip in front of
 * Chan's staff. The lookup tables themselves are still written against
 * the real union type and checked with `satisfies`, so forgetting a
 * member when a NEW enum is added here is a compile error, not a
 * runtime surprise — that is what "typed helpers, not a loose record"
 * buys over `Record<string, string>`.
 *
 * Tone rules (§17.2), binding for every entry below:
 *   - Title Case for the name of a state (it is the state's proper
 *     name). Sentence case for everything else.
 *   - A label is at most two words. A sentence belongs in `hint`, not
 *     the label.
 *   - Never `key.replace(/_/g, ' ')`. Banned — it is both wrong and
 *     plausible.
 *
 * `statusTone()` (which semantic hue a status paints) stays in
 * `lib/task-types.ts` on purpose — it is a colour decision and belongs
 * with the design layer, not the language layer.
 */

// ---------------------------------------------------------------------
// The shared lookup machinery
// ---------------------------------------------------------------------

interface EnumEntry {
  /** ≤ 2 words, Title Case for a state's proper name (§17.2). */
  label: string;
  /** The one-line tooltip copy for `<Hint>` (§20). ≤ 20 words (§20.5). */
  hint?: string;
}

/**
 * Builds the three accessors every enum in this file needs. `kind` is
 * only ever seen in a dev console warning, so it can be a plain English
 * name ("task status") rather than a code identifier.
 */
function makeLookup<K extends string>(kind: string, table: Record<K, EnumEntry>) {
  const known = table as Record<string, EnumEntry>;
  function entry(key: string): EnumEntry {
    const found = known[key];
    if (found) return found;
    if (import.meta.env?.DEV) {
      // eslint-disable-next-line no-console -- the one sanctioned console use this file gets: an unhandled enum value must be loud somewhere.
      console.warn(`lib/labels.ts: unknown ${kind} "${key}" — rendering the raw key.`);
    }
    // Unknown key renders as itself, never blank, never a guess (§17.2).
    return { label: key };
  }
  return {
    label: (key: string): string => entry(key).label,
    hint: (key: string): string => entry(key).hint ?? '',
    isKnown: (key: string): boolean => key in known,
  };
}

// ---------------------------------------------------------------------
// Task status — ops.task_status — and the ledger, which shares it
// ---------------------------------------------------------------------

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'submitted'
  | 'verified'
  | 'cleared'
  | 'rejected'
  | 'cancelled'
  | 'pending_cancellation';

const TASK_STATUS = {
  todo: { label: 'Backlog', hint: 'Agreed, not started yet.' },
  in_progress: { label: 'In Progress', hint: 'Someone is working on this right now.' },
  submitted: { label: 'Submitted', hint: 'Sent to the GM to check.' },
  verified: {
    label: 'Verified',
    hint: 'The GM checked it. Waiting on the founder to release the points.',
  },
  cleared: { label: 'Cleared', hint: 'Done. The points are yours.' },
  rejected: { label: 'Returned', hint: 'Sent back with a reason. Fix it and submit again.' },
  cancelled: { label: 'Cancelled', hint: 'Called off. No points for it.' },
  pending_cancellation: {
    label: 'Cancellation Requested',
    hint: 'Someone asked to call this off. Waiting on a decision.',
  },
} satisfies Record<TaskStatus, EnumEntry>;

const taskStatus = makeLookup<TaskStatus>('task status', TASK_STATUS);

/** `in_progress` → `In Progress`. Also the ledger's own state — same table (§17.3). */
export const taskStatusLabel = taskStatus.label;
export const taskStatusHint = taskStatus.hint;
export const taskStatusIsKnown = taskStatus.isKnown;

/** `U+2192` flanked by a hairspace (`U+200A`) either side — §17.3. */
const ARROW = ' → ';

/**
 * The ledger's transition line, exact per §17.3: `Backlog → In Progress`,
 * never the raw keys.
 */
export function taskStatusTransition(from: string, to: string): string {
  return `${taskStatusLabel(from)}${ARROW}${taskStatusLabel(to)}`;
}

// ---------------------------------------------------------------------
// Board columns — five lanes, seven drop targets (`this_week` and
// `blocked` do not map onto a real `ops.task_status`)
// ---------------------------------------------------------------------

export type BoardColumn =
  | 'backlog'
  | 'this_week'
  | 'in_progress'
  | 'blocked'
  | 'submitted'
  | 'verified'
  | 'cleared';

const BOARD_COLUMN = {
  backlog: { label: 'Backlog' },
  this_week: { label: 'This Week' },
  in_progress: { label: 'In Progress' },
  blocked: { label: 'Blocked' },
  submitted: { label: 'Submitted' },
  verified: { label: 'Verified' },
  cleared: { label: 'Cleared' },
} satisfies Record<BoardColumn, EnumEntry>;

export const boardColumnLabel = makeLookup<BoardColumn>('board column', BOARD_COLUMN).label;

// ---------------------------------------------------------------------
// Authority — core.authority — plus the read-only override
// ---------------------------------------------------------------------

export type Authority = 'staff' | 'gm' | 'founder' | 'admin';

const AUTHORITY = {
  staff: { label: 'Staff' },
  gm: { label: 'GM' },
  founder: { label: 'Founder' },
  admin: { label: 'Admin' },
} satisfies Record<Authority, EnumEntry>;

const authority = makeLookup<Authority>('authority', AUTHORITY);

/**
 * `readOnly` outranks the base authority word — a strictly read-only
 * founder account (ERC, DCA — `core.is_read_only()`) reads **Read-only**
 * on screen, never `Founder`. §17.3: "Never `oversight_only` on screen."
 */
export function authorityLabel(value: string, readOnly?: boolean): string {
  if (readOnly) return 'Read-only';
  return authority.label(value);
}

// ---------------------------------------------------------------------
// Position — core.position
// ---------------------------------------------------------------------

export type Position = 'founder' | 'gm' | 'sales' | 'broker' | 'hr_officer' | 'accounting' | 'other';

const POSITION = {
  founder: { label: 'Founder' },
  gm: { label: 'GM' },
  sales: { label: 'Sales' },
  broker: { label: 'Broker' },
  hr_officer: { label: 'HR Officer' },
  accounting: { label: 'Accounting' },
  other: { label: 'Other' },
} satisfies Record<Position, EnumEntry>;

/** §17.3: never `capitalize` on the raw column — that renders `Oversight_only`. */
export const positionLabel = makeLookup<Position>('position', POSITION).label;

// ---------------------------------------------------------------------
// Reliability band
// ---------------------------------------------------------------------

export type ReliabilityBand = 'excellent' | 'solid' | 'watch' | 'at_risk' | 'unrated';

const RELIABILITY_BAND = {
  excellent: { label: 'Excellent' },
  solid: { label: 'Solid' },
  watch: { label: 'Watch' },
  at_risk: { label: 'At risk' },
  unrated: { label: 'Unrated' },
} satisfies Record<ReliabilityBand, EnumEntry>;

export const reliabilityBandLabel = makeLookup<ReliabilityBand>('reliability band', RELIABILITY_BAND).label;

// ---------------------------------------------------------------------
// Block target and block relation — moved from `lib/task-types.ts`,
// wording unchanged (§17.1's move table)
// ---------------------------------------------------------------------

export type BlockTarget = 'task' | 'person' | 'external';

/**
 * Chan, 2026-09-10: "i want it to be more clear which tasks you're
 * blocking and which tasks you're not."
 *
 * Two relationships used to render identically — a block on your own
 * work that you are waiting on someone for, and a block that names YOU
 * as the thing everyone else is waiting for. They are opposite
 * accountabilities, so they get their own words everywhere a block is
 * rendered (Now's two sections, the board card, the modal's block
 * panel) and those words are decided here, once.
 *
 * `waiting-on-you` deliberately outranks `raised-by-you`: if you both
 * declared the block and are named as the blocker, the consequential
 * fact is that the work is stalled on you, not that you filed it.
 */
export type BlockRelation = 'waiting-on-you' | 'raised-by-you' | 'waiting-on-other';

export interface BlockParties {
  created_by: string;
  blocking_user_id: string | null;
}

export function blockRelation(block: BlockParties, meId: string | undefined): BlockRelation {
  if (meId && block.blocking_user_id === meId) return 'waiting-on-you';
  if (meId && block.created_by === meId) return 'raised-by-you';
  return 'waiting-on-other';
}

/**
 * The one sentence for a relationship, short enough for a 288px board
 * card's truncated caption and complete enough for its `<Hint>` and the
 * modal. `blockingName` is whoever/whatever the block names — a team
 * member's display name or the free-text outside party.
 */
export function blockRelationLabel(
  relation: BlockRelation,
  blockingName: string | null,
  // Plain `string`, not `BlockTarget` — `ops.task_blocks.target` arrives
  // over the API as an unnarrowed string (see `TaskBlock` in
  // `lib/task-types.ts`), and every call site passes that straight
  // through.
  target?: string
): string {
  // A block whose name could not be resolved still has to read as
  // something true. "someone else" is wrong for a task-target block —
  // that block names no person at all — so the fallback follows the
  // target. DESIGN.md §8: an absence is rendered as an absence, never
  // as a guessed name.
  const named = blockingName ?? (target === 'task' ? 'another task' : 'someone else');
  switch (relation) {
    case 'waiting-on-you':
      return 'Waiting on you';
    case 'raised-by-you':
      return `You flagged this — waiting on ${named}`;
    case 'waiting-on-other':
      return `Waiting on ${named}`;
  }
}

// ---------------------------------------------------------------------
// Edit-request / edit-suggestion state — ops.task_edit_requests.status
// ---------------------------------------------------------------------

export type EditRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

const EDIT_REQUEST_STATUS = {
  pending: { label: 'Pending' },
  approved: { label: 'Approved' },
  rejected: { label: 'Rejected' },
  withdrawn: { label: 'Withdrawn' },
} satisfies Record<EditRequestStatus, EnumEntry>;

export const editRequestStatusLabel = makeLookup<EditRequestStatus>('edit request status', EDIT_REQUEST_STATUS).label;

// ---------------------------------------------------------------------
// Week state — ops.week_state
// ---------------------------------------------------------------------

export type WeekState = 'planning' | 'open' | 'closed';

const WEEK_STATE = {
  planning: { label: 'Planning', hint: "Monday's meeting hasn't been closed yet." },
  open: { label: 'Open', hint: 'Commitments are locked. Work is in flight.' },
  closed: { label: 'Closed', hint: 'The week is finished and scored.' },
} satisfies Record<WeekState, EnumEntry>;

const weekState = makeLookup<WeekState>('week state', WEEK_STATE);
export const weekStateLabel = weekState.label;
export const weekStateHint = weekState.hint;

// ---------------------------------------------------------------------
// Points segment — the settlement bar's four buckets (§6.2)
// ---------------------------------------------------------------------

export type PointsSegment = 'completed' | 'pending' | 'atRisk' | 'toDo';

const POINTS_SEGMENT = {
  completed: { label: 'completed' },
  pending: { label: 'pending approval' },
  atRisk: { label: 'awaiting a cancellation decision' },
  toDo: { label: 'still to do' },
} satisfies Record<PointsSegment, EnumEntry>;

export const pointsSegmentLabel = makeLookup<PointsSegment>('points segment', POINTS_SEGMENT).label;

// ---------------------------------------------------------------------
// Scoreboard period tab — the reader's chosen window, not a fact about
// how many weeks it actually spans (that's `scoreboard-model.ts`'s job)
// ---------------------------------------------------------------------

export type PeriodKey = 'week' | 'month' | 'quarter' | 'all';

const PERIOD_TAB = {
  week: { label: 'This week' },
  month: { label: '4 weeks' },
  quarter: { label: '13 weeks' },
  all: { label: 'All time' },
} satisfies Record<PeriodKey, EnumEntry>;

export const periodTabLabel = makeLookup<PeriodKey>('period tab', PERIOD_TAB).label;

// ---------------------------------------------------------------------
// Suggestion field — the five `ops.task_edit_requests` fields a GM's
// bulk edit draft (lib/edit-suggestions.ts) can propose
// ---------------------------------------------------------------------

export type SuggestionField = 'title' | 'description' | 'task_type_id' | 'owner_user_id' | 'client_ref';

const SUGGESTION_FIELD = {
  title: { label: 'Title' },
  description: { label: 'Description' },
  task_type_id: { label: 'Catalog type' },
  owner_user_id: { label: 'Owner' },
  client_ref: { label: 'Client reference' },
} satisfies Record<SuggestionField, EnumEntry>;

export const suggestionFieldLabel = makeLookup<SuggestionField>('suggestion field', SUGGESTION_FIELD).label;

// ---------------------------------------------------------------------
// Leaderboard visibility — ops.settings.leaderboard_visibility
// ---------------------------------------------------------------------

export type LeaderboardVisibility = 'all' | 'oversight_only';

const LEADERBOARD_VISIBILITY = {
  all: { label: 'Everyone' },
  oversight_only: { label: 'Oversight only' },
} satisfies Record<LeaderboardVisibility, EnumEntry>;

export const leaderboardVisibilityLabel = makeLookup<LeaderboardVisibility>(
  'leaderboard visibility',
  LEADERBOARD_VISIBILITY
).label;

// ---------------------------------------------------------------------
// Audit action — core.audit_logs.action, `/admin/audit` and the task
// detail dialog's History timeline — grepped from every
// `insert into core.audit_logs` in supabase/migrations/*.sql so none is
// missed. Unlike the enums above this isn't a Postgres enum type (the
// column is `text`, and a future migration can add an action this table
// has never seen), which is exactly why it still belongs here and not
// as a scattered per-screen switch: `makeLookup`'s unknown-key fallback
// (render the raw key, warn in dev) is what keeps a new action from
// shipping as a blank cell instead of a defect someone notices.
// ---------------------------------------------------------------------

export type AuditAction =
  | 'ops.briefing.closed'
  | 'ops.task.admin_corrected'
  | 'ops.task.admin_forced_transition'
  | 'ops.task.cancellation_approved'
  | 'ops.task.cancellation_flagged'
  | 'ops.task.cancellation_refused'
  | 'ops.task.definition_edited_directly'
  | 'ops.task_edit_batch.approved'
  | 'ops.task_edit_batch.rejected'
  | 'ops.task_edit_batch.withdrawn'
  | 'ops.task_edit_request.approved'
  | 'ops.task_edit_request.rejected'
  | 'ops.task_edit_request.withdrawn';

const AUDIT_ACTION = {
  'ops.briefing.closed': { label: 'Briefing closed' },
  'ops.task.admin_corrected': { label: 'Corrected by an admin' },
  'ops.task.admin_forced_transition': { label: 'Status forced by an admin' },
  'ops.task.cancellation_approved': { label: 'Cancellation approved' },
  'ops.task.cancellation_flagged': { label: 'Cancellation requested' },
  'ops.task.cancellation_refused': { label: 'Cancellation refused' },
  'ops.task.definition_edited_directly': { label: 'Definition edited directly' },
  'ops.task_edit_batch.approved': { label: 'Edit batch approved' },
  'ops.task_edit_batch.rejected': { label: 'Edit batch rejected' },
  'ops.task_edit_batch.withdrawn': { label: 'Edit batch withdrawn' },
  'ops.task_edit_request.approved': { label: 'Edit request approved' },
  'ops.task_edit_request.rejected': { label: 'Edit request rejected' },
  'ops.task_edit_request.withdrawn': { label: 'Edit request withdrawn' },
} satisfies Record<AuditAction, EnumEntry>;

export const auditActionLabel = makeLookup<AuditAction>('audit action', AUDIT_ACTION).label;

// ---------------------------------------------------------------------
// Audit entity type — core.audit_logs.entity_type, every literal value
// an `insert into core.audit_logs` in the migrations names.
// ---------------------------------------------------------------------

export type AuditEntityType = 'ops.task' | 'ops.task_edit_batch' | 'ops.task_edit_request' | 'ops.week';

const AUDIT_ENTITY_TYPE = {
  'ops.task': { label: 'Task' },
  'ops.task_edit_batch': { label: 'Edit batch' },
  'ops.task_edit_request': { label: 'Edit request' },
  'ops.week': { label: 'Week' },
} satisfies Record<AuditEntityType, EnumEntry>;

export const auditEntityTypeLabel = makeLookup<AuditEntityType>('audit entity type', AUDIT_ENTITY_TYPE).label;

// ---------------------------------------------------------------------
// Audit field — the keys that show up inside `old_values`/`new_values`
// on an audit row (`/admin/audit`'s before/after panel). Every key any
// `insert into core.audit_logs` builds with `jsonb_build_object`, so a
// reader sees "Owner" and "Points override", not `owner_user_id` and
// `points_override`. `stamps_not_derived` (a bookkeeping flag on
// `ops.task.admin_forced_transition`, meaningless to a reader) is
// deliberately absent — the caller filters it out before this is ever
// reached, same as an absent key renders nothing rather than a guess.
// ---------------------------------------------------------------------

export type AuditFieldKey =
  | 'title'
  | 'description'
  | 'task_type_id'
  | 'owner_user_id'
  | 'client_ref'
  | 'points_override'
  | 'points_override_reason'
  | 'status'
  | 'reason'
  | 'decision_reason'
  | 'requested_by'
  | 'item_count'
  | 'week_start'
  | 'week_id'
  | 'task_id'
  | 'before_values'
  | 'after_values';

const AUDIT_FIELD = {
  title: { label: 'Title' },
  description: { label: 'Description' },
  task_type_id: { label: 'Catalog type' },
  owner_user_id: { label: 'Owner' },
  client_ref: { label: 'Client reference' },
  points_override: { label: 'Points override' },
  points_override_reason: { label: 'Override reason' },
  status: { label: 'Status' },
  reason: { label: 'Reason' },
  decision_reason: { label: 'Decision reason' },
  requested_by: { label: 'Requested by' },
  item_count: { label: 'Item count' },
  week_start: { label: 'Week start' },
  week_id: { label: 'Week' },
  task_id: { label: 'Task' },
  before_values: { label: 'Before' },
  after_values: { label: 'After' },
} satisfies Record<AuditFieldKey, EnumEntry>;

export const auditFieldLabel = makeLookup<AuditFieldKey>('audit field', AUDIT_FIELD).label;
