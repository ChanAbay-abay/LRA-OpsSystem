/**
 * LRA Global Ops :: /briefing — the Monday briefing
 *
 * PRD.md §6.2 / PLAN.md Phase 6. Run live on a shared display: last
 * week's scorecard, carry-overs, last week's blocks, then each person
 * commits to this week's targets. Closing the briefing calls
 * `POST /api/weeks/:id/briefing/close`, which moves the week
 * `planning -> open` and locks every commitment
 * (`ops.enforce_task_transition`'s commitment-lock guard) — the button
 * has its own confirm step because the lock is irreversible from this
 * screen, per PRD.md §6.2.
 *
 * Reliability (PRD.md §5) is Phase 8 and genuinely not built yet — the
 * scorecard below reports committed/cleared points and a hit-rate
 * computed straight from `ops.tasks`, and does not invent a
 * reliability number it has no formula for. Unpriced (`DRAFT`) catalog
 * types render `—`/0 throughout, never a guessed value, so this screen
 * works exactly as well before the founder prices the catalog as after.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Week {
  id: string;
  week_start: string;
  week_end: string;
  state: 'planning' | 'open' | 'closed';
  briefing_opened_at: string | null;
  briefing_closed_at: string | null;
}

interface ScorecardRow {
  userId: string;
  name: string | null;
  position: string;
  committedPoints: number;
  clearedCommittedPoints: number;
  clearedPoints: number;
  /** Absent unless the caller is founder/admin — the API strips it. */
  hitRate?: number | null;
}

interface CarryOver {
  id: string;
  title: string;
  ownerName: string | null;
  carryOverCount: number;
  status: string;
}

interface OpenBlock {
  id: string;
  task_id: string;
  reason: string;
  hoursOpen: number;
  blockingName: string | null;
}

interface CandidateTask {
  id: string;
  title: string;
  status: string;
  catalog_points: number | null;
  points_override: number | null;
  committed_points: number | null;
}

interface BriefingData {
  week: Week;
  previousWeek: Week | null;
  roster: Array<{ userId: string; name: string | null; position: string }>;
  scorecard: ScorecardRow[];
  carryOvers: CarryOver[];
  blocks: { open: OpenBlock[]; byBlocker: Array<{ label: string; hours: number }> };
  commitCandidates: Record<string, CandidateTask[]>;
  committed: Record<string, CandidateTask[]>;
}

