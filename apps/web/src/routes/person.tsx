/**
 * LRA Global Ops :: /people/:id — person profile
 *
 * PRD.md §6.5, PLAN.md Phase 8. PLAN.md's risk table is explicit —
 * "reliability is a management instrument with no visible failure
 * mode" — and its de-risk is "the inputs shown on the profile screen so
 * anyone can recompute it." That is this screen's real job: the
 * `weeklyBreakdown` table below the headline score is not decoration,
 * it is the entire audit trail, and every number in it is exactly what
 * `packages/ops-scoring`'s `reliability()` used to produce the score.
 *
 * The capped score sits next to the raw cleared total, both labelled
 * (PLAN.md's explicit instruction), and blocked time is shown as what
 * it is — an exoneration, not an excuse (PRD.md §5.2).
 *
 * A `staff` caller hitting someone else's id under
 * `leaderboard_visibility = 'oversight_only'` gets a 403 from the API;
 * `ResourceView`'s `error` state renders the server's own sentence
 * (DESIGN.md §8's rule, never a swallowed generic), which doubles as
 * this screen's permission-denied state.
 */
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { useParams } from 'react-router-dom';
import { PageHeader } from '@/components/layout/app-shell';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { bandChipClass, BAND_LABEL, type ReliabilityBand } from '@/lib/reliability-ui';

interface WeeklyContribution {
  weekId: string;
  weekStart: string;
  weight: number;
  committedPoints: number;
  clearedCommittedPoints: number;
  exoneratedPoints: number;
  effectiveDenominator: number;
  includedInRating: boolean;
}

interface PersonScoreboard {
  userId: string;
  name: string | null;
  position: string;
  authority: string | null;
  currentWeek: {
    weekStart: string;
    rawClearedPoints: number;
    newPoints: number;
    rawRecurringPoints: number;
    cappedRecurringPoints: number;
    cappedScore: number;
  };
  lastClosedWeek: {
    weekStart: string;
    committedPoints: number;
    clearedCommittedPoints: number;
    // PLAN.md §10 #4: absent, not null, for anyone who isn't
    // founder/admin — the server strips the key entirely.
    hitRate?: number | null;
    carryOverRate: number | null;
  } | null;
  reliability?: {
    score: number | null;
    band: ReliabilityBand;
    base: number;
    modifiers: { chronicCarryOver: number; staleness: number; blockingOthers: number; cleanSweep: number; total: number };
    ratedWeeks: number;
    weeklyBreakdown: WeeklyContribution[];
  };
  reliabilitySettings?: { windowWeeks: number; halfLifeWeeks: number; minWeeksForRating: number };
  hoursBlockedByThem: number;
  hoursTheyWereBlocked: number;
  // PLAN.md Phase 8 (cycle time): absent, not null, for anyone who isn't
  // founder/admin — same server-side strip as `reliability` above,
  // `apps/api/src/routes/scoreboard.ts`'s `stripReliability`.
  cycleTime?: { medianHours: number | null; sampleSize: number };
}

function pct(n: number | null): string {
  return n == null ? '—' : `${Math.round(n * 100)}%`;
}

/** `40.5h` under two days, `3.4d` at or beyond — matches how a person
 *  actually talks about how long something took. */
function formatCycleTime(hours: number): string {
  return hours < 48 ? `${hours.toFixed(1)}h` : `${(hours / 24).toFixed(1)}d`;
}

