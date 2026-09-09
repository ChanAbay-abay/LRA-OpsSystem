/**
 * LRA Global Ops :: /queue — approvals
 *
 * PRD.md §6.4. GM sees `submitted`, founder sees `verified`, both
 * oldest-first with age in hours — "a GM who sits on verifications is
 * visible to everyone" is the point, so age is server-computed.
 * `clear` (the green button) exists on no other screen in the app
 * (DESIGN.md §5.1) and only renders here, only for the clearing founder.
 *
 * Flagged cancellations (`queueKind: 'cancellation_decision'`) share
 * this screen but never this screen's Verify/Clear button — Chan was
 * explicit that approving a cancellation and clearing points must never
 * be one ambiguous control, so they get their own row shape and their
 * own destructive-styled decision buttons.
 *
 * The "Clear" button and both cancellation-decision buttons are gated on
 * `me.isClearingFounder`, not `authority === 'founder'`. Multiple people
 * can hold `founder` authority (PLAN.md §0.4), but exactly one of them is
 * the seated clearing founder whose approval the database's own trigger
 * will actually accept (`core.is_clearing_founder()`) — a founder who
 * isn't that seat would otherwise see a live-looking button that always
 * 403s. GM's "Verify" is unaffected: verifying is any GM's job, not the
 * clearing seat's.
 */
import * as React from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { ReasonTextarea } from '@/components/ui/reason-textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';
import { FounderDigest } from '@/routes/founder-digest';

interface QueueTask {
  id: string;
  title: string;
  status: string;
  catalog_points: number | null;
  points_override: number | null;
  ageHours: number;
  queueKind: 'verify_or_clear' | 'cancellation_decision';
  pre_cancellation_status: string | null;
  cancellation_reason: string | null;
}

/**
 * Two audiences, one nav item.
 *
 * The GM's job here is unchanged: verify submitted work, one task at a
 * time, oldest first. The founder's job changed on 2026-09-09 — he wants
 * to monitor and approve in bulk, not walk a list — so a founder opening
 * /queue gets `FounderDigest` instead. Same route and same sidebar entry
 * on purpose: "Approvals" is where you go to approve, and giving the
 * founder a second approval-shaped screen to choose between would be a
 * worse outcome than either screen alone.
 *
 * `?view=list` escapes back to this list. The digest links cancellation
 * decisions there, because those are per-task decisions with their own
 * two-button shape that never belonged in a bulk checklist.
 */
export function QueuePage() {
  const { me } = useAuth();
  const isFounder = me?.authority === 'founder' || me?.authority === 'admin';
  const wantsList = new URLSearchParams(useLocation().search).get('view') === 'list';
  if (isFounder && !wantsList) return <FounderDigest />;
  return <QueueList />;
}

function QueueList() {
  const { me } = useAuth();
  const resource = useResource((signal) => api.get<QueueTask[]>('/api/points/queue', { signal }), []);
  const [rejecting, setRejecting] = React.useState<QueueTask | null>(null);
  const [decidingCancellation, setDecidingCancellation] = React.useState<QueueTask | null>(null);

  const nextAction = me?.authority === 'founder' || me?.authority === 'admin' ? 'cleared' : 'verified';
  const canClear = me?.isClearingFounder ?? false;
  // Only the "Clear" step and cancellation decisions are the clearing
  // founder's own seat (PLAN.md §2.5 item 6 / core.is_clearing_founder());
  // "Verify" is any GM's job and is unaffected.
  const clearDisabled = nextAction === 'cleared' && !canClear;
  const clearDisabledReason = 'Only the clearing founder can approve this.';
  const refuseDisabledReason = 'Only the clearing founder can refuse this.';

  async function approve(task: QueueTask) {
    try {
      await api.post(`/api/tasks/${task.id}/status`, { to: nextAction });
      resource.reload();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Refused');
    }
  }

  async function approveCancellation(task: QueueTask) {
    try {
      await api.post(`/api/tasks/${task.id}/status`, { to: 'cancelled' });
      resource.reload();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Refused');
    }
  }

  return (
    <div>
      <PageHeader title="Approvals" description="Oldest first. Age is measured from the server clock, not the browser's." />
      <ResourceView
        resource={resource}
        skeleton={<SkeletonRows rows={4} height={52} />}
        empty={<p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">Nothing waiting on you.</p>}
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <div className="rounded-xl border border-hairline bg-surface">
            {rows.map((t) =>
              t.queueKind === 'cancellation_decision' ? (
                <div key={t.id} className="flex items-center gap-4 border-b border-hairline bg-danger-wash/40 px-4 py-3 last:border-0">
                  <div className="flex-1">
                    <span className="text-body">{t.title}</span>
                    <p className="text-label text-danger">Flagged for cancellation — {t.cancellation_reason}</p>
                  </div>
                  <span className={`num text-num-xs ${t.ageHours >= 24 ? 'text-danger' : 'text-ink-3'}`}>{t.ageHours}h</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={!canClear}
                    title={!canClear ? clearDisabledReason : undefined}
                    onClick={() => approveCancellation(t)}
                  >
                    Approve cancellation
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!canClear}
                    title={!canClear ? refuseDisabledReason : undefined}
                    onClick={() => setDecidingCancellation(t)}
                  >
                    Refuse
                  </Button>
                </div>
              ) : (
                <div key={t.id} className="flex items-center gap-4 border-b border-hairline px-4 py-3 last:border-0">
                  <span className="flex-1 text-body">{t.title}</span>
                  <span className="num text-num-md text-ink-2">{t.points_override ?? t.catalog_points ?? '—'}</span>
                  <span className={`num text-num-xs ${t.ageHours >= 24 ? 'text-danger' : t.ageHours >= 8 ? 'text-pending' : 'text-ink-3'}`}>
                    {t.ageHours}h
                  </span>
                  <Button
                    variant={nextAction === 'cleared' ? 'clear' : 'primary'}
                    size="sm"
                    disabled={clearDisabled}
                    title={clearDisabled ? clearDisabledReason : undefined}
                    onClick={() => approve(t)}
                  >
                    {nextAction === 'cleared' ? 'Clear' : 'Verify'}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setRejecting(t)}>
                    Reject
                  </Button>
                </div>
              )
            )}
          </div>
        )}
      </ResourceView>

      {rejecting ? (
        <RejectDialog
          task={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => {
            setRejecting(null);
            resource.reload();
          }}
        />
      ) : null}

      {decidingCancellation ? (
        <RefuseCancellationDialog
          task={decidingCancellation}
          onClose={() => setDecidingCancellation(null)}
          onDone={() => {
            setDecidingCancellation(null);
            resource.reload();
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

// Refusing a flagged cancellation returns the task to whatever status
// it held before the flag (`pre_cancellation_status`) — the DB trigger
// enforces this is the ONLY legal non-approval target, so the client
// just has to send it back.
function RefuseCancellationDialog({ task, onClose, onDone }: { task: QueueTask; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/tasks/${task.id}/status`, { to: task.pre_cancellation_status ?? 'todo', reason });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not refuse the cancellation');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Refuse cancellation of "{task.title}"</DialogTitle>
        </DialogHeader>
        <p className="text-body-sm text-ink-3">The task returns to {task.pre_cancellation_status ?? 'its prior status'}.</p>
        <ReasonTextarea value={reason} onChange={setReason} placeholder="Why should this stay open?" />
        {error ? <p className="text-label text-danger">{error}</p> : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" loading={submitting} disabled={reason.trim().length < 10} onClick={submit}>
            Refuse cancellation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
