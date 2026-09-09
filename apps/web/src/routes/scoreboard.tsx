/**
 * LRA Global Ops :: /scoreboard — the team scoreboard
 *
 * PRD.md §6.5, PLAN.md Phase 8: this week's capped score shown next to
 * the raw cleared total — labelled, per PLAN.md's explicit instruction,
 * so nobody discovers the recurring cap as a silent haircut — plus this
 * week's hit-rate and each person's reliability band. Rows link to
 * `/people/:id` for the full, hand-verifiable breakdown.
 *
 * `ops.settings.leaderboard_visibility` (OPEN-QUESTIONS.md #6) is
 * enforced server-side (`routes/scoreboard.ts`): a `staff` caller under
 * `oversight_only` gets back only their own row. This screen renders
 * whatever it receives and adds one banner explaining why the table is
 * short, rather than re-deriving the rule client-side.
 */
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { PageHeader } from '@/components/layout/app-shell';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { bandChipClass, BAND_LABEL, type ReliabilityBand } from '@/lib/reliability-ui';

interface ScoreboardRow {
  userId: string;
  name: string | null;
  position: string;
  currentWeek: {
    rawClearedPoints: number;
    cappedScore: number;
    cappedRecurringPoints: number;
    rawRecurringPoints: number;
  };
  // PLAN.md §10 #4: absent, not just falsy, for anyone who isn't
  // founder/admin — `apps/api/src/routes/scoreboard.ts` strips both
  // fields from the JSON before it leaves the server. Points, cleared
  // totals and velocity (`currentWeek` above) are unaffected — Chan's
  // explicit "staff keep those" instruction.
  lastClosedWeek?: { hitRate: number | null } | null;
  reliability?: { score: number | null; band: ReliabilityBand; ratedWeeks: number };
}

interface ScoreboardSummary {
  visibility: 'all' | 'oversight_only';
  weekId: string;
  weekStart: string;
  rows: ScoreboardRow[];
}

export function ScoreboardPage() {
  const { me } = useAuth();
  const resource = useResource((signal) => api.get<ScoreboardSummary>('/api/scoreboard', { signal }), []);
  const restricted = resource.data?.visibility === 'oversight_only' && me?.authority === 'staff';
  // PLAN.md §10 #4: founder + admin only, restated client-side purely to
  // pick a layout — the server has already dropped the fields for
  // everyone else, so this is never the thing standing between a GM/
  // staff caller and the numbers.
  const canSeeReliability = me?.authority === 'founder' || me?.authority === 'admin';
  const gridCols = canSeeReliability ? 'grid-cols-[1fr_auto_auto_auto]' : 'grid-cols-[1fr_auto]';

  return (
    <div>
      <PageHeader
        title="Scoreboard"
        description={
          canSeeReliability
            ? "This week's cleared points and each person's reliability."
            : "This week's cleared points."
        }
      />

      {restricted ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-hairline-strong bg-surface-2 px-3 py-2 text-body-sm text-ink-2">
          <Lock className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          Leaderboard visibility is set to oversight only. You can see your own numbers here.
        </div>
      ) : null}

      <ResourceView
        resource={resource}
        skeleton={<SkeletonRows rows={4} height={52} />}
        empty={<p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">No one on the roster yet.</p>}
        isEmpty={(s) => s.rows.length === 0}
      >
        {(summary) => (
          <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
            <div className={cn('grid items-center gap-4 border-b border-hairline bg-surface-2 px-4 py-2 text-eyebrow text-ink-2', gridCols)}>
              <span>Person</span>
              <span className={cn('num-col', canSeeReliability ? 'w-32' : 'w-40')}>This week</span>
              {canSeeReliability ? (
                <>
                  <span className="num-col w-24">Hit-rate</span>
                  <span className="num-col w-28">Reliability</span>
                </>
              ) : null}
            </div>
            {summary.rows.map((row) => (
              <Link
                key={row.userId}
                to={`/people/${row.userId}`}
                className={cn('grid items-center gap-4 border-b border-hairline px-4 py-3 last:border-0 hover:bg-[#FCFDFF] focus-visible:bg-[#FCFDFF]', gridCols)}
              >
                <span className="flex flex-col">
                  <span className="text-strong text-ink">{row.name ?? 'Unnamed'}</span>
                  <span className="text-body-sm capitalize text-ink-3">{row.position}</span>
                </span>

                {/* Points and velocity stay for everyone — Chan's own
                    reasoning (PLAN.md §10.2) is that the point system is
                    a self-tracking instrument, not only a management
                    readout. When reliability/hit-rate are hidden this
                    column just gets the room they would have used. */}
                <span className={cn('num-col', canSeeReliability ? 'w-32' : 'w-40')}>
                  <span className="num num-md text-ink">{row.currentWeek.cappedScore}</span>
                  <span className="num num-xs ml-1.5 text-ink-3">/ {row.currentWeek.rawClearedPoints} raw</span>
                </span>

                {canSeeReliability ? (
                  <>
                    <span className="num-col w-24 num num-sm text-ink-2">
                      {row.lastClosedWeek?.hitRate != null ? `${Math.round(row.lastClosedWeek.hitRate * 100)}%` : '—'}
                    </span>

                    <span className="num-col w-28">
                      {row.reliability?.score != null ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="num num-sm text-ink">{row.reliability.score}</span>
                          <span className={bandChipClass(row.reliability.band)}>{BAND_LABEL[row.reliability.band]}</span>
                        </span>
                      ) : (
                        <span className={cn(bandChipClass('unrated'))}>Unrated</span>
                      )}
                    </span>
                  </>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </ResourceView>
    </div>
  );
}
