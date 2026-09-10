/**
 * LRA Global Ops :: /admin/audit — the audit timeline
 *
 * `core.audit_logs` is append-only even to the service role (a BEFORE
 * trigger refuses UPDATE/DELETE outright) — this screen surfaces that
 * guarantee as text rather than leaving it as an implementation detail
 * nobody sees.
 *
 * It used to render `r.action` straight from the database
 * (`ops.task_edit_batch.withdrawn`) and a bare `toLocaleString()` — the
 * same defect class already fixed on `/points` (DESIGN.md §17, §22):
 * raw enum values and a browser-locale timestamp shown to a person who
 * does customs brokerage, not software. Every row now reads through
 * `lib/labels.ts` and `lib/dates.ts`, and `old_values`/`new_values` — the
 * whole reason this table is append-only — get a real before/after
 * panel instead of being fetched and thrown away.
 */
import * as React from 'react';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/layout/app-shell';
import { Input } from '@/components/ui/input';
import { ListRow } from '@/components/ui/list-row';
import { Hint } from '@/components/ui/hint';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtTime } from '@/lib/dates';
import { auditActionLabel, auditEntityTypeLabel, auditFieldLabel, authorityLabel, editRequestStatusLabel, taskStatusLabel } from '@/lib/labels';

interface AuditRow {
  id: string;
  actor_email: string | null;
  actor_authority: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  created_at: string;
}

// Internal bookkeeping, not a fact about what changed (see labels.ts's
// AUDIT_FIELD comment) — filtered out before a key ever reaches a label
// lookup, same principle as `<Hint>` never carrying information that
// doesn't exist elsewhere: this key doesn't exist FOR a reader at all.
const NOISE_KEYS = new Set(['stamps_not_derived']);

const EMPTY_VALUE = '—';

/**
 * `status` is the one key that is itself an enum value rather than free
 * text, and which enum it belongs to depends on which table the row is
 * about — `ops.task`'s status and an edit batch/request's status are
 * different unions that happen to share a column name. Everything else
 * in `old_values`/`new_values` is already a plain scalar (or, for the
 * edit-request rows, a nested diff object) with nothing further to
 * decode.
 */
function formatAuditValue(entityType: string, key: string, raw: unknown): string {
  if (raw === null || raw === undefined || raw === '') return EMPTY_VALUE;
  if (key === 'status') {
    if (entityType === 'ops.task') return taskStatusLabel(String(raw));
    if (entityType === 'ops.task_edit_batch' || entityType === 'ops.task_edit_request') {
      return editRequestStatusLabel(String(raw));
    }
  }
  if (typeof raw === 'object') return JSON.stringify(raw);
  return String(raw);
}

function AuditDiffPanel({ row }: { row: AuditRow }) {
  const keys = React.useMemo(() => {
    const union = new Set<string>([...Object.keys(row.old_values ?? {}), ...Object.keys(row.new_values ?? {})]);
    for (const k of NOISE_KEYS) union.delete(k);
    return Array.from(union);
  }, [row.old_values, row.new_values]);

  return (
    <div className="flex flex-col gap-2 border-t border-hairline bg-surface-2 px-4 py-3">
      {row.entity_id ? (
        <p className="text-micro text-ink-3">
          <span className="text-eyebrow">Record </span>
          <span className="font-mono">{row.entity_id}</span>
        </p>
      ) : null}
      {keys.length === 0 ? (
        <p className="text-body-sm text-ink-3">No field-level changes recorded on this row.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {keys.map((key) => {
            const before = formatAuditValue(row.entity_type, key, row.old_values?.[key]);
            const after = formatAuditValue(row.entity_type, key, row.new_values?.[key]);
            return (
              <div key={key} className="flex flex-wrap items-start gap-2 text-body-sm">
                <span className="w-[120px] shrink-0 pt-0.5 text-eyebrow text-ink-3">{auditFieldLabel(key)}</span>
                <span className="min-w-0 max-w-[320px] whitespace-pre-wrap break-words rounded bg-danger-wash px-1.5 py-0.5 text-ink-2 line-through decoration-danger/60">
                  {before}
                </span>
                <ArrowRight className="mt-1 size-3.5 shrink-0 text-ink-3" aria-hidden />
                <span className="min-w-0 max-w-[320px] whitespace-pre-wrap break-words rounded bg-cleared-wash px-1.5 py-0.5 text-ink">
                  {after}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AuditLogRow({ row }: { row: AuditRow }) {
  const [open, setOpen] = React.useState(false);
  const hasDetails = Boolean(row.entity_id) || Boolean(row.old_values && Object.keys(row.old_values).length) || Boolean(row.new_values && Object.keys(row.new_values).length);

  return (
    <div className="border-b border-hairline last:border-0">
      <ListRow
        className="px-4 py-2.5"
        title={
          <Hint text={row.action}>
            <span>{auditActionLabel(row.action)}</span>
          </Hint>
        }
        meta={[
          { key: 'actor', content: row.actor_email ?? 'System', smWidth: 'sm:w-44' },
          {
            key: 'authority',
            content: row.actor_authority ? authorityLabel(row.actor_authority) : EMPTY_VALUE,
            className: 'text-eyebrow',
            smWidth: 'sm:w-16',
          },
          { key: 'entity', content: auditEntityTypeLabel(row.entity_type), smWidth: 'sm:w-24' },
          {
            key: 'time',
            content: (
              <Hint text={fmtDateTime(row.created_at)}>
                <span className="num text-num-xs">
                  {fmtDate(row.created_at)}, {fmtTime(row.created_at)}
                </span>
              </Hint>
            ),
            smWidth: 'sm:w-40',
          },
        ]}
        actions={
          hasDetails ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="flex items-center gap-1 rounded-sm px-2 py-1 text-micro text-ink-3 hover:bg-surface-2 hover:text-ink-2"
            >
              {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
              {open ? 'Hide' : 'Details'}
            </button>
          ) : null
        }
      />
      {open && hasDetails ? <AuditDiffPanel row={row} /> : null}
    </div>
  );
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
        help="admin-audit"
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
              <AuditLogRow key={r.id} row={r} />
            ))}
          </div>
        )}
      </ResourceView>
    </div>
  );
}
