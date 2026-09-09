/**
 * LRA Global Ops :: /admin/audit — the audit timeline
 *
 * `core.audit_logs` is append-only even to the service role (a BEFORE
 * trigger refuses UPDATE/DELETE outright) — this screen surfaces that
 * guarantee as text rather than leaving it as an implementation detail
 * nobody sees.
 */
import * as React from 'react';
import { PageHeader } from '@/components/layout/app-shell';
import { Input } from '@/components/ui/input';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { api } from '@/lib/api';

interface AuditRow {
  id: string;
  actor_email: string | null;
  actor_authority: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
}

export function AdminAuditPage() {
  const [entityType, setEntityType] = React.useState('');
  const resource = useResource(
    (signal) => {
      const q = entityType ? `?entityType=${encodeURIComponent(entityType)}` : '';
      return api.get<AuditRow[]>(`/api/admin/audit${q}`, { signal });
    },
    [entityType]
  );

  return (
    <div>
      <PageHeader
        title="Audit timeline"
        description="Append-only — no role, including service_role, can UPDATE or DELETE a row here. This is a read, not a report you can edit."
      />
      <div className="mb-3 max-w-xs">
        <Input placeholder="Filter by entity type (e.g. ops.task)" value={entityType} onChange={(e) => setEntityType(e.target.value)} />
      </div>
      <ResourceView
        resource={resource}
        skeleton={<SkeletonRows rows={6} height={40} />}
        empty={<p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">No audit rows match.</p>}
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <div className="rounded-xl border border-hairline bg-surface">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center gap-4 border-b border-hairline px-4 py-2 text-body-sm last:border-0">
                <span className="num text-num-xs w-40 shrink-0 text-ink-3">{new Date(r.created_at).toLocaleString()}</span>
                <span className="w-40 shrink-0 truncate">{r.actor_email ?? 'system'}</span>
                <span className="w-20 shrink-0 text-eyebrow text-ink-3">{r.actor_authority ?? '—'}</span>
                <span className="flex-1 truncate">{r.action}</span>
                <span className="w-32 shrink-0 truncate text-ink-3">{r.entity_type}</span>
              </div>
            ))}
          </div>
        )}
      </ResourceView>
    </div>
  );
}
