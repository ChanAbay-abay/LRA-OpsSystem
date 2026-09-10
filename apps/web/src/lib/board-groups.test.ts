/**
 * LRA Global Ops :: board grouping unit tests
 *
 * The four things the tabbed board can lie about quietly, tested with no
 * DOM and no React — the level `task-permissions.test.ts` and
 * `scoreboard-model.test.ts` already work at:
 *
 *   1. the lane set still covers all seven columns exactly once, and no
 *      column rule moved onto a lane;
 *   2. dimming is per TAB — a lane only goes dark when both of its tabs
 *      refuse, so `this_week` never kills the Plan lane on a drag Backlog
 *      would accept (contract item 2);
 *   3. a filtered match in the hidden tab is still reachable, and the
 *      count chips never claim a filtered zero is an empty column
 *      (contract items 4 and 5);
 *   4. stored tab state is validated — `localStorage` holds anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_COLUMN_IDS,
  BOARD_LANES,
  DEFAULT_ACTIVE_TABS,
  activeTabOf,
  columnFromDropId,
  columnPoints,
  countChipTitle,
  laneDimRefusal,
  laneLabel,
  laneOf,
  isTabDropId,
  matchesElsewhere,
  matchesElsewhereLabel,
  nextTabIndex,
  readStoredTabs,
  serializeTabs,
  tabDropId,
  type ActiveTabs,
} from './board-groups';
import { COLUMN_LABEL, type BoardColumn } from './task-permissions';

const ALL_COLUMNS = Object.keys(COLUMN_LABEL) as BoardColumn[];

function counts(overrides: Partial<Record<BoardColumn, number>> = {}): Record<BoardColumn, number> {
  const zero = Object.fromEntries(ALL_COLUMNS.map((c) => [c, 0])) as Record<BoardColumn, number>;
  return { ...zero, ...overrides };
}

// ---------------------------------------------------------------- shape

test('five lanes cover all seven columns exactly once, in the same order', () => {
  assert.equal(BOARD_LANES.length, 5);
  assert.deepEqual(BOARD_COLUMN_IDS, [
    'backlog',
    'this_week',
    'in_progress',
    'blocked',
    'submitted',
    'verified',
    'cleared',
  ]);
  // No column may be dropped or duplicated by the grouping — the board's
  // "every status resolves to a visible column" invariant.
  assert.equal(new Set(BOARD_COLUMN_IDS).size, ALL_COLUMNS.length);
  for (const c of ALL_COLUMNS) assert.ok(BOARD_COLUMN_IDS.includes(c), `${c} has no lane`);
});

test('droppability stayed a per-column fact — only this_week is closed', () => {
  const closed = BOARD_LANES.flatMap((l) => l.tabs).filter((t) => !t.droppable);
  assert.deepEqual(
    closed.map((t) => t.id),
    ['this_week']
  );
});

test('laneOf finds the lane a column renders in, tabbed or not', () => {
  assert.equal(laneOf('this_week').id, 'plan');
  assert.equal(laneOf('cleared').id, 'settled');
  assert.equal(laneOf('blocked').id, 'blocked');
  assert.equal(laneOf('blocked').group, null);
});

test('a lane announces both of its columns, in flow order', () => {
  assert.equal(laneLabel(laneOf('backlog')), 'Backlog / This week');
  assert.equal(laneLabel(laneOf('verified')), 'Verified / Cleared');
  assert.equal(laneLabel(laneOf('submitted')), 'Submitted');
});

test('tab-header drop ids are namespaced but resolve to the same column as the body', () => {
  assert.equal(tabDropId('cleared'), 'tab:cleared');
  assert.equal(columnFromDropId('tab:cleared'), 'cleared');
  assert.equal(columnFromDropId('cleared'), 'cleared');
  assert.equal(columnFromDropId('tab:nonsense'), null);
  assert.equal(columnFromDropId('flagged'), null);
  assert.ok(isTabDropId(tabDropId('backlog')));
  assert.equal(isTabDropId('backlog'), false);
});

// -------------------------------------------------- contract item 2: dim

test('a lane is NOT dimmed when only this_week refuses — Backlog still takes the card', () => {
  const plan = laneOf('backlog');
  const refusalFor = (c: BoardColumn) =>
    c === 'this_week' ? 'This week’s commitments are set in the Monday briefing, not on the board.' : null;
  assert.equal(laneDimRefusal(plan, 'backlog', refusalFor), null);
  // …and still not dimmed while This week is the ACTIVE tab: the lane can
  // accept the drop on its Backlog tab header without switching first.
  assert.equal(laneDimRefusal(plan, 'this_week', refusalFor), null);
});

test('a lane IS dimmed only when every tab refuses, and it speaks the active tab’s sentence', () => {
  const plan = laneOf('backlog');
  const refusalFor = (c: BoardColumn) => (c === 'backlog' ? 'Your account is read-only.' : 'Briefing only.');
  assert.equal(laneDimRefusal(plan, 'backlog', refusalFor), 'Your account is read-only.');
  assert.equal(laneDimRefusal(plan, 'this_week', refusalFor), 'Briefing only.');
});

test('a single-column lane dims exactly as it did before grouping', () => {
  const blocked = laneOf('blocked');
  assert.equal(laneDimRefusal(blocked, 'blocked', () => null), null);
  assert.equal(laneDimRefusal(blocked, 'blocked', () => 'This task is already blocked.'), 'This task is already blocked.');
});

// --------------------------------------- contract items 4 and 5: hiding

test('a match in the hidden tab is reported, with the tab that holds it', () => {
  const settled = laneOf('verified');
  assert.deepEqual(matchesElsewhere(settled, 'verified', counts({ cleared: 3 })), {
    column: 'cleared',
    count: 3,
  });
  assert.equal(matchesElsewhereLabel({ column: 'cleared', count: 3 }, true), '3 matches in Cleared');
  assert.equal(matchesElsewhereLabel({ column: 'cleared', count: 1 }, true), '1 match in Cleared');
  // Unfiltered, the same affordance is about work existing, not searching.
  assert.equal(matchesElsewhereLabel({ column: 'this_week', count: 4 }, false), '4 tasks in This week');
  assert.equal(matchesElsewhereLabel({ column: 'this_week', count: 1 }, false), '1 task in This week');
});

test('no affordance when the active tab has its own matches — it would point away from the answer', () => {
  const settled = laneOf('verified');
  assert.equal(matchesElsewhere(settled, 'verified', counts({ verified: 1, cleared: 9 })), null);
});

test('no affordance when both tabs are empty, and none for a lane with no sibling', () => {
  assert.equal(matchesElsewhere(laneOf('verified'), 'verified', counts()), null);
  assert.equal(matchesElsewhere(laneOf('submitted'), 'submitted', counts()), null);
});

test('the count chip discloses what the filter is hiding, and stays quiet when it hides nothing', () => {
  assert.equal(countChipTitle(3, 12), '3 of 12 match the current filter');
  assert.equal(countChipTitle(0, 4), '0 of 4 match the current filter');
  assert.equal(countChipTitle(4, 4), null);
  assert.equal(countChipTitle(0, 0), null);
});

test('a lane’s point total is the active tab’s own total, unpriced cards counting as nothing', () => {
  assert.equal(
    columnPoints([
      { points_override: null, catalog_points: 8 },
      { points_override: 3, catalog_points: 8 },
      { points_override: null, catalog_points: null },
    ]),
    11
  );
  assert.equal(columnPoints([]), 0);
});

// ------------------------------------------------ contract item 6: state

test('stored tab state is validated — junk, wrong column, wrong type all fall back to the first tab', () => {
  assert.deepEqual(readStoredTabs(null), DEFAULT_ACTIVE_TABS);
  assert.deepEqual(readStoredTabs('not json'), DEFAULT_ACTIVE_TABS);
  assert.deepEqual(readStoredTabs('"a string"'), DEFAULT_ACTIVE_TABS);
  assert.deepEqual(readStoredTabs('null'), DEFAULT_ACTIVE_TABS);
  // A real column, but not one of THIS group's tabs.
  assert.deepEqual(readStoredTabs('{"plan":"cleared"}'), DEFAULT_ACTIVE_TABS);
  assert.deepEqual(readStoredTabs('{"settled":42}'), DEFAULT_ACTIVE_TABS);
  // One good half survives on its own.
  assert.deepEqual(readStoredTabs('{"plan":"this_week"}'), { plan: 'this_week', settled: 'verified' });
  assert.deepEqual(readStoredTabs(serializeTabs({ plan: 'this_week', settled: 'cleared' })), {
    plan: 'this_week',
    settled: 'cleared',
  });
});

test('activeTabOf ignores stored state for a single-column lane and repairs it for a tabbed one', () => {
  const bad = { plan: 'submitted', settled: 'cleared' } as unknown as ActiveTabs;
  assert.equal(activeTabOf(laneOf('blocked'), bad), 'blocked');
  assert.equal(activeTabOf(laneOf('backlog'), bad), 'backlog');
  assert.equal(activeTabOf(laneOf('cleared'), bad), 'cleared');
});

// ------------------------------------------------ contract item 7: keys

test('arrow keys wrap, Home and End go to the ends, everything else is left alone', () => {
  assert.equal(nextTabIndex('ArrowRight', 0, 2), 1);
  assert.equal(nextTabIndex('ArrowRight', 1, 2), 0);
  assert.equal(nextTabIndex('ArrowLeft', 0, 2), 1);
  assert.equal(nextTabIndex('ArrowLeft', 1, 2), 0);
  assert.equal(nextTabIndex('Home', 1, 2), 0);
  assert.equal(nextTabIndex('End', 0, 2), 1);
  assert.equal(nextTabIndex('Enter', 0, 2), null);
  assert.equal(nextTabIndex('Tab', 0, 2), null);
  // Space must fall through: it is dnd-kit's pick-up key everywhere else
  // on this board, and the tablist has no business claiming it.
  assert.equal(nextTabIndex(' ', 0, 2), null);
});
