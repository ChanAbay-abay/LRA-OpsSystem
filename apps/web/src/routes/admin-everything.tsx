/**
 * LRA Global Ops :: /admin/everything
 *
 * Cross-user visibility of tasks, ledger entries and open blocks —
 * "admin is his operating seat" (Chan, tonight). These reads already
 * pass through RLS unwidened: `ops.tasks`/`ops.point_ledger` grant
 * "any ops member reads everything" by design (PRD.md §6.1), and admin
 * is a member of every module, so this page needs no new policy.
 */
import * as React from 'react';
import { PageHeader } from '@/components/layout/app-shell';
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
  const [tasks, setTasks] = React.useState<Task[] | null>(null);
  const [ledger, setLedger] = React.useState<LedgerRow[] | null>(null);
  const [blocks, setBlocks] = React.useState<BlockRow[] | null>(null);

  React.useEffect(() => {
    api.get<Task[]>('/api/tasks').then(setTasks);
    api.get<LedgerRow[]>('/api/points/ledger').then(setLedger);
    api.get<BlockRow[]>('/api/blocks/open').then(setBlocks);
  }, []);

  return (
    <div>
      <PageHeader title="Everything" description="Every task, every ledger row, every open block — the full picture." />

      <h2 className="mb-2 text-subtitle text-ink">Open blocks ({blocks?.length ?? 0})</h2>
      <div className="mb-6 rounded-xl border border-hairline bg-surface">
        {blocks?.length ? (
          blocks.map((b) => (
            <div key={b.id} className="flex items-center gap-4 border-b border-hairline px-4 py-2 text-body-sm last:border-0">
              <span className="w-16 shrink-0 text-eyebrow text-ink-3">{b.target}</span>
              <span className="flex-1">{b.blocking_external ?? b.reason}</span>
              <span className="num text-num-xs text-ink-3">{new Date(b.created_at).toLocaleDateString()}</span>
            </div>
          ))
        ) : (
          <p className="p-4 text-body-sm text-ink-3">No open blocks.</p>
        )}
      </div>

      <h2 className="mb-2 text-subtitle text-ink">All tasks ({tasks?.length ?? 0})</h2>
      <div className="mb-6 rounded-xl border border-hairline bg-surface">
        {tasks?.map((t) => (
          <div key={t.id} className="flex items-center gap-4 border-b border-hairline px-4 py-2 text-body-sm last:border-0">
            <span className="flex-1 truncate">{t.title}</span>
            <span className="w-32 shrink-0 text-ink-3">{t.ownerName ?? t.owner_user_id}</span>
            <span className="w-24 shrink-0 text-eyebrow text-ink-3">{t.status}</span>
            <span className="num text-num-sm w-12 shrink-0 text-right">{t.points_awarded ?? t.catalog_points ?? '—'}</span>
          </div>
        ))}
      </div>

      <h2 className="mb-2 text-subtitle text-ink">Ledger ({ledger?.length ?? 0})</h2>
      <div className="rounded-xl border border-hairline bg-surface">
        {ledger?.slice(0, 100).map((l) => (
          <div key={l.id} className="flex items-center gap-4 border-b border-hairline px-4 py-2 text-body-sm last:border-0">
            <span className="num text-num-xs w-40 shrink-0 text-ink-3">{new Date(l.created_at).toLocaleString()}</span>
            <span className="flex-1 text-eyebrow text-ink-3">{l.to_status}</span>
            <span className="num text-num-sm">{l.to_status === 'cleared' ? `+${l.points}` : '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
