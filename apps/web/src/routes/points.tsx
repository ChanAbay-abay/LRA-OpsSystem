/**
 * LRA Global Ops :: /points — "my points"
 *
 * PRD.md §3.5 / DESIGN.md §6.2/§6.4: the three figures every member
 * sees always (cleared / waiting to clear / committed), and the
 * append-only ledger register beneath it. Settled value renders solid
 * ink; unsettled value never does (DESIGN.md §6.1) — the single rule
 * every point figure in this app obeys.
 *
 * Chan: "the date displays are pretty bland on the my points page."
 * DESIGN.md §22 rebuilt this screen's dates around one module
 * (`lib/dates.ts`, Manila-correct) and finally built the day-grouped
 * register §6.4 specified back in Part I and never shipped — newest
 * day first, a `text-eyebrow` heading per day with that day's net, and
 * a row that leads with the time instead of burying it in a 128px
 * locale-dependent block.
 */
import * as React from 'react';
import { PageHeader } from '@/components/layout/app-shell';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { ListRow } from '@/components/ui/list-row';
import { Hint } from '@/components/ui/hint';
import { useResource } from '@/lib/use-resource';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { taskStatusTransition } from '@/lib/labels';
import { formatDuration } from '@/lib/duration';
import { fmtDateTime, fmtTime, fmtDayHeading, manilaDayKey } from '@/lib/dates';

interface Balance {
  user_id: string;
  week_id: string;
  cleared_points: number;
  pending_with_gm: number;
  pending_with_founder: number;
  committed_not_submitted: number;
  oldest_pending_since: string | null;
}

interface LedgerRow {
  id: string;
  task_id: string;
  from_status: string;
  to_status: string;
  state: string;
  points: number;
  created_at: string;
  actor_id: string | null;
  reason: string | null;
}

/**
 * The chain-of-custody dots — DESIGN.md §6.3 — sized for a 36px ledger
 * row. Position on the three-step Submitted → Verified → Cleared ladder
 * comes straight from the ledger row's own `state` (the same
 * `ops.ledger_state` enum this row was written with), not from parsing
 * `to_status` again — the two agree by construction, so re-deriving one
 * from the other would only be a second place for them to drift.
 */
const CHAIN_STEPS = ['Submitted', 'Verified', 'Cleared'] as const;

function chainStepIndex(state: string): number {
  switch (state) {
    case 'submitted':
      return 0;
    case 'verified':
      return 1;
    case 'cleared':
      return 2;
    default:
      return -1; // rejected / cancelled — no step is "reached", the row IS the stop.
  }
}

function ChainDots({ state, fromStatus }: { state: string; fromStatus: string }) {
  const failed = state === 'rejected' || state === 'cancelled';
  const reachedIndex = chainStepIndex(state);
  // A rejection/cancellation happened AT the step the task was sitting
  // on when it bounced — that is `fromStatus` translated onto the same
  // three-step ladder (todo/in_progress both mean "hadn't reached
  // Submitted yet", so they fall before step 0).
  const failedAt = failed ? Math.max(0, chainStepIndex(fromStatus === 'todo' || fromStatus === 'in_progress' ? 'submitted' : fromStatus) ) : -1;

  const label = failed
    ? `${CHAIN_STEPS[Math.min(failedAt, 2)]}, then ${state === 'rejected' ? 'returned' : 'cancelled'}`
    : `${CHAIN_STEPS[reachedIndex] ?? 'Submitted'}`;

  return (
    <span className="flex items-center gap-1" role="img" aria-label={label}>
      {CHAIN_STEPS.map((_, i) => {
        const isFailedStep = failed && i === failedAt;
        const isPassed = !failed && i < reachedIndex;
        const isCurrent = !failed && i === reachedIndex;
        return (
          <span
            key={i}
            aria-hidden
            className={cn(
              'size-[6px] shrink-0 rounded-full border',
              isFailedStep && 'border-danger bg-danger',
              isPassed && 'border-cleared bg-cleared',
              isCurrent && 'border-pending bg-pending ring-2 ring-pending-wash',
              !isFailedStep && !isPassed && !isCurrent && 'border-hairline-strong bg-transparent'
            )}
          />
        );
      })}
    </span>
  );
}

