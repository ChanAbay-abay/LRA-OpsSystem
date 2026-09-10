/**
 * LRA Global Ops :: /scoreboard — the team scoreboard
 *
 * PRD.md §6.5, PLAN.md Phase 8 and §11.3.
 *
 * Chan, 2026-09-10: "make the scoreboard UI better and closer so the
 * data on the left is not too far from the right. also i dont see a
 * point in seeing the raw points. can we have a display as well of
 * points that are yet to be done, points pending and waiting approval,
 * and completed. then another one to have the points with total points
 * that they could have. should have record of this week, month, 3 month,
 * and overall. make each user a card that displays from left to right
 * making it a horizontal scroll."
 *
 * What that changed, and why:
 *
 * - The screen was a `grid-cols-[1fr_auto_auto_auto]` table: a name at
 *   the far left of a 1440px row, its numbers pinned to the far right,
 *   nothing in between. Every label now sits directly above its own
 *   value inside a 300–420px card (`components/scoreboard/person-card`),
 *   which is the actual answer to "not too far from the right" — a
 *   narrower gap on the same table would only have shortened the lake.
 * - `cappedScore / rawClearedPoints raw` on every row is gone. The
 *   recurring cap is NOT gone: PLAN.md §2.6 requires that it never land
 *   as a silent haircut, so it is disclosed per card, on the completed
 *   figure, in the one window where a weekly cap can honestly be applied
 *   — see `scoreboard-model.ts#capDisclosure`.
 * - The four buckets (to do / pending / completed / at risk against
 *   possible) come from one payload for all four windows, so the period
 *   control is instant and local. No refetch, no skeleton, no spinner.
 *
 * `ops.settings.leaderboard_visibility` (OPEN-QUESTIONS.md #6) is
 * enforced server-side (`routes/scoreboard.ts`): a `staff` caller under
 * `oversight_only` gets back only their own row. This screen renders
 * whatever it receives and adds one banner explaining why the rail is
 * short, rather than re-deriving the rule client-side — and one card in
 * the rail is a single ordinary panel, not a broken row.
 */
import * as React from 'react';
import { Lock } from 'lucide-react';
import { PageHeader } from '@/components/layout/app-shell';
import { ResourceView } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { CardRail, RailControls } from '@/components/scoreboard/card-rail';
import { useRail } from '@/components/scoreboard/use-rail';
import { PeriodTabs } from '@/components/scoreboard/period-tabs';
import { PersonCard, PersonCardSkeleton } from '@/components/scoreboard/person-card';
import { PointsReference } from '@/components/scoreboard/points-reference';
import {
  PERIOD_STORAGE_KEY,
  periodCaption,
  readStoredPeriod,
  type PeriodKey,
  type ScoreboardSummary,
} from '@/components/scoreboard/scoreboard-model';

export function ScoreboardPage() {
  const { me } = useAuth();
  const resource = useResource((signal) => api.get<ScoreboardSummary>('/api/scoreboard', { signal }), []);

  // Remembered for the session the same way the board remembers its
  // owner filter (`OWNER_FILTER_KEY`, routes/board.tsx) — same idiom,
  // same one-effect write, rather than a second persistence pattern.
  // `readStoredPeriod` validates it: localStorage can hold anything, and
  // an unrecognised key would index `periods` with `undefined`.
  const [period, setPeriod] = React.useState<PeriodKey>(() =>
    readStoredPeriod(localStorage.getItem(PERIOD_STORAGE_KEY))
  );
  React.useEffect(() => {
    localStorage.setItem(PERIOD_STORAGE_KEY, period);
  }, [period]);

  const rows = resource.data?.rows ?? [];
  const rail = useRail(`${resource.status}:${rows.length}`);

  const restricted = resource.data?.visibility === 'oversight_only' && me?.authority === 'staff';
  // PLAN.md §10 #4: founder + admin only, restated client-side purely to
  // pick a layout — the server has already dropped `reliability` and
  // `lastClosedWeek.hitRate` from the JSON for everyone else, so this is
  // never the thing standing between a GM/staff caller and the numbers.
  // Points and the four buckets are gated for nobody (PLAN.md §10.2).
  const canSeeReliability = me?.authority === 'founder' || me?.authority === 'admin';

  return (
    <div>
      <PageHeader
        title="Scoreboard"
        description={
          canSeeReliability
            ? 'Points completed, waiting to clear and still to do — and each person’s reliability.'
            : 'Points completed, waiting to clear and still to do.'
        }
        help="scoreboard"
      />

      {restricted ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-hairline-strong bg-surface-2 px-3 py-2 text-body-sm text-ink-2">
          <Lock className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          Leaderboard visibility is set to oversight only. You can see your own numbers here.
        </div>
      ) : null}

      <ResourceView
        resource={resource}
        skeleton={
          <>
            <div className="mb-3 flex items-center justify-between gap-3" aria-hidden>
              <div className="skeleton-pulse h-4 w-40 rounded-xs bg-surface-2" />
              <div className="skeleton-pulse h-[32px] w-[260px] rounded-md bg-surface-2" />
            </div>
            <div className="flex gap-4 overflow-hidden pb-3">
              {[0, 1, 2].map((i) => (
                <PersonCardSkeleton key={i} index={i} />
              ))}
            </div>
          </>
        }
        empty={
          <p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">
            No one on the roster yet.
          </p>
        }
        isEmpty={(s) => s.rows.length === 0}
      >
        {(summary) => (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              {/* The window is the same for every row, so the caption
                  reads it off the first one rather than being restated
                  per card. It uses the API's own label and says when
                  there is less history than the window claims. */}
              <p className="text-body-sm text-ink-3">{periodCaption(period, summary.rows[0].periods[period], summary.weekStart)}</p>
              <div className="flex items-center gap-2">
                <PeriodTabs value={period} onChange={setPeriod} />
                <RailControls state={rail.state} page={rail.page} />
              </div>
            </div>

            <CardRail railRef={rail.ref} label="Team scoreboard, one card per person">
              {summary.rows.map((row) => (
                <PersonCard key={row.userId} row={row} period={period} canSeeReliability={canSeeReliability} />
              ))}
            </CardRail>
          </>
        )}
      </ResourceView>

      {/* Its own resource, deliberately outside the ResourceView above —
          the catalog isn't part of the scoreboard summary and a slow or
          restricted leaderboard should never hide the one thing that
          explains the numbers on it. */}
      <PointsReference />
    </div>
  );
}