export function PersonPage() {
  const { id: userId } = useParams<{ id: string }>();
  const resource = useResource(
    (signal) => api.get<PersonScoreboard>(`/api/scoreboard/${userId}`, { signal }),
    [userId]
  );

  return (
    <div>
      <ResourceView resource={resource} skeleton={<SkeletonRows rows={6} height={40} />}>
        {(p) => {
          // PLAN.md §10 #4: `reliability` (and with it `hitRate`) is
          // simply absent from the JSON for anyone who isn't
          // founder/admin — `apps/api/src/routes/scoreboard.ts` strips
          // it server-side, this isn't a client-side hide. Every section
          // below that depends on it is skipped outright rather than
          // rendered empty or zeroed.
          const canSeeReliability = p.reliability != null;
          const sparkline = canSeeReliability
            ? [...p.reliability!.weeklyBreakdown]
                .reverse()
                .map((w) => ({
                  weekStart: w.weekStart,
                  hitRate: w.effectiveDenominator > 0 ? Math.round((w.clearedCommittedPoints / w.effectiveDenominator) * 100) : null,
                }))
            : [];

          return (
            <>
              <PageHeader
                title={p.name ?? 'Unnamed'}
                description={`${p.position.replace('_', ' ')} · week of ${p.currentWeek.weekStart}`}
              />

              {/*
                This week: raw cleared vs capped score, both labelled —
                PLAN.md's explicit instruction. Reliability is a third
                panel only for founder/admin; everyone else gets these
                two figures at full width rather than a panel with a
                hole in it — Chan's own reasoning (PLAN.md §10.2) is that
                points/velocity are what staff track themselves with, so
                that's what gets the room.
              */}
              <div className={cn('mb-6 grid grid-cols-1 gap-0 rounded-xl border border-hairline bg-surface p-5', canSeeReliability ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
                <div className="flex flex-col gap-1 sm:border-r sm:border-hairline sm:pr-5">
                  <span className="text-eyebrow text-ink-3">Raw cleared, this week</span>
                  <span className="num text-[40px] font-medium leading-none text-ink">{p.currentWeek.rawClearedPoints}</span>
                  <span className="text-body-sm text-ink-3">{p.currentWeek.newPoints} new + {p.currentWeek.rawRecurringPoints} recurring</span>
                </div>
                <div className={cn('flex flex-col gap-1 sm:px-5', !canSeeReliability && 'sm:border-0')}>
                  <span className="text-eyebrow text-ink-3">Capped score</span>
                  <span className="num text-[40px] font-medium leading-none text-ink">{p.currentWeek.cappedScore}</span>
                  <span className="text-body-sm text-ink-3">
                    recurring counted: {p.currentWeek.cappedRecurringPoints} of {p.currentWeek.rawRecurringPoints}
                  </span>
                </div>
                {canSeeReliability ? (
                  <div className="flex flex-col gap-1 sm:pl-5">
                    <span className="text-eyebrow text-ink-3">Reliability</span>
                    <span className="inline-flex items-center gap-2">
                      <span className="num text-[40px] font-medium leading-none text-ink">{p.reliability!.score ?? '—'}</span>
                      <span className={bandChipClass(p.reliability!.band)}>{BAND_LABEL[p.reliability!.band]}</span>
                    </span>
                    <span className="text-body-sm text-ink-3">
                      {p.reliability!.ratedWeeks} of {p.reliabilitySettings!.minWeeksForRating} weeks needed to rate
                    </span>
                  </div>
                ) : null}
              </div>

              {/* Sparkline — DESIGN.md §2.4: chart-1 line, draws once on mount, no dots except the latest point. */}
              {sparkline.length > 0 ? (
                <div className="mb-6 rounded-xl border border-hairline bg-surface p-5">
                  <h2 className="mb-3 text-subtitle text-ink">Hit-rate, last {sparkline.length} weeks</h2>
                  <div className="h-16 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={sparkline}>
                        <YAxis domain={[0, 100]} hide />
                        <Line
                          type="linear"
                          dataKey="hitRate"
                          stroke="var(--chart-1)"
                          strokeWidth={1.5}
                          dot={false}
                          activeDot={false}
                          connectNulls
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              ) : null}

              {/* Last closed week + blocked-time exoneration, side by side. */}
              <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-hairline bg-surface p-5">
                  <h2 className="mb-3 text-subtitle text-ink">Last closed week</h2>
                  {p.lastClosedWeek ? (
                    <dl className="grid grid-cols-2 gap-y-2 text-body-sm">
                      <dt className="text-ink-3">Committed</dt>
                      <dd className="num-col num text-ink">{p.lastClosedWeek.committedPoints}</dd>
                      <dt className="text-ink-3">Cleared</dt>
                      <dd className="num-col num text-ink">{p.lastClosedWeek.clearedCommittedPoints}</dd>
                      {canSeeReliability ? (
                        <>
                          <dt className="text-ink-3">Hit-rate</dt>
                          <dd className="num-col num text-ink">{pct(p.lastClosedWeek.hitRate ?? null)}</dd>
                        </>
                      ) : null}
                      <dt className="text-ink-3">Carry-over rate</dt>
                      <dd className="num-col num text-ink">{pct(p.lastClosedWeek.carryOverRate)}</dd>
                    </dl>
                  ) : (
                    <p className="text-body-sm text-ink-3">No closed week on file yet.</p>
                  )}
                </div>
                <div className="rounded-xl border border-hairline bg-surface p-5">
                  <h2 className="mb-3 text-subtitle text-ink">Blocked time</h2>
                  <dl className="grid grid-cols-2 gap-y-2 text-body-sm">
                    <dt className="text-ink-3">Blocked by them (others' work)</dt>
                    <dd className="num-col num text-ink">{p.hoursBlockedByThem}h</dd>
                    <dt className="text-ink-3">They were blocked (own work)</dt>
                    <dd className="num-col num text-ink">{p.hoursTheyWereBlocked}h</dd>
                  </dl>
                  <p className="mt-3 text-body-sm text-ink-3">
                    {canSeeReliability
                      ? 'A block declared before a week ends exonerates that commitment — it is excluded from the reliability ratio below, never counted as a miss.'
                      : 'A block declared before a week ends exonerates that commitment for the week it was raised in.'}
                  </p>
                </div>
              </div>

              {/* Median cycle time (PRD.md §4/§6.5). Founder/admin only, same gate
                  as reliability — the API strips the key entirely for anyone
                  else, so this section is skipped rather than rendered empty. */}
              {canSeeReliability ? (
                <div className="mb-6 rounded-xl border border-hairline bg-surface p-5">
                  <h2 className="mb-3 text-subtitle text-ink">Median cycle time</h2>
                  {p.cycleTime && p.cycleTime.sampleSize > 0 ? (
                    <>
                      <span className="num text-[40px] font-medium leading-none text-ink">
                        {formatCycleTime(p.cycleTime.medianHours as number)}
                      </span>
                      <p className="mt-2 text-body-sm text-ink-3">
                        Median of {p.cycleTime.sampleSize} cleared task{p.cycleTime.sampleSize === 1 ? '' : 's'} with a
                        recorded start. Cleared minus first moved to in progress, blocked time excluded.
                      </p>
                    </>
                  ) : (
                    <p className="text-body-sm text-ink-3">
                      No cycle-time data yet. This figure only counts tasks that first moved to “In progress” on or
                      after 2026-09-10 — earlier tasks have no recorded start, so nothing is guessed on their behalf.
                    </p>
                  )}
                </div>
              ) : null}

              {/* The audit trail — every number reliability() used, so the score is
                  hand-recomputable. Founder/admin only; for everyone else this
                  section, the sparkline above and the third summary panel above
                  that are simply not rendered — the underlying numbers aren't
                  in the payload to render from (PLAN.md §10 #4). */}
              {canSeeReliability ? (
                <div className="rounded-xl border border-hairline bg-surface">
                  <div className="border-b border-hairline p-5 pb-4">
                    <h2 className="text-subtitle text-ink">How this score was computed</h2>
                    <p className="mt-1 text-body-sm text-ink-3">
                      λ = 0.5^(1/{p.reliabilitySettings!.halfLifeWeeks}) per week of recency, most recent first. Base
                      ratio {(p.reliability!.base * 100).toFixed(2)}% → round(100 × base) = {Math.round(p.reliability!.base * 100)},
                      plus modifiers {p.reliability!.modifiers.total >= 0 ? '+' : ''}
                      {p.reliability!.modifiers.total} (carry-over {p.reliability!.modifiers.chronicCarryOver}, staleness{' '}
                      {p.reliability!.modifiers.staleness}, blocking others {p.reliability!.modifiers.blockingOthers}, clean
                      sweep +{p.reliability!.modifiers.cleanSweep}) = {p.reliability!.score ?? 'UNRATED'}.
                    </p>
                  </div>
                  {p.reliability!.weeklyBreakdown.length === 0 ? (
                    <p className="p-5 text-body-sm text-ink-3">No committed weeks in the reliability window yet.</p>
                  ) : (
                    <div className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_1fr_auto] items-center gap-4 border-b border-hairline bg-surface-2 px-5 py-2 text-eyebrow text-ink-2">
                      <span>Week</span>
                      <span className="num-col">Weight</span>
                      <span className="num-col">Committed</span>
                      <span className="num-col">Cleared</span>
                      <span className="num-col">Exonerated</span>
                      <span className="num-col">Denominator</span>
                      <span className="num-col">In ratio</span>
                    </div>
                  )}
                  {p.reliability!.weeklyBreakdown.map((w) => (
                    <div
                      key={w.weekId}
                      className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_1fr_auto] items-center gap-4 border-b border-hairline px-5 py-2 text-body-sm last:border-0"
                    >
                      <span className="num text-num-xs text-ink-3">{w.weekStart}</span>
                      <span className="num-col num text-num-sm text-ink-2">{w.weight.toFixed(3)}</span>
                      <span className="num-col num text-num-sm text-ink">{w.committedPoints}</span>
                      <span className="num-col num text-num-sm text-ink">{w.clearedCommittedPoints}</span>
                      <span className="num-col num text-num-sm text-ink-3">{w.exoneratedPoints || '—'}</span>
                      <span className="num-col num text-num-sm text-ink">{w.effectiveDenominator}</span>
                      <span className={cn('num-col text-label', w.includedInRating ? 'text-cleared' : 'text-ink-3')}>
                        {w.includedInRating ? 'yes' : 'no'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          );
        }}
      </ResourceView>
    </div>
  );
}
