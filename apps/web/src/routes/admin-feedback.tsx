/**
 * LRA Global Ops :: /admin/feedback — Chan's inbox for suggestions and bugs
 *
 * Admin only, matching `core.feedback`'s own SELECT policy
 * (`core.is_admin()`, not `core.is_oversight()` — see
 * 20260911130000_core_feedback_channel.sql point 2: "sent to me", not
 * to oversight in general). Archive is a status flip, reversible;
 * delete is a real, permanent DELETE — the same "real delete offered
 * with its own confirmation" shape `/catalog` already uses, not a new
 * pattern.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { ListRow } from '@/components/ui/list-row';
import { Hint } from '@/components/ui/hint';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { api, ApiClientError } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtTime } from '@/lib/dates';
import { feedbackKindLabel, feedbackStatusLabel } from '@/lib/labels';
import { cn } from '@/lib/utils';

interface FeedbackRow {
  id: string;
  kind: 'suggestion' | 'bug';
  body: string;
  page: string;
  status: 'open' | 'archived';
  submitted_by_email: string;
  submitted_by_authority: string | null;
  created_at: string;
}

const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'archived', label: 'Archived' },
  { key: '', label: 'All' },
] as const;

function DeleteFeedbackDialog({
  row,
  onClose,
  onDone,
}: {
  row: FeedbackRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.delete(`/api/feedback/${row.id}`);
      toast.success('Deleted.');
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not delete this.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Permanently delete this {feedbackKindLabel(row.kind).toLowerCase()}?</DialogTitle>
        </DialogHeader>
        <p className="text-body-sm text-ink-3">
          This is a real, permanent delete — there is no undo and no archive to recover it from.
        </p>
        <p className="rounded-md border border-hairline bg-surface-2 p-2 text-body-sm text-ink-2">{row.body}</p>
        {error ? <p role="alert" className="text-label text-danger">{error}</p> : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" loading={submitting} onClick={submit}>
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdminFeedbackPage() {
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]['key']>('open');
  const [deleting, setDeleting] = React.useState<FeedbackRow | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const resource = useResource(
    (signal) => {
      const q = filter ? `?status=${filter}` : '';
      return api.get<FeedbackRow[]>(`/api/feedback${q}`, { signal });
    },
    [filter]
  );

  async function toggleStatus(row: FeedbackRow) {
    setBusyId(row.id);
    try {
      await api.patch(`/api/feedback/${row.id}`, { status: row.status === 'archived' ? 'open' : 'archived' });
      resource.reload();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not update this.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <PageHeader title="Feedback" description="Suggestions and bugs sent from the feedback button, on every screen." help="admin-feedback" />

      <div role="group" aria-label="Filter by status" className="mb-3 inline-flex items-center gap-0.5 rounded-md border border-hairline bg-surface-2 p-0.5">
        {FILTERS.map((f) => {
          const selected = f.key === filter;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={selected}
              onClick={() => setFilter(f.key)}
              className={cn(
                'h-[28px] rounded-sm px-2.5 text-label transition-[background-color,color] duration-press ease',
                selected ? 'bg-surface text-ink shadow-none' : 'text-ink-3 hover:bg-surface-3 hover:text-ink-2'
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <ResourceView
        resource={resource}
        skeleton={<SkeletonRows rows={5} height={56} />}
        empty={
          <p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">
            {filter === 'archived' ? 'Nothing archived yet.' : 'Nothing here yet — the team hasn’t sent anything.'}
          </p>
        }
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <div className="rounded-xl border border-hairline bg-surface">
            {rows.map((row) => (
              <div key={row.id} className="border-b border-hairline px-4 py-3 last:border-0">
                <ListRow
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          'shrink-0 rounded-xs px-1.5 py-0.5 text-eyebrow',
                          row.kind === 'bug' ? 'bg-danger-wash text-danger' : 'bg-info-wash text-info'
                        )}
                      >
                        {feedbackKindLabel(row.kind)}
                      </span>
                      <span className="min-w-0 truncate text-ink">{row.body}</span>
                    </span>
                  }
                  meta={[
                    { key: 'from', content: row.submitted_by_email, smWidth: 'sm:w-48' },
                    { key: 'page', content: row.page || '—', className: 'font-mono', smWidth: 'sm:w-24' },
                    { key: 'status', content: feedbackStatusLabel(row.status), smWidth: 'sm:w-16' },
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
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        title={row.status === 'archived' ? 'Reopen' : 'Archive'}
                        disabled={busyId === row.id}
                        onClick={() => toggleStatus(row)}
                      >
                        {row.status === 'archived' ? (
                          <ArchiveRestore className="size-4" aria-hidden />
                        ) : (
                          <Archive className="size-4" aria-hidden />
                        )}
                      </Button>
                      <Button variant="ghost" size="sm" title="Delete permanently" onClick={() => setDeleting(row)}>
                        <Trash2 className="size-4 text-danger" aria-hidden />
                      </Button>
                    </div>
                  }
                />
              </div>
            ))}
          </div>
        )}
      </ResourceView>

      {deleting ? (
        <DeleteFeedbackDialog
          row={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            resource.reload();
          }}
        />
      ) : null}
    </div>
  );
}
