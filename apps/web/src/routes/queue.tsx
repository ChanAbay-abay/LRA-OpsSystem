/**
 * LRA Global Ops :: /queue — approvals
 *
 * PRD.md §6.4. GM sees `submitted`, founder sees `verified`, both
 * oldest-first with age in hours — "a GM who sits on verifications is
 * visible to everyone" is the point, so age is server-computed.
 * `clear` (the green button) exists on no other screen in the app
 * (DESIGN.md §5.1) and only renders here, only for the clearing founder.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { ReasonTextarea } from '@/components/ui/reason-textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';

interface QueueTask {
  id: string;
  title: string;
  status: string;
  catalog_points: number | null;
  points_override: number | null;
  ageHours: number;
}

export function QueuePage() {
  const { me } = useAuth();
  const [rows, setRows] = React.useState<QueueTask[] | null>(null);
  const [rejecting, setRejecting] = React.useState<QueueTask | null>(null);

  const load = React.useCallback(() => {
    api.get<QueueTask[]>('/api/points/queue').then(setRows).catch(() => toast.error('Could not load the queue'));
  }, []);
  React.useEffect(() => load(), [load]);

  const nextAction = me?.authority === 'founder' || me?.authority === 'admin' ? 'cleared' : 'verified';

  async function approve(task: QueueTask) {
    try {
      await api.post(`/api/tasks/${task.id}/status`, { to: nextAction });
      load();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Refused');
    }
  }

  return (
    <div>
      <PageHeader title="Approvals" description="Oldest first. Age is measured from the server clock, not the browser's." />
      <div className="rounded-xl border border-hairline bg-surface">
        {rows?.length ? (
          rows.map((t) => (
            <div key={t.id} className="flex items-center gap-4 border-b border-hairline px-4 py-3 last:border-0">
              <span className="flex-1 text-body">{t.title}</span>
              <span className="num text-num-md text-ink-2">{t.points_override ?? t.catalog_points ?? '—'}</span>
              <span className={`num text-num-xs ${t.ageHours >= 24 ? 'text-danger' : t.ageHours >= 8 ? 'text-pending' : 'text-ink-3'}`}>
                {t.ageHours}h
              </span>
              <Button variant={nextAction === 'cleared' ? 'clear' : 'primary'} size="sm" onClick={() => approve(t)}>
                {nextAction === 'cleared' ? 'Clear' : 'Verify'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setRejecting(t)}>
                Reject
              </Button>
            </div>
          ))
        ) : (
          <p className="p-4 text-body-sm text-ink-3">Nothing waiting on you.</p>
        )}
      </div>

      {rejecting ? (
        <RejectDialog
          task={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => {
            setRejecting(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function RejectDialog({ task, onClose, onDone }: { task: QueueTask; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/tasks/${task.id}/status`, { to: 'rejected', reason });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not reject');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject "{task.title}"</DialogTitle>
        </DialogHeader>
        <ReasonTextarea value={reason} onChange={setReason} placeholder="Why is this being sent back?" />
        {error ? <p className="text-label text-danger">{error}</p> : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" loading={submitting} disabled={reason.trim().length < 10} onClick={submit}>
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
