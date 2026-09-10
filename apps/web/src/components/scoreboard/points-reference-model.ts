/**
 * LRA Global Ops :: the points reference's pure model — /scoreboard
 *
 * Chan: "those point valuations depending on what is described should
 * also show in the scoreboard page." Split out for the same reason
 * `activity-heatmap-model.ts` was split from its component: oxlint's
 * `react(only-export-components)` fast-refresh rule wants a component
 * file to export only components, and grouping/placeholder logic is
 * more useful tested directly (`node --test`, no DOM) than exercised
 * through a render.
 *
 * `ops.task_types` (read via `GET /api/catalog`, `apps/api/src/routes/
 * catalog.ts`) is the one source of truth for what a point value means
 * — this file does not invent a second copy of the catalog, it only
 * reshapes the same rows the `/catalog` screen already renders into
 * "what earns an 8" instead of "what is X worth".
 */

const POINT_LADDER = [1, 2, 3, 5, 8, 13, 21] as const;

export type CatalogPoints = (typeof POINT_LADDER)[number];

/** Only the fields the reference actually reads off a catalog row. */
export interface CatalogTaskType {
  id: string;
  name: string;
  guideline_note: string;
  default_points: number | null;
  is_active: boolean;
}

export interface PointsGroup {
  points: CatalogPoints;
  types: CatalogTaskType[];
}

/**
 * `20260909180000_placeholder_points_and_admin_clearing.sql` gave every
 * seeded type a starting `default_points` so the trial doesn't score
 * zero, and marked every guideline note it wrote with a literal
 * `PLACEHOLDER —` / `DRAFT —` prefix to say the number is not the
 * founder's real answer yet.
 *
 * Both helpers now live in `lib/catalog-pricing.ts` and are re-exported
 * here so this module's own consumers are unchanged. They were duplicated
 * from `routes/catalog.tsx` — and the duplicate stripped only ONE marker,
 * while live data carries two (`PLACEHOLDER — DRAFT — …` on 14 of 15
 * active types). See that module for what the doubled marker was doing to
 * the catalog edit dialog.
 */
// Relative, not the `@/` alias: this module is loaded directly by
// node:test via tsx, which does not resolve the Vite path alias.
export { isPlaceholderPricing, stripPricingPrefix } from '../../lib/catalog-pricing';

/**
 * Groups active, priced catalog types by the point value they earn, in
 * ladder order, alphabetically within a group, and drops any point
 * value nothing currently earns. A retired type (`is_active = false`)
 * or an unpriced DRAFT (`default_points == null`) never appears here —
 * showing either would claim it still earns points, which is the one
 * thing Chan's own instruction says this reference cannot get wrong.
 */
export function groupTypesByPoints(types: CatalogTaskType[]): PointsGroup[] {
  const active = types.filter((t) => t.is_active && t.default_points != null);
  return POINT_LADDER.map((points) => ({
    points,
    types: active.filter((t) => t.default_points === points).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.types.length > 0);
}
