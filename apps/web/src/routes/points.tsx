/**
 * LRA Global Ops :: /points — "my points"
 *
 * PRD.md §3.5 / DESIGN.md §6.2/§6.4: the three figures every member
 * sees always (cleared / waiting to clear / committed), and the
 * append-only ledger register beneath it. Settled value renders solid
 * ink; unsettled value never does (DESIGN.md §6.1) — the single rule
 * every point figure in this app obeys.
 */
import * as React from 'react';
import { PageHeader } from '@/components/layout/app-shell';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

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

export function PointsPage() {
  const balanceResource = useResource(() => api.get<Balance[]>('/api/points/me').then((rows) => rows[0] ?? null), []);
  const ledgerResource = useResource(() => api.get<LedgerRow[]>('/api/points/ledger'), []);
  const balance = balanceResource.data;
  const [oldestDays, setOldestDays] = React.useState<number | null>(null);

  // `Date.now()` was being called inline in the render body (defect #7)
  // -- React treats that as impure regardless of whether the result is
  // memoized, since a `useMemo` callback still runs during render.
  // Computing it here, in an effect that only re-runs when the fetched
  // timestamp actually changes, keeps the impure call out of render
  // entirely rather than just hiding it behind a memo.
  React.useEffect(() => {
    setOldestDays(
      balance?.oldest_pending_since
        ? Math.floor((Date.now() - new Date(balance.oldest_pending_since).getTime()) / 864e5)
        : null
    );
  }, [balance?.oldest_pending_since]);

  const pending = (balance?.pending_with_gm ?? 0) + (balance?.pending_with_founder ?? 0);

  return (
    <div>
      <PageHeader title="My points" description="Cleared, waiting to clear, and committed." />

      <ResourceView
        resource={balanceResource}
        skeleton={<div className="mb-6 h-[132px] animate-pulse rounded-xl bg-surface-2" />}
      >
        {() => (
          <div className="mb-6 grid grid-cols-1 gap-0 rounded-xl border border-hairline bg-surface p-5 sm:grid-cols-3">
            <div className="flex flex-col gap-1 sm:border-r sm:border-hairline sm:pr-5">
              <span className="text-eyebrow text-ink-3">Cleared this week</span>
              <span className="num text-[40px] font-medium leading-none text-ink">{balance?.cleared_points ?? 0}</span>
            </div>
            <div className="flex flex-col gap-1 rounded-lg bg-[#FCF3E3] p-3 sm:mx-5">
              <span className="text-eyebrow text-ink-3">Waiting to clear</span>
              <span className="num text-[40px] font-medium leading-none text-pending">{pending}</span>
              <span className="num text-num-sm text-ink-2">{balance?.pending_with_gm ?? 0} with GM</span>
              <span className="num text-num-sm text-ink-2">{balance?.pending_with_founder ?? 0} with Founder</span>
              {oldestDays != null ? (
                <span className={cn('num text-num-xs', oldestDays >= 4 ? 'text-danger' : oldestDays >= 2 ? 'text-pending' : 'text-ink-3')}>
                  oldest item waiting {oldestDays}d
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1 sm:pl-5">
              <span className="text-eyebrow text-ink-3">Committed</span>
              <span className="num text-[40px] font-medium leading-none text-ink-3">{balance?.committed_not_submitted ?? 0}</span>
              <span className="text-body-sm text-ink-3">tasks not yet submitted</span>
            </div>
          </div>
        )}
      </ResourceView>

      <h2 className="mb-2 text-subtitle text-ink">Ledger</h2>
      <ResourceView
        resource={ledgerResource}
        skeleton={<SkeletonRows rows={5} height={40} />}
        empty={<p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">Nothing in the ledger yet.</p>}
        isEmpty={(rows) => rows.length === 0}
      >
        {(ledger) => (
          <div className="rounded-xl border border-hairline bg-surface">
            {ledger.map((row) => (
              <div key={row.id} className="flex items-center gap-4 border-b border-hairline px-3 py-2 text-body-sm last:border-0">
                <span className="num text-num-xs w-32 shrink-0 text-ink-3">{new Date(row.created_at).toLocaleString()}</span>
                <span className="flex-1 truncate">
                  {row.from_status} → {row.to_status}
                  {row.reason ? <span className="ml-2 text-ink-3">— {row.reason}</span> : null}
                </span>
                <span className={cn('num text-num-sm shrink-0', row.state === 'cleared' ? 'text-cleared' : 'text-ink-3')}>
                  {row.state === 'cleared' ? `+${row.points}` : '—'}
                </span>
              </div>
            ))}
          </div>
        )}
      </ResourceView>
    </div>
  );
}
