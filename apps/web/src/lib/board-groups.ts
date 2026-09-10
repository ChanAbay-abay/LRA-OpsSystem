/**
 * LRA Global Ops :: the board's five lanes, and which columns share one
 *
 * Chan, 2026-09-10, verbatim: **"i want you to group the columns. backlog
 * and this week should be on the same column just on switchable tabs.
 * verified and cleared should also work the same."**
 *
 * Seven columns become five lanes. Nothing about a COLUMN changes:
 * `BoardColumn`, `COLUMN_STATUS`, `COLUMN_LABEL` and every rule in
 * `lib/task-permissions.ts` are untouched, and `moveRefusal` knows
 * nothing about groups. **A tab is a presentation of an existing column,
 * never a new one** — the API still returns all seven keys and the
 * grouping is entirely client-side.
 *
 * This module is pure and exported on purpose (contract
 * `.claude/state/CONTRACT-BOARD-GROUPING.md`): which tab owns which
 * column, the per-tab counts under a filter, whether a whole lane may be
 * dimmed, and "how many matches are in the tab you cannot see" are
 * exactly the four things that break silently inside a component and
 * cannot be reached by a test there. `board-groups.test.ts` pins all
 * four.
 *
 * The two hazards worth naming here, because they are the reason these
 * functions exist rather than three inline ternaries in `board.tsx`:
 *
 *  1. **Dimming is per tab, never per group.** `this_week` is never a
 *     drop target ("This week's commitments are set in the Monday
 *     briefing, not on the board") — so a lane that dimmed whenever ANY
 *     of its tabs refused would make the whole Plan lane look dead on
 *     every single drag, including the drags that Backlog would happily
 *     accept. `laneDimRefusal` therefore only answers non-null when
 *     EVERY tab in the lane refuses.
 *  2. **A tab may hide a card; it may never hide the existence of work.**
 *     The board filters every column by search + owner. With tabs, a
 *     match sitting in the inactive tab is invisible and the reader
 *     concludes the task does not exist. `matchesElsewhere` is the
 *     answer the empty body turns into a control they can click.
 */
import { COLUMN_LABEL, type BoardColumn } from './task-permissions';

/** A lane's group identity. `null` lanes are a single column, as before. */
export type BoardGroupId = 'plan' | 'settled';

export interface BoardTab {
  id: BoardColumn;
  /**
   * Whether a card can ever be dropped into this column at all — the
   * same flag the seven-column board carried. `this_week` is false
   * because commitment happens in the Monday briefing; it is a per-COLUMN
   * fact, which is why it lives on the tab and not on the lane.
   */
  droppable: boolean;
}

export interface BoardLane {
  /** Stable React key and the stem of every DOM id this lane generates. */
  id: string;
  /** Null for a single-column lane; set for a tabbed one. */
  group: BoardGroupId | null;
  /** In display order. The first tab is the fallback for bad stored state. */
  tabs: BoardTab[];
}

/**
 * The board, in the order work flows through it. The order is unchanged
 * from the seven-column board — only the first and last lanes gained a
 * second tab.
 */
export const BOARD_LANES: readonly BoardLane[] = [
  {
    id: 'plan',
    group: 'plan',
    tabs: [
      { id: 'backlog', droppable: true },
      { id: 'this_week', droppable: false },
    ],
  },
  { id: 'in_progress', group: null, tabs: [{ id: 'in_progress', droppable: true }] },
  { id: 'blocked', group: null, tabs: [{ id: 'blocked', droppable: true }] },
  { id: 'submitted', group: null, tabs: [{ id: 'submitted', droppable: true }] },
  {
    id: 'settled',
    group: 'settled',
    tabs: [
      { id: 'verified', droppable: true },
      { id: 'cleared', droppable: true },
    ],
  },
];

/** All seven columns, flat, in board order. */
export const BOARD_COLUMN_IDS: BoardColumn[] = BOARD_LANES.flatMap((lane) => lane.tabs.map((t) => t.id));

/** Which lane a column is rendered in, for the "switch to the tab this landed in" path. */
export function laneOf(column: BoardColumn): BoardLane {
  const lane = BOARD_LANES.find((l) => l.tabs.some((t) => t.id === column));
  // Every `BoardColumn` is in exactly one lane and the type system cannot
  // say so. If a status ever gains a column without gaining a lane, this
  // throws in development rather than rendering a board that silently
  // drops the new column — the same invariant `board.tsx`'s header
  // comment names ("every status a live task can hold resolves to a
  // visible column").
  if (!lane) throw new Error(`No board lane owns column "${column}"`);
  return lane;
}

/** The label a lane announces itself with: one column's name, or both, in order. */
export function laneLabel(lane: BoardLane): string {
  return lane.tabs.map((t) => COLUMN_LABEL[t.id]).join(' / ');
}

export const TAB_STORAGE_KEY = 'lra.board.tabs';

/**
 * The remembered tab per group. One key, one effect — following
 * `OWNER_FILTER_KEY`'s idiom in `board.tsx` and `PERIOD_STORAGE_KEY`'s in
 * `scoreboard-model.ts` rather than inventing a third persistence shape,
 * and validating what comes back: `localStorage` holds arbitrary text,
 * and an unrecognised column would leave a lane rendering `undefined`
 * tasks. Anything unrecognised falls back to the group's first tab.
 */
export type ActiveTabs = Record<BoardGroupId, BoardColumn>;

export const DEFAULT_ACTIVE_TABS: ActiveTabs = {
  plan: 'backlog',
  settled: 'verified',
};

