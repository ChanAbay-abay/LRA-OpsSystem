/**
 * LRA Global Ops :: the founder's weekly digest
 *
 * Chan, 2026-09-09: "can we update it so the founder doesn't have to
 * approve everything? they can just get a summary of what tasks are in
 * progress, which ones are blocked and why, which ones have been
 * approved by the GM … the founder can bunch approve if everything
 * looks good. else they can just select which ones to approve/
 * disapprove … credits are still given after the founder approves tho."
 *
 * So this screen inverts /queue. The old one asked "which of these
 * eleven tasks will you act on?" — eleven decisions, one at a time, to
 * reach a conclusion the founder had usually already formed. This one
 * answers "is the week good?" first and makes acting on that answer a
 * single click, with the eleven still there for the times it isn't.
 *
 * Three deliberate choices:
 *
 *  1. **The summary is above the action, and reads as prose.** The
 *     founder's stated job is to monitor. He should be able to close the
 *     tab after the first two lines and know where the week stands.
 *
 *  2. **The action list is grouped by PERSON, not by task.** "Is
 *     Broker's week good?" is the question actually being asked;
 *     "is task #7 good?" is not. Group checkboxes make approving a
 *     person's whole week one click, which is the common case.
 *
 *  3. **Blocked work is separated from approvable work and carries its
 *     reason.** It is the one section that needs the founder to do
 *     something other than approve — unblocking is a management act, not
 *     a points act, so it never shares a checkbox with the clearing list.
 *
 * Nothing here weakens the ladder. Every approval is `POST
 * /api/tasks/bulk-status`, which issues one UPDATE per task on the
 * caller's own token; `ops.enforce_task_transition` fires per row exactly
 * as it does for a single click, and the ledger is still written only on
 * the clearing founder's approval. Bulk is a UI affordance over the same
 * eleven transitions, not a fast path around them.
 *
 * Gated on `me.isClearingFounder` for the same reason /queue is: several
 * people can hold `founder` authority, but only the seated clearing
 * founder's approval the database will accept. A GM or non-clearing
 * founder reading this screen gets the whole summary and no buttons,
 * which is honest — they can see the state, they just cannot bank it.
 */
import * as React from 'react';
import { AlertTriangle, Ban, CheckCircle2, ChevronRight, Clock, RotateCcw, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { ReasonTextarea } from '@/components/ui/reason-textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface DigestTask {
  id: string;
  title: string;
  status: string;
  owner_user_id: string;
  ownerName: string | null;
  ownerPosition: string | null;
  points: number;
  is_committed: boolean;
  carry_over_count: number;
  ageHours: number;
}

interface BlockedTask extends DigestTask {
  blockId: string;
  reason: string;
  blockingName: string | null;
  raisedByName: string | null;
  blockedHours: number;
}

interface Group {
  userId: string;
  ownerName: string | null;
  ownerPosition: string | null;
  count: number;
  points: number;
  oldestHours: number;
  tasks: DigestTask[];
}

interface Digest {
  summary: {
    awaitingCount: number;
    awaitingPoints: number;
    awaitingPeople: number;
    blockedCount: number;
    inProgressCount: number;
    inProgressPoints: number;
    withGmCount: number;
    rejectedCount: number;
    pendingCancellationCount: number;
    awaitingOverDayCount: number;
  };
  groups: Group[];
  blocked: BlockedTask[];
  inProgress: DigestTask[];
  withGm: DigestTask[];
  rejected: DigestTask[];
  pendingCancellation: (DigestTask & { reason: string | null })[];
}

function initials(name: string | null) {
  return (name ?? '?').slice(0, 2).toUpperCase();
}

/** Age colour is the same everywhere on this screen: 24h is the SLA the queue already advertises. */
function ageTone(hours: number) {
  return hours >= 24 ? 'text-danger' : hours >= 8 ? 'text-pending' : 'text-ink-3';
}