export function BriefingPage() {
  const { me } = useAuth();
  const isOversight = me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin';
  // ERC / DCA sit on this shared-display screen with everyone else, so
  // the write controls stay visible-but-disabled rather than vanishing
  // (task-permissions.ts's rule: absence for a whole meaningless surface,
  // a reason for a control inside a screen they legitimately read).
  const readOnly = me?.readOnly ?? false;
  const readOnlyReason = 'Your account is read-only.';

  const weekResource = useResource((signal) => api.get<Week | null>('/api/weeks/current', { signal }), []);
  const week = weekResource.data;

  const briefingResource = useResource(
    (signal) => (week ? api.get<BriefingData>(`/api/briefing/${week.id}`, { signal }) : Promise.resolve(null)),
    [week?.id]
  );

  const [confirmingClose, setConfirmingClose] = React.useState(false);

  async function openTheWeek() {
    try {
      const created = await api.post<Week>('/api/weeks', {});
      await api.post(`/api/weeks/${created.id}/generate-recurring`);
      weekResource.reload();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not open the week');
    }
  }

  async function openBriefing() {
    if (!week) return;
    try {
      await api.post(`/api/weeks/${week.id}/briefing/open`);
      weekResource.reload();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not open the briefing');
    }
  }

  async function closeBriefing() {
    if (!week) return;
    try {
      await api.post(`/api/weeks/${week.id}/briefing/close`);
      setConfirmingClose(false);
      weekResource.reload();
      briefingResource.reload();
      toast.success('Commitments are locked for this week.');
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not close the briefing');
    }
  }

  async function commit(taskId: string) {
    try {
      await api.post(`/api/tasks/${taskId}/commit`);
      briefingResource.reload();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not commit this task');
    }
  }

  async function uncommit(taskId: string) {
    try {
      await api.delete(`/api/tasks/${taskId}/commit`);
      briefingResource.reload();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not uncommit this task');
    }
  }

  return (
    <div className="mx-auto max-w-briefing">
      <PageHeader
        title="Monday briefing"
        description={week ? `W${weekNumber(week.week_start)} · ${week.week_start} – ${week.week_end}` : undefined}
        actions={
          isOversight && week && week.state === 'planning' ? (
            <div className="flex gap-2">
              {!week.briefing_opened_at ? (
                <Button
                  variant="secondary"
                  onClick={openBriefing}
                  disabled={readOnly}
                  title={readOnly ? readOnlyReason : undefined}
                >
                  Open the briefing
                </Button>
              ) : null}
              <Button
                variant="destructive"
                onClick={() => setConfirmingClose(true)}
                disabled={readOnly}
                title={readOnly ? readOnlyReason : undefined}
              >
                Close the briefing
              </Button>
            </div>
          ) : undefined
        }
      />

      <ResourceView
        resource={weekResource}
        skeleton={<BriefingSkeleton />}
        empty={
          <div className="mx-auto max-w-[420px] rounded-xl border border-hairline bg-surface p-8 text-center">
            <p className="mb-3 text-body text-ink-2">This week hasn't been opened.</p>
            {isOversight ? (
              <Button onClick={openTheWeek} disabled={readOnly} title={readOnly ? readOnlyReason : undefined}>
                Open the week
              </Button>
            ) : null}
          </div>
        }
        isEmpty={(w) => !w}
      >
        {(w) =>
          w && w.state !== 'planning' ? (
            <div className="mb-4 rounded-lg border border-info-border bg-info-wash px-4 py-3 text-body-sm text-ink-2">
              This week's briefing is already closed. Commitments are locked; new tasks can still be created and worked mid-week.
            </div>
          ) : null
        }
      </ResourceView>

      {week ? (
        <ResourceView resource={briefingResource} skeleton={<BriefingSkeleton />}>
          {(data) =>
            data ? (
              <div className="flex flex-col gap-8">
                <ScorecardSection scorecard={data.scorecard} previousWeek={data.previousWeek} />
                <CarryOverSection carryOvers={data.carryOvers} />
                <BlocksSection blocks={data.blocks} />
                <CommitSection
                  roster={data.roster}
                  candidates={data.commitCandidates}
                  committed={data.committed}
                  locked={week.state !== 'planning'}
                  meId={me?.id}
                  isOversight={isOversight}
                  readOnly={readOnly}
                  onCommit={commit}
                  onUncommit={uncommit}
                />
              </div>
            ) : null
          }
        </ResourceView>
      ) : null}

      {confirmingClose ? (
        <Dialog open onOpenChange={(v) => !v && setConfirmingClose(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Close the briefing?</DialogTitle>
            </DialogHeader>
            <p className="text-body-sm text-ink-2">
              This locks every commitment for this week. It cannot be undone from this screen — reopening requires the
              founder. Tasks can still be created and worked mid-week; they just won't count as commitments.
            </p>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setConfirmingClose(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={closeBriefing}>
                Close and lock commitments
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * The briefing's own placeholder. Reproduced defect (Chan: "for the
 * founder account it doesn't load the briefing"): this screen needs TWO
 * chained requests — `/api/weeks/current`, then `/api/briefing/:id`
 * keyed off its answer — and while the first was in flight `week` was
 * `null`, so the entire body below the header rendered as literally
 * nothing for several seconds. On a cold load that reads as a broken
 * page, not a loading one. It was never founder-specific; the founder
 * is simply the account it was noticed on.
 *
 * The skeleton mirrors the four real sections so the page has its own
 * shape from the first paint and the data lands into it.
 */
function BriefingSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <span className="sr-only">Loading the briefing…</span>
      <section>
        <div className="skeleton-pulse mb-3 h-5 w-48 rounded-md bg-surface-2" aria-hidden />
        <SkeletonRows rows={4} height={40} />
      </section>
      <section>
        <div className="skeleton-pulse mb-3 h-5 w-32 rounded-md bg-surface-2" aria-hidden />
        <SkeletonRows rows={2} height={40} />
      </section>
      <section>
        <div className="skeleton-pulse mb-3 h-5 w-24 rounded-md bg-surface-2" aria-hidden />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="rounded-xl border border-hairline bg-surface p-4">
              <div className="skeleton-pulse mb-3 h-2.5 w-28 rounded-xs bg-surface-3" style={{ animationDelay: `${i * 90}ms` }} />
              <div className="skeleton-pulse mb-2 h-3 w-full rounded-xs bg-surface-2" style={{ animationDelay: `${i * 90 + 60}ms` }} />
              <div className="skeleton-pulse h-3 w-2/3 rounded-xs bg-surface-2" style={{ animationDelay: `${i * 90 + 120}ms` }} />
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="skeleton-pulse mb-3 h-5 w-20 rounded-md bg-surface-2" aria-hidden />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-xl border border-hairline bg-surface p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="skeleton-pulse h-3 w-24 rounded-xs bg-surface-2" style={{ animationDelay: `${i * 90}ms` }} />
                <div className="skeleton-pulse h-3 w-6 rounded-xs bg-surface-2" style={{ animationDelay: `${i * 90}ms` }} />
              </div>
              <div className="skeleton-pulse mb-2 h-2.5 w-20 rounded-xs bg-surface-3" style={{ animationDelay: `${i * 90 + 60}ms` }} />
              <div className="skeleton-pulse mb-3 h-3 w-full rounded-xs bg-surface-2" style={{ animationDelay: `${i * 90 + 120}ms` }} />
              <div className="skeleton-pulse mb-2 h-2.5 w-20 rounded-xs bg-surface-3" style={{ animationDelay: `${i * 90 + 60}ms` }} />
              <div className="skeleton-pulse h-3 w-4/5 rounded-xs bg-surface-2" style={{ animationDelay: `${i * 90 + 180}ms` }} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function weekNumber(weekStart: string): number {
  const d = new Date(weekStart);
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - start.getTime()) / 86400000 + start.getDay() + 1) / 7);
}

function ScorecardSection({ scorecard, previousWeek }: { scorecard: ScorecardRow[]; previousWeek: Week | null }) {
  // PLAN.md §10 #4: hit-rate is founder/admin only. The API already
  // strips it from the payload; this drops the column too, so the
  // standup table has no empty gap where the numbers used to be.
  const { me } = useAuth();
  const showHitRate = me?.authority === 'founder' || me?.authority === 'admin';
  return (
    <section>
      <h2 className="mb-3 text-title-lg text-ink">Last week's scorecard</h2>
      {!previousWeek ? (
        <p className="text-body-sm text-ink-3">There is no previous week yet — this is the first one.</p>
      ) : scorecard.length === 0 ? (
        <p className="text-body-sm text-ink-3">Nobody committed to anything last week.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
          <table className="w-full">
            <thead className="bg-surface-2">
              <tr className="h-8 text-eyebrow text-ink-2">
                <th className="px-3 text-left">Person</th>
                <th className="px-3 text-right">Committed</th>
                <th className="px-3 text-right">Cleared (committed)</th>
                {showHitRate ? <th className="px-3 text-right">Hit-rate</th> : null}
                <th className="px-3 text-right">Cleared this week</th>
              </tr>
            </thead>
            <tbody>
              {scorecard.map((row) => (
                <tr key={row.userId} className="h-9 border-t border-hairline text-body-sm">
                  <td className="px-3">
                    {row.name} <span className="text-eyebrow text-ink-3">{row.position}</span>
                  </td>
                  <td className="num num-sm px-3 text-right">{row.committedPoints}</td>
                  <td className="num num-sm px-3 text-right">{row.clearedCommittedPoints}</td>
                  {showHitRate ? (
                    <td className="num num-sm px-3 text-right">{row.hitRate == null ? '—' : `${Math.round(row.hitRate * 100)}%`}</td>
                  ) : null}
                  <td className="num num-sm px-3 text-right text-ink">{row.clearedPoints}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CarryOverSection({ carryOvers }: { carryOvers: CarryOver[] }) {
  return (
    <section>
      <h2 className="mb-3 text-title-lg text-ink">Carry-overs</h2>
      {carryOvers.length === 0 ? (
        <p className="text-body-sm text-ink-3">Nothing carried into this week. Clean sweep.</p>
      ) : (
        <div className="rounded-xl border border-hairline bg-surface">
          {carryOvers.map((c) => (
            <div key={c.id} className="flex items-center gap-4 border-b border-hairline px-4 py-2 text-body-sm last:border-0">
              <span className="flex-1 truncate">{c.title}</span>
              <span className="text-ink-3">{c.ownerName}</span>
              <span className={cn('num num-xs flex items-center gap-1', c.carryOverCount >= 3 ? 'text-danger' : 'text-ink-3')}>
                <RotateCcw className="size-3" aria-hidden /> {c.carryOverCount}w
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function BlocksSection({ blocks }: { blocks: { open: OpenBlock[]; byBlocker: Array<{ label: string; hours: number }> } }) {
  return (
    <section>
      <h2 className="mb-3 text-title-lg text-ink">Blocks</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-hairline bg-surface p-4">
          <p className="mb-2 text-eyebrow text-ink-3">Open now</p>
          {blocks.open.length === 0 ? (
            <p className="text-body-sm text-ink-3">Nothing currently blocked.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {blocks.open.map((b) => (
                <li key={b.id} className="text-body-sm">
                  <span className="text-ink">{b.blockingName ?? 'Unknown'}</span> — {b.reason}{' '}
                  <span className="num num-xs text-ink-3">({b.hoursOpen}h)</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-xl border border-hairline bg-surface p-4">
          <p className="mb-2 text-eyebrow text-ink-3">Hours blocked last week, by blocker</p>
          {blocks.byBlocker.length === 0 ? (
            <p className="text-body-sm text-ink-3">Nothing resolved last week.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {blocks.byBlocker.map((b) => (
                <li key={b.label} className="flex justify-between text-body-sm">
                  <span>{b.label}</span>
                  <span className="num num-sm text-ink">{Math.round(b.hours)}h</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function CommitSection({
  roster,
  candidates,
  committed,
  locked,
  meId,
  isOversight,
  readOnly,
  onCommit,
  onUncommit,
}: {
  roster: Array<{ userId: string; name: string | null; position: string }>;
  candidates: Record<string, CandidateTask[]>;
  committed: Record<string, CandidateTask[]>;
  locked: boolean;
  meId?: string;
  isOversight: boolean;
  readOnly: boolean;
  onCommit: (taskId: string) => void;
  onUncommit: (taskId: string) => void;
}) {
  const visibleRoster = roster.filter((r) => r.position !== 'other');

  return (
    <section>
      <h2 className="mb-3 text-title-lg text-ink">Commit</h2>
      {locked ? (
        <p className="mb-3 text-body-sm text-pending">Commitments are locked for this week.</p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {visibleRoster.map((person) => {
          // Read-only oversight (ERC/DCA) reads every card in this
          // grid, same as a real founder would -- it just never gets
          // the commit/uncommit affordance, on any row, including its
          // own (a read-only account has no `person_id` of its own to
          // match here anyway).
          const canAct = (isOversight || person.userId === meId) && !readOnly;
          const theirCommitted = committed[person.userId] ?? [];
          const theirCandidates = candidates[person.userId] ?? [];
          const total = theirCommitted.reduce((sum, t) => sum + (t.committed_points ?? 0), 0);
          return (
            <div key={person.userId} className="rounded-xl border border-hairline bg-surface p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-strong text-ink">{person.name}</p>
                <span className="num num-md text-ink-2">{total}</span>
              </div>
              <p className="mb-1 text-eyebrow text-ink-3">Committed</p>
              {theirCommitted.length === 0 ? (
                <p className="mb-3 text-body-sm text-ink-3">Nothing yet.</p>
              ) : (
                <ul className="mb-3 flex flex-col gap-1">
                  {theirCommitted.map((t) => (
                    <li key={t.id} className="flex items-center justify-between text-body-sm">
                      <span className="flex items-center gap-1.5 truncate">
                        <CheckCircle2 className="size-3.5 shrink-0 text-cleared" aria-hidden />
                        {t.title}
                      </span>
                      {!locked && canAct ? (
                        <button className="text-label text-ink-3 underline" onClick={() => onUncommit(t.id)}>
                          Uncommit
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mb-1 text-eyebrow text-ink-3">Candidates</p>
              {theirCandidates.length === 0 ? (
                <p className="text-body-sm text-ink-3">No uncommitted board/backlog tasks.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {theirCandidates.map((t) => (
                    <li key={t.id} className="flex items-center justify-between text-body-sm">
                      <span className="truncate">{t.title}</span>
                      {!locked && canAct ? (
                        <Button size="sm" variant="secondary" onClick={() => onCommit(t.id)}>
                          Commit
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
