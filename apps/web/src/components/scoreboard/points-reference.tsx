/**
 * LRA Global Ops :: the points reference — /scoreboard
 *
 * Chan: "those point valuations depending on what is described should
 * also show in the scoreboard page." The scoreboard already shows what
 * everyone earned; nothing on it explained why a task was worth what it
 * was. Today that answer only lives at `/catalog`, which is a table
 * built for pricing work, not for a person glancing at their own
 * velocity — PLAN.md §10.2's whole reason the point system exists for
 * staff at all ("track their own progress and stay accountable").
 *
 * `GET /api/catalog` already returns every task type to any ops member
 * (`apps/api/src/routes/catalog.ts` has no oversight gate on the GET),
 * so this reads it directly rather than growing `/api/scoreboard`'s
 * payload with data the scoreboard summary itself has no other use for.
 * It is its own `useResource` call with its own loading/error/empty
 * states, deliberately independent of the scoreboard summary's resource
 * — a slow or restricted scoreboard should never hide the one thing
 * that explains the numbers on it.
 *
 * Deliberately a glossary, not a second copy of `/catalog`'s table: one
 * mono point value per row (DESIGN.md §3.2 — a figure a person could
 * argue about), the names of the work that earns it as a wrapped run of
 * soft chips, and the catalog's own guideline note one `<Hint>` away
 * (§20.2) rather than printed in full — "a reference someone glances
 * at, not a table they study." A placeholder-priced type (§17/§22 —
 * `20260909180000_placeholder_points_and_admin_clearing.sql`'s starting
 * numbers) keeps the exact `--pending` "not yet settled" language the
 * balance panel and `/catalog` already use, so this screen never
 * presents a guess as the founder's real answer.
 */
import { Hint } from '@/components/ui/hint';
import { ResourceView } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { api } from '@/lib/api';
import {
  groupTypesByPoints,
  isPlaceholderPricing,
  stripPricingPrefix,
  type CatalogTaskType,
} from './points-reference-model';

export function PointsReference() {
  const resource = useResource((signal) => api.get<CatalogTaskType[]>('/api/catalog', { signal }), []);

  return (
    <div className="mt-6">
      <div className="mb-3">
        <h2 className="text-subtitle text-ink">What a point is worth</h2>
        <p className="text-body-sm text-ink-3">Active catalog work, grouped by the points it earns.</p>
      </div>

      <ResourceView
        resource={resource}
        skeleton={<PointsReferenceSkeleton />}
        empty={
          <p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">
            No task types are active yet.
          </p>
        }
        isEmpty={(rows) => rows.every((t) => !t.is_active)}
      >
        {(rows) => {
          const groups = groupTypesByPoints(rows);

          if (groups.length === 0) {
            return (
              <p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">
                Nothing has a real point value yet — every active type is still on placeholder pricing at /catalog.
              </p>
            );
          }

          return (
            <div className="max-h-[360px] overflow-y-auto rounded-xl border border-hairline bg-surface p-4">
              {groups.map((g) => (
                <div
                  key={g.points}
                  className="flex items-start gap-3 border-b border-hairline py-2.5 first:pt-0 last:border-0 last:pb-0"
                >
                  <span className="num w-6 shrink-0 pt-0.5 text-right text-num-md text-ink">{g.points}</span>
                  <div className="flex flex-1 flex-wrap gap-1.5">
                    {g.types.map((t) => {
                      const placeholder = isPlaceholderPricing(t);
                      return (
                        <Hint key={t.id} text={stripPricingPrefix(t.guideline_note)}>
                          <span
                            className={
                              placeholder
                                ? 'inline-flex h-5 items-center rounded-xs border border-pending-border bg-pending-wash px-[7px] text-label text-pending'
                                : 'inline-flex h-5 items-center rounded-xs border border-hairline-strong bg-surface-2 px-[7px] text-label text-ink-2'
                            }
                          >
                            {t.name}
                          </span>
                        </Hint>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          );
        }}
      </ResourceView>
    </div>
  );
}

/** Matches the real panel's geometry — DESIGN.md §8: a skeleton that is the wrong shape is a layout shift with extra steps. */
function PointsReferenceSkeleton() {
  return (
    <div aria-hidden className="rounded-xl border border-hairline bg-surface p-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-start gap-3 border-b border-hairline py-2.5 last:border-0">
          <div className="skeleton-pulse h-4 w-6 shrink-0 rounded-xs bg-surface-2" style={{ animationDelay: `${i * 80}ms` }} />
          <div className="flex flex-1 flex-wrap gap-1.5">
            {Array.from({ length: 3 - (i % 2) }).map((_, j) => (
              <div
                key={j}
                className="skeleton-pulse h-5 w-20 rounded-xs bg-surface-2"
                style={{ animationDelay: `${i * 80 + j * 40}ms` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