/**
 * A plain checkbox, styled.
 *
 * Deliberately not a new Radix dependency. The one accessibility gap a
 * native checkbox has here is the indeterminate state, which has no
 * attribute — it is a DOM property — so it is set through a ref.
 */
function Check({
  checked,
  indeterminate,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate) && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="size-4 shrink-0 cursor-pointer accent-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

/** The four numbers the founder reads before deciding whether to read anything else. */
function StatTile({
  value,
  label,
  tone,
  icon: Icon,
}: {
  value: React.ReactNode;
  label: string;
  tone?: 'brand' | 'blocked' | 'pending' | 'neutral';
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-hairline bg-surface px-4 py-3">
      <span className="flex items-center gap-1.5 text-eyebrow text-ink-3">
        {Icon ? <Icon className="size-3" aria-hidden /> : null}
        {label}
      </span>
      <span
        className={cn(
          'num text-num-lg',
          tone === 'brand' && 'text-brand-700',
          tone === 'blocked' && 'text-blocked',
          tone === 'pending' && 'text-pending',
          (!tone || tone === 'neutral') && 'text-ink'
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** A collapsed section — present in the summary, expandable when the founder does want the detail. */
function Fold({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  if (!count) return null;
  return (
    <div className="rounded-xl border border-hairline bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        <ChevronRight className={cn('size-4 text-ink-3 transition-transform duration-fast', open && 'rotate-90')} aria-hidden />
        <span className="text-strong text-ink">{title}</span>
        <span className="num text-num-xs rounded bg-surface-3 px-1.5 py-0.5 text-ink-3">{count}</span>
      </button>
      {open ? <div className="border-t border-hairline">{children}</div> : null}
    </div>
  );
}

function TaskRow({ task, trailing }: { task: DigestTask; trailing?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-hairline px-4 py-2.5 last:border-0">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-navy-800 text-micro text-white">
        {initials(task.ownerName)}
      </span>
      <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{task.title}</span>
      {task.carry_over_count > 0 ? (
        <span className="num inline-flex shrink-0 items-center gap-1 text-num-xs text-ink-3" title={`Carried over ${task.carry_over_count} week(s)`}>
          <RotateCcw className="size-3" aria-hidden />
          {task.carry_over_count}w
        </span>
      ) : null}
      <span className="num shrink-0 text-num-sm text-ink-2">{task.points || '—'}</span>
      <span className={cn('num w-10 shrink-0 text-right text-num-xs', ageTone(task.ageHours))}>{task.ageHours}h</span>
      {trailing}
    </div>
  );
}

export function FounderDigest() {
  const { me } = useAuth();
  const resource = useResource((signal) => api.get<Digest>('/api/points/digest', { signal }), []);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [working, setWorking] = React.useState(false);
  const [sendingBack, setSendingBack] = React.useState(false);

  // `me.isClearingFounder` is already false for ERC/DCA (read-only
  // founders are never the seated clearing founder — see
  // OPEN-QUESTIONS.md #5), so the whole bulk-approve/send-back/flagging
  // action surface below is already absent for them via this one flag.
  // No separate `readOnly` check is needed on this screen; if that ever
  // changes (a read-only clearing founder), gate on `!me?.readOnly` too.
  const canClear = me?.isClearingFounder ?? false;

  const digest = resource.status === 'ready' ? resource.data : null;
  const allIds = React.useMemo(
    () => (digest ? digest.groups.flatMap((g) => g.tasks.map((t) => t.id)) : []),
    [digest]
  );

  // A reload can retire tasks that were ticked (someone else cleared one,
  // a block landed). Dropping ids the server no longer offers keeps the
  // action bar's count honest — otherwise it would advertise "Approve 11"
  // over a list of nine.
  React.useEffect(() => {
    setSelected((prev) => {
      const live = new Set(allIds);
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [allIds]);

  const selectedTasks = React.useMemo(
    () => (digest ? digest.groups.flatMap((g) => g.tasks).filter((t) => selected.has(t.id)) : []),
    [digest, selected]
  );
  const selectedPoints = selectedTasks.reduce((n, t) => n + t.points, 0);

  function toggle(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });
  }

  /**
   * `payload` carries the two request shapes the API accepts: a shared
   * `reason` covering every selected task, or explicit `items` each with
   * its own. Approving needs neither, so it passes nothing.
   */
  async function bulk(
    to: 'cleared' | 'rejected',
    payload?: { reason: string } | { items: { id: string; reason: string }[] }
  ) {
    const ids = selectedTasks.map((t) => t.id);
    if (!ids.length) return;
    setWorking(true);
    try {
      const body =
        payload && 'items' in payload ? { items: payload.items, to } : { ids, to, ...(payload ?? {}) };
      const res = await api.post<{ changed: unknown[]; refused: { id: string; message: string }[] }>(
        '/api/tasks/bulk-status',
        body
      );
      const done = res.changed.length;
      const refused = res.refused;
      const verb = to === 'cleared' ? 'approved' : 'sent back';

      if (done && !refused.length) {
        toast.success(`${done} task${done === 1 ? '' : 's'} ${verb}.`);
      } else if (done && refused.length) {
        // Partial success is the contract (Chan's decision): the good
        // rows land, the refused ones stay on screen with the database's
        // own sentence, and the founder is told both halves rather than
        // being shown a green tick over a silent failure.
        toast.warning(`${done} ${verb}, ${refused.length} refused — ${refused[0].message}`);
      } else {
        toast.error(refused[0]?.message ?? `Nothing could be ${verb}.`);
      }
      setSelected(new Set(refused.map((r) => r.id)));
      resource.reload();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : `Could not ${to === 'cleared' ? 'approve' : 'send back'}`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 pb-24">
      <PageHeader
        title="This week"
        description="What your team is doing, what is stuck, and what is waiting on you. Points are banked when you approve."
      />

      <ResourceView resource={resource} skeleton={<SkeletonRows rows={5} height={64} />}>
        {(d) => (
          <div className="flex flex-col gap-4">
            {/* The two-line answer. Everything below this is detail the
                founder opens only if this line makes him want to. */}
            <p className="text-subtitle text-ink">
              {d.summary.awaitingCount === 0 && d.summary.blockedCount === 0 ? (
                <>
                  Nothing is waiting on you and nothing is blocked.{' '}
                  <span className="text-ink-3">{d.summary.inProgressCount} task(s) still in progress.</span>
                </>
              ) : (
                <>
                  {d.summary.awaitingCount > 0 ? (
                    <>
                      <span className="num">{d.summary.awaitingCount}</span> task
                      {d.summary.awaitingCount === 1 ? '' : 's'} worth{' '}
                      <span className="num">{d.summary.awaitingPoints}</span> points, from{' '}
                      <span className="num">{d.summary.awaitingPeople}</span>{' '}
                      {d.summary.awaitingPeople === 1 ? 'person' : 'people'}, are approved by the GM and waiting on you.
                    </>
                  ) : (
                    'Nothing is waiting on your approval.'
                  )}{' '}
                  {d.summary.blockedCount > 0 ? (
                    <span className="text-blocked">
                      <span className="num">{d.summary.blockedCount}</span>{' '}
                      {/* "others" only has an antecedent when there IS a pile
                          waiting on him; with nothing awaiting it reads as
                          "2 others" than nothing. */}
                      {d.summary.awaitingCount > 0 ? 'other' : 'task'}
                      {d.summary.blockedCount === 1 ? '' : 's'} {d.summary.blockedCount === 1 ? 'is' : 'are'} blocked.
                    </span>
                  ) : null}
                </>
              )}
            </p>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label="Waiting on you" value={`${d.summary.awaitingCount} · ${d.summary.awaitingPoints} pts`} tone="brand" icon={CheckCircle2} />
              <StatTile label="Blocked" value={d.summary.blockedCount} tone={d.summary.blockedCount ? 'blocked' : 'neutral'} icon={Ban} />
              <StatTile label="In progress" value={`${d.summary.inProgressCount} · ${d.summary.inProgressPoints} pts`} icon={Clock} />
              <StatTile label="With the GM" value={d.summary.withGmCount} tone={d.summary.withGmCount ? 'pending' : 'neutral'} />
            </div>

            {d.summary.awaitingOverDayCount > 0 ? (
              <p className="flex items-center gap-2 rounded-lg border border-pending-border bg-pending-wash px-3 py-2 text-body-sm text-pending">
                <AlertTriangle className="size-4 shrink-0" aria-hidden />
                <span className="num">{d.summary.awaitingOverDayCount}</span> of these have been waiting on you for over
                24 hours.
              </p>
            ) : null}

            {/* ---- The action surface ---- */}
            <section className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-strong text-ink">Approved by the GM, waiting on you</h2>
                {d.groups.length && canClear ? (
                  <label className="flex cursor-pointer items-center gap-2 text-body-sm text-ink-2">
                    <Check
                      checked={selected.size > 0 && selected.size === allIds.length}
                      indeterminate={selected.size > 0}
                      onChange={(on) => toggle(allIds, on)}
                      label="Select every task waiting on you"
                    />
                    Select all
                  </label>
                ) : null}
              </div>

              {!canClear ? (
                <p className="rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-body-sm text-ink-3">
                  You can see everything here, but only the clearing founder can bank the points.
                </p>
              ) : null}

              {!d.groups.length ? (
                <p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">
                  Nothing is waiting on your approval.
                </p>
              ) : (
                d.groups.map((g) => {
                  const ids = g.tasks.map((t) => t.id);
                  const on = ids.filter((id) => selected.has(id)).length;
                  return (
                    <div key={g.userId} className="overflow-hidden rounded-xl border border-hairline bg-surface">
                      <div className="flex items-center gap-3 border-b border-hairline bg-surface-2 px-4 py-2.5">
                        {canClear ? (
                          <Check
                            checked={on === ids.length}
                            indeterminate={on > 0}
                            onChange={(v) => toggle(ids, v)}
                            label={`Select all of ${g.ownerName ?? 'this person'}'s tasks`}
                          />
                        ) : null}
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-navy-800 text-micro text-white">
                          {initials(g.ownerName)}
                        </span>
                        <span className="text-strong text-ink">{g.ownerName ?? 'Unknown'}</span>
                        <span className="text-micro text-ink-3">{g.ownerPosition ?? ''}</span>
                        <span className="ml-auto num text-num-sm text-ink-2">
                          {g.count} · {g.points} pts
                        </span>
                        <span className={cn('num w-10 text-right text-num-xs', ageTone(g.oldestHours))}>{g.oldestHours}h</span>
                      </div>
                      {g.tasks.map((t) => (
                        <div key={t.id} className="flex items-center gap-3 border-b border-hairline pl-4 last:border-0">
                          {canClear ? (
                            <Check
                              checked={selected.has(t.id)}
                              onChange={(v) => toggle([t.id], v)}
                              label={`Select "${t.title}"`}
                            />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <TaskRow task={t} />
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })
              )}
            </section>

            {/* ---- Blocked: the section that needs a person, not points ---- */}
            {d.blocked.length ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-strong text-ink">Blocked — these need someone, not points</h2>
                <div className="overflow-hidden rounded-xl border border-blocked-border bg-surface">
                  {d.blocked.map((b) => (
                    <div key={b.blockId} className="flex items-start gap-3 border-b border-hairline px-4 py-3 last:border-0">
                      <Ban className="mt-0.5 size-4 shrink-0 text-blocked" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-body-sm text-ink">{b.title}</p>
                        <p className="text-body-sm text-ink-2">{b.reason}</p>
                        <p className="text-micro text-ink-3">
                          {b.ownerName ?? 'Unknown'}
                          {b.blockingName ? ` · waiting on ${b.blockingName}` : ''}
                          {b.raisedByName ? ` · raised by ${b.raisedByName}` : ''}
                        </p>
                      </div>
                      <span className={cn('num shrink-0 text-num-xs', ageTone(b.blockedHours))}>{b.blockedHours}h</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {d.pendingCancellation.length ? (
              <section className="flex flex-col gap-2">
                <h2 className="text-strong text-ink">Flagged for cancellation — your decision</h2>
                <div className="overflow-hidden rounded-xl border border-pending-border bg-surface">
                  {d.pendingCancellation.map((t) => (
                    <div key={t.id} className="flex items-center gap-3 border-b border-hairline px-4 py-3 last:border-0">
                      <div className="min-w-0 flex-1">
                        <p className="text-body-sm text-ink">{t.title}</p>
                        <p className="text-micro text-ink-3">{t.reason ?? '—'}</p>
                      </div>
                      <a className="text-body-sm text-brand-700 underline-offset-2 hover:underline" href="/queue?view=list">
                        Decide
                      </a>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <Fold title="In progress" count={d.inProgress.length}>
              {d.inProgress.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </Fold>

            <Fold title="With the GM, not yet verified" count={d.withGm.length}>
              {d.withGm.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </Fold>

            <Fold title="Sent back for rework" count={d.rejected.length}>
              {d.rejected.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </Fold>
          </div>
        )}
      </ResourceView>

      {/* The action bar only exists once something is ticked, so the
          screen reads as a summary by default and becomes a decision
          surface only when the founder has made it one. */}
      {canClear && selectedTasks.length > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-hairline bg-surface/95 px-4 py-3 backdrop-blur md:left-[240px]">
          <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-3">
            <span className="text-body-sm text-ink-2">
              <span className="num text-num-md text-ink">{selectedTasks.length}</span> selected ·{' '}
              <span className="num text-num-md text-ink">{selectedPoints}</span> pts
            </span>
            <Button variant="secondary" size="sm" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
            <span className="flex-1" />
            <Button variant="secondary" size="sm" disabled={working} onClick={() => setSendingBack(true)}>
              <Undo2 className="size-3.5" aria-hidden />
              Send back
            </Button>
            <Button variant="clear" loading={working} onClick={() => bulk('cleared')}>
              <CheckCircle2 className="size-4" aria-hidden />
              Approve {selectedTasks.length} · {selectedPoints} pts
            </Button>
          </div>
        </div>
      ) : null}

      {sendingBack ? (
        <SendBackDialog
          tasks={selectedTasks}
          onClose={() => setSendingBack(false)}
          onSubmit={async (payload) => {
            setSendingBack(false);
            await bulk('rejected', payload);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Sending work back — the destructive half of this screen, since it
 * costs someone their week's credit. So it confirms, and every reason
 * clears the same 10-character bar the database itself enforces on
 * `rejected_reason`.
 *
 * Chan, 2026-09-09: "allow option for batch or individual depending if
 * more than one was selected." Both are legitimate, and which one is
 * honest depends on what the founder actually found:
 *
 *  - **One reason for all.** The batch failed for a single reason —
 *    "none of these have the BOC reference attached". Writing that
 *    sentence once is the truth; retyping it eleven times is ceremony.
 *  - **A reason for each.** They are wrong in different ways. Forcing a
 *    shared reason here would put a sentence on the record that is wrong
 *    for most of the tasks carrying it, and the worklog is append-only —
 *    a bad reason written today cannot be quietly corrected later.
 *
 * The choice only appears when there is something to choose: with one
 * task selected there is exactly one reason and no mode switch. Switching
 * modes preserves what has already been typed in both directions (the
 * shared text seeds empty per-task boxes, and is not lost when you switch
 * back), because discovering halfway through that one task needs its own
 * note should not cost the founder the paragraph he just wrote.
 */
function SendBackDialog({
  tasks,
  onClose,
  onSubmit,
}: {
  tasks: DigestTask[];
  onClose: () => void;
  onSubmit: (payload: { reason: string } | { items: { id: string; reason: string }[] }) => Promise<void>;
}) {
  const count = tasks.length;
  const [mode, setMode] = React.useState<'shared' | 'individual'>('shared');
  const [reason, setReason] = React.useState('');
  const [each, setEach] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);

  const valid = (v: string | undefined) => (v ?? '').trim().length >= 10;
  const individualReady = tasks.every((t) => valid(each[t.id]));
  const ready = mode === 'shared' || count === 1 ? valid(reason) : individualReady;
  const remaining = tasks.filter((t) => !valid(each[t.id])).length;

  function switchTo(next: 'shared' | 'individual') {
    // Seed the per-task boxes from the shared reason, so choosing
    // "a reason for each" is an edit of what you wrote, not a blank page.
    if (next === 'individual') {
      setEach((prev) => {
        const seeded = { ...prev };
        for (const t of tasks) if (!seeded[t.id]) seeded[t.id] = reason;
        return seeded;
      });
    }
    setMode(next);
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] w-[min(620px,92vw)] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Send {count} task{count === 1 ? '' : 's'} back
          </DialogTitle>
        </DialogHeader>
        <p className="text-body-sm text-ink-2">
          {count === 1 ? 'This task returns' : 'These tasks return'} to the owner for rework and{' '}
          {count === 1 ? 'earns' : 'earn'} no points. The reason is written to the record and{' '}
          {count === 1 ? 'the owner sees it' : 'every owner sees it'}.
        </p>

        {count > 1 ? (
          <div
            role="radiogroup"
            aria-label="How to write the reason"
            className="flex gap-1 rounded-md border border-hairline bg-surface-2 p-1"
          >
            {(
              [
                ['shared', 'One reason for all', `All ${count} get the same note`],
                ['individual', 'A reason for each', 'They are wrong in different ways'],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                title={hint}
                onClick={() => switchTo(value)}
                className={cn(
                  'flex-1 rounded-sm px-3 py-1.5 text-body-sm transition-colors duration-fast',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
                  mode === value ? 'bg-surface text-ink shadow-pop' : 'text-ink-3 hover:text-ink-2'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {mode === 'shared' || count === 1 ? (
          <ReasonTextarea value={reason} onChange={setReason} placeholder="What is wrong with this work?" />
        ) : (
          <div className="flex flex-col gap-3">
            {tasks.map((t) => (
              <div key={t.id} className="rounded-lg border border-hairline bg-surface p-3">
                <p className="mb-1 flex items-center gap-2 text-body-sm text-ink">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-navy-800 text-micro text-white">
                    {initials(t.ownerName)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="num shrink-0 text-num-xs text-ink-3">{t.points} pts</span>
                </p>
                <ReasonTextarea
                  value={each[t.id] ?? ''}
                  onChange={(v) => setEach((prev) => ({ ...prev, [t.id]: v }))}
                  placeholder={`Why is "${t.title}" being sent back?`}
                />
              </div>
            ))}
            {remaining > 0 ? (
              <p className="text-micro text-ink-3">
                <span className="num">{remaining}</span> still {remaining === 1 ? 'needs' : 'need'} a reason of at least
                10 characters.
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={submitting}
            disabled={!ready}
            onClick={async () => {
              setSubmitting(true);
              await onSubmit(
                mode === 'individual' && count > 1
                  ? { items: tasks.map((t) => ({ id: t.id, reason: each[t.id] })) }
                  : { reason }
              );
              setSubmitting(false);
            }}
          >
            Send {count === 1 ? 'it' : `all ${count}`} back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