/** The day's net — `+21` cleared, or an absence dash when nothing cleared that day (DESIGN.md §22.1). */
function DayNet({ rows }: { rows: LedgerRow[] }) {
  const net = rows.reduce((sum, r) => (r.state === 'cleared' ? sum + r.points : sum), 0);
  return net > 0 ? (
    <span className="num text-num-sm text-cleared">+{net}</span>
  ) : (
    <span className="num text-num-sm text-ink-3">—</span>
  );
}

/**
 * Newest-first ledger rows, grouped into Manila calendar days — a `Map`
 * rather than a plain object, so day keys like `2026-09-15` (which V8
 * would otherwise reorder as if they were array indices) keep the
 * server's own newest-first ordering.
 */
function groupByManilaDay(rows: LedgerRow[]): Map<string, LedgerRow[]> {
  const groups = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const key = manilaDayKey(row.created_at);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function LedgerRegister({ ledger }: { ledger: LedgerRow[] }) {
  const groups = React.useMemo(() => groupByManilaDay(ledger), [ledger]);

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
      {[...groups.entries()].map(([dayKey, rows]) => (
        <div key={dayKey}>
          <div className="sticky top-0 z-[1] flex h-7 items-center justify-between bg-surface-2 px-3 text-eyebrow text-ink-2">
            <span>{fmtDayHeading(rows[0].created_at)}</span>
            <DayNet rows={rows} />
          </div>
          {rows.map((row) => (
            <div key={row.id} className="border-b border-hairline px-3 py-1.5 last:border-0">
              <ListRow
                icon={<ChainDots state={row.state} fromStatus={row.from_status} />}
                title={
                  <>
                    {taskStatusTransition(row.from_status, row.to_status)}
                    {row.reason ? <span className="ml-2 text-ink-3">— {row.reason}</span> : null}
                  </>
                }
                meta={[
                  {
                    key: 'time',
                    smWidth: 'sm:w-12',
                    content: (
                      <Hint text={fmtDateTime(row.created_at)}>
                        <span className="num text-num-xs text-ink-3">{fmtTime(row.created_at)}</span>
                      </Hint>
                    ),
                  },
                ]}
                actions={
                  <span className={cn('num text-num-sm', row.state === 'cleared' ? 'text-cleared' : 'text-ink-3')}>
                    {row.state === 'cleared' ? `+${row.points}` : '—'}
                  </span>
                }
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PointsPage() {
  const { me } = useAuth();
  const balanceResource = useResource(
    (signal) => api.get<Balance[]>('/api/points/me', { signal }).then((rows) => rows[0] ?? null),
    []
  );
  // `?userId=` is REQUIRED here, not an optimisation.
  //
  // `GET /api/points/ledger` returns the WHOLE company's ledger when no
  // `userId` is given -- deliberately, because `/admin/everything` is its other
  // consumer and that screen's entire purpose is every row. Omitting it on a
  // screen titled "My points" rendered all 107 ledger rows for all four people,
  // unattributed and with no task titles, as if they were the reader's own
  // (reproduced 2026-09-10). Not an RLS hole -- any ops member may read the
  // ledger by design (PRD.md §6.1) -- but a person cannot audit their own
  // points against a list that is not theirs, which is the whole reason this
  // screen exists.
  //
  // Its sibling `/api/points/me` defaults to the caller, and that difference
  // between two endpoints in the same router is exactly what made this easy to
  // get wrong.
  const ledgerResource = useResource(
    (signal) =>
      me ? api.get<LedgerRow[]>(`/api/points/ledger?userId=${me.id}`, { signal }) : Promise.resolve([]),
    [me?.id]
  );
  const balance = balanceResource.data;
  const [oldestMs, setOldestMs] = React.useState<number | null>(null);

  // `Date.now()` was being called inline in the render body (defect #7)
  // -- React treats that as impure regardless of whether the result is
  // memoized, since a `useMemo` callback still runs during render.
  // Computing it here, in an effect that only re-runs when the fetched
  // timestamp actually changes, keeps the impure call out of render
  // entirely rather than just hiding it behind a memo.
  //
  // DESIGN.md §18.2's second bug on this screen: this used to floor to
  // whole DAYS (`Math.floor(ms / 864e5)`), so anything under 24h old
  // rendered "oldest item waiting 0d". The raw ms now goes straight to
  // `formatDuration` (§18.1) instead — the arithmetic is deleted, not
  // fixed, because `formatDuration` already owns every one of its
  // thresholds.
  React.useEffect(() => {
    setOldestMs(
      balance?.oldest_pending_since ? Date.now() - new Date(balance.oldest_pending_since).getTime() : null
    );
  }, [balance?.oldest_pending_since]);

  const pending = (balance?.pending_with_gm ?? 0) + (balance?.pending_with_founder ?? 0);

  return (
    <div>
      <PageHeader title="My points" description="Cleared, waiting to clear, and committed." help="points" />

      <ResourceView
        resource={balanceResource}
        skeleton={<div className="mb-6 h-[132px] animate-pulse rounded-xl bg-surface-2" />}
      >
        {() => (
          <div className="mb-6 grid grid-cols-1 gap-0 rounded-xl border border-hairline bg-surface p-5 sm:grid-cols-3">
            <div className="flex flex-col gap-1 sm:border-r sm:border-hairline sm:pr-5">
              <span className="text-eyebrow text-ink-3">Cleared this week</span>
              <span className="num text-num-lg font-medium leading-none text-ink sm:text-num-hero">
                {balance?.cleared_points ?? 0}
              </span>
            </div>
            <div className="flex flex-col gap-1 rounded-lg bg-pending-wash p-3 sm:mx-5">
              <span className="text-eyebrow text-ink-3">Waiting to clear</span>
              <span className="num text-num-lg font-medium leading-none text-pending sm:text-num-hero">{pending}</span>
              <span className="num text-num-sm text-ink-2">{balance?.pending_with_gm ?? 0} with GM</span>
              <span className="num text-num-sm text-ink-2">{balance?.pending_with_founder ?? 0} with Founder</span>
              {oldestMs != null ? (
                <Hint text={`Since ${fmtDateTime(balance!.oldest_pending_since!)}`}>
                  <span
                    className={cn(
                      'num text-num-xs',
                      oldestMs >= 4 * 86_400_000 ? 'text-danger' : oldestMs >= 2 * 86_400_000 ? 'text-pending' : 'text-ink-3'
                    )}
                  >
                    Oldest item waiting {formatDuration(oldestMs)}
                  </span>
                </Hint>
              ) : null}
            </div>
            <div className="flex flex-col gap-1 sm:pl-5">
              <span className="text-eyebrow text-ink-3">Committed</span>
              <span className="num text-num-lg font-medium leading-none text-ink-3 sm:text-num-hero">
                {balance?.committed_not_submitted ?? 0}
              </span>
              <span className="text-body-sm text-ink-3">tasks not yet submitted</span>
            </div>
          </div>
        )}
      </ResourceView>

      <h2 className="mb-2 text-subtitle text-ink">Ledger</h2>
      <ResourceView
        resource={ledgerResource}
        skeleton={<SkeletonRows rows={5} height={40} />}
        empty={
          <p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">
            Nothing in the ledger yet — it fills in the moment your first task is submitted.
          </p>
        }
        isEmpty={(rows) => rows.length === 0}
      >
        {(ledger) => <LedgerRegister ledger={ledger} />}
      </ResourceView>
    </div>
  );
}
