/**
 * LRA Global Ops :: /admin/everything
 *
 * Cross-user visibility of tasks, ledger entries and open blocks —
 * "admin is his operating seat" (Chan, tonight). These reads already
 * pass through RLS unwidened: `ops.tasks`/`ops.point_ledger` grant
 * "any ops member reads everything" by design (PRD.md §6.1), and admin
 * is a member of every module, so this page needs no new policy.
 */
import { PageHeader } from '@/components/layout/app-shell';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { api } from '@/lib/api';

interface Task {
  id: string;
  title: string;
  status: string;
  owner_user_id: string;
  ownerName: string | null;
  points_awarded: number | null;
  catalog_points: number | null;
}

interface LedgerRow {
  id: string;
  task_id: string;
  to_status: string;
  points: number;
  created_at: string;
}

interface BlockRow {
  id: string;
  task_id: string;
  target: string;
  blocking_external: string | null;
  reason: string;
  created_at: string;
}

export function AdminEverythingPage() {
  const tasksResource = useResource((signal) => api.get<Task[]>('/api/tasks', { signal }), []);
  const ledgerResource = useResource((signal) => api.get<LedgerRow[]>('/api/points/ledger', { signal }), []);
  const blocksResource = useResource((signal) => api.get<BlockRow[]>('/api/blocks/open', { signal }), []);

  return (
    <div>
      <PageHeader title="Everything" description="Every task, every ledger row, every open block — the full picture." />

      <h2 className="mb-2 text-subtitle text-ink">Open blocks ({blocksResource.data?.length ?? 0})</h2>
      <div className="mb-6">
        <ResourceView
          resource={blocksResource}
          skeleton={<SkeletonRows rows={3} height={40} />}
          empty={<p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">No open blocks.</p>}
          isEmpty={(rows) => rows.length === 0}
        >
          {(blocks) => (
            <div className="rounded-xl border border-hairline bg-surface">
              {blocks.map((b) => (
                <div key={b.id} className="flex items-center gap-4 border-b border-hairline px-4 py-2 text-body-sm last:border-0">
                  <span className="w-16 shrink-0 text-eyebrow text-ink-3">{b.target}</span>
                  <span className="flex-1">{b.blocking_external ?? b.reason}</span>
                  <span className="num text-num-xs text-ink-3">{new Date(b.created_at).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </ResourceView>
      </div>

      <h2 className="mb-2 text-subtitle text-ink">All tasks ({tasksResource.data?.length ?? 0})</h2>
      <div className="mb-6">
        <ResourceView
          resource={tasksResource}
          skeleton={<SkeletonRows rows={5} height={40} />}
          empty={<p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">No tasks yet.</p>}
          isEmpty={(rows) => rows.length === 0}
        >
          {(tasks) => (
            <div className="rounded-xl border border-hairline bg-surface">
              {tasks.map((t) => (
                <div key={t.id} className="flex items-center gap-4 border-b border-hairline px-4 py-2 text-body-sm last:border-0">
                  <span className="flex-1 truncate">{t.title}</span>
                  <span className="w-32 shrink-0 text-ink-3">{t.ownerName ?? t.owner_user_id}</span>
                  <span className="w-24 shrink-0 text-eyebrow text-ink-3">{t.status}</span>
                  <span className="num text-num-sm w-12 shrink-0 text-right">{t.points_awarded ?? t.catalog_points ?? '—'}</span>
                </div>
              ))}
            </div>
          )}
        </ResourceView>
      </div>

      <h2 className="mb-2 text-subtitle text-ink">Ledger ({ledgerResource.data?.length ?? 0})</h2>
      <ResourceView
        resource={ledgerResource}
        skeleton={<SkeletonRows rows={5} height={40} />}
        empty={<p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">Nothing in the ledger yet.</p>}
        isEmpty={(rows) => rows.length === 0}
      >
        {(ledger) => (
          <div className="rounded-xl border border-hairline bg-surface">
            {ledger.slice(0, 100).map((l) => (
              <div key={l.id} className="flex items-center gap-4 border-b border-hairline px-4 py-2 text-body-sm last:border-0">
                <span className="num text-num-xs w-40 shrink-0 text-ink-3">{new Date(l.created_at).toLocaleString()}</span>
                <span className="flex-1 text-eyebrow text-ink-3">{l.to_status}</span>
                <span className="num text-num-sm">{l.to_status === 'cleared' ? `+${l.points}` : '—'}</span>
              </div>
            ))}
          </div>
        )}
      </ResourceView>
    </div>
  );
}