export function readStoredTabs(raw: string | null): ActiveTabs {
  if (!raw) return { ...DEFAULT_ACTIVE_TABS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_ACTIVE_TABS };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_ACTIVE_TABS };
  const record = parsed as Record<string, unknown>;
  const next = { ...DEFAULT_ACTIVE_TABS };
  for (const lane of BOARD_LANES) {
    if (!lane.group) continue;
    const stored = record[lane.group];
    if (lane.tabs.some((t) => t.id === stored)) next[lane.group] = stored as BoardColumn;
  }
  return next;
}

export function serializeTabs(tabs: ActiveTabs): string {
  return JSON.stringify(tabs);
}

/** The column a lane is currently showing. Single-column lanes ignore the state entirely. */
export function activeTabOf(lane: BoardLane, tabs: ActiveTabs): BoardColumn {
  if (!lane.group) return lane.tabs[0].id;
  const current = tabs[lane.group];
  return lane.tabs.some((t) => t.id === current) ? current : lane.tabs[0].id;
}

/**
 * Tab-header drop ids are namespaced because the lane BODY is already a
 * droppable under the bare column id, and two dnd-kit droppables sharing
 * one id is undefined behaviour. Both resolve back to the same column —
 * a header drop and a body drop are the same move.
 */
export function tabDropId(column: BoardColumn): string {
  return `tab:${column}`;
}

/**
 * True for a tab-header droppable. The board's collision detection needs
 * this: a tab header only wins a drop when the pointer is physically
 * inside it, while the lane bodies are matched by centre distance as
 * before. Without the split, a card dragged over the TOP of a lane can be
 * closer to the inactive tab's centre than to the tall body's centre and
 * land in a tab the person was not aiming at.
 */
export function isTabDropId(id: string): boolean {
  return id.startsWith('tab:');
}

/** The column any droppable id on the board refers to, header or body. */
export function columnFromDropId(id: string): BoardColumn | null {
  const bare = id.startsWith('tab:') ? id.slice(4) : id;
  return BOARD_COLUMN_IDS.includes(bare as BoardColumn) ? (bare as BoardColumn) : null;
}

/** DOM ids for the tablist wiring, so the tab and its panel agree. */
export function tabElementId(column: BoardColumn): string {
  return `board-tab-${column}`;
}

export function panelElementId(column: BoardColumn): string {
  return `board-panel-${column}`;
}

/**
 * Why the whole lane is dimmed, or null. Non-null only when EVERY tab in
 * the lane refuses the dragged card — see hazard 1 in this file's header.
 * The sentence returned is the ACTIVE tab's refusal, because that is the
 * column the reader is looking at.
 */
export function laneDimRefusal(
  lane: BoardLane,
  activeTab: BoardColumn,
  refusalFor: (column: BoardColumn) => string | null
): string | null {
  const refusals = lane.tabs.map((t) => refusalFor(t.id));
  if (refusals.some((r) => r === null)) return null;
  return refusalFor(activeTab) ?? refusals[0];
}

/** Just enough of a `Task` to total a lane's points. */
interface PointedTask {
  points_override: number | null;
  catalog_points: number | null;
}

/** A column's point total — the lane's figure follows the ACTIVE tab, matching the old per-column total. */
export function columnPoints(tasks: PointedTask[]): number {
  return tasks.reduce((sum, t) => sum + (t.points_override ?? t.catalog_points ?? 0), 0);
}

/**
 * The sibling tab that has matches when the active one has none — the
 * live affordance required by contract item 5. Null whenever the active
 * tab has something to show, whenever the lane has no sibling, or
 * whenever the sibling is empty too (that is the genuine both-empty
 * state and gets the ordinary empty copy).
 *
 * `counts` is the FILTERED count per column. Answering off the unfiltered
 * board would offer to switch to a tab that then renders empty, which is
 * the same lie in the opposite direction.
 */
export function matchesElsewhere(
  lane: BoardLane,
  activeTab: BoardColumn,
  counts: Record<BoardColumn, number>
): { column: BoardColumn; count: number } | null {
  if ((counts[activeTab] ?? 0) > 0) return null;
  for (const tab of lane.tabs) {
    if (tab.id === activeTab) continue;
    const count = counts[tab.id] ?? 0;
    if (count > 0) return { column: tab.id, count };
  }
  return null;
}

/**
 * The words on that affordance. "matches" while a filter is on, "tasks"
 * when it is not: with no filter the reader is being told work exists in
 * the other tab, not that their search found something.
 */
export function matchesElsewhereLabel(found: { column: BoardColumn; count: number }, filtering: boolean): string {
  const noun = filtering ? (found.count === 1 ? 'match' : 'matches') : found.count === 1 ? 'task' : 'tasks';
  return `${found.count} ${noun} in ${COLUMN_LABEL[found.column]}`;
}

/**
 * The count chip's tooltip. A filtered count of 3 on a column holding 12
 * is honest about the 3 and silent about the 12; this says both, so a tab
 * can never be read as "there is nothing here" when the filter is what
 * emptied it (contract item 4). Null when nothing is being hidden.
 */
export function countChipTitle(visible: number, total: number): string | null {
  if (visible === total) return null;
  return `${visible} of ${total} match the current filter`;
}

/**
 * Roving-focus arithmetic for the tablist, per contract item 7 (Left /
 * Right between tabs, Home / End to the ends). Returned as an index so
 * the component only has to focus and select; returns null for a key this
 * tablist does not own, so the event is left alone.
 */
export function nextTabIndex(key: string, current: number, length: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % length;
    case 'ArrowLeft':
      return (current - 1 + length) % length;
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return null;
  }
}
