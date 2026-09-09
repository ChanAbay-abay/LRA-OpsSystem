/**
 * LRA Global Ops :: `/` — Now, the real screen
 *
 * PLAN.md Phase 7. Replaces the Phase 1 placeholder (which only proved
 * auth + the roster) with what `GET /api/now` actually gives: one
 * person's whole picture in a single call — their own open work, which
 * of it is blocked and why, what is waiting on THEM to approve
 * (oversight only), and what was just handed to them. Polls every 20s
 * per PLAN.md §4/DESIGN.md §7.2 ("who's working now… changed values
 * crossfade, nothing moves") — the poll is a silent background refresh
 * of the same local `data` state the initial `useResource` load seeds,
 * exactly the pattern `routes/board.tsx`'s `load()` already uses, so a
 * dropped connection mid-poll never wipes what's on screen.
 *
 * Two contract details from the API agent, both binding on this view:
 *   - `newlyAssigned` has NO recency window — it is "assigned by
 *     someone else and not yet started," not "assigned recently." The
 *     label below says exactly that; it must never read "new this
 *     week" or similar, because that would be false.
 *   - `awaitingMyApproval` is oversight-only server-side (staff gets
 *     `[]`); the section itself is hidden entirely for staff, not
 *     rendered empty — the same "it should just stay blank" rule
 *     Chan gave for /queue and the board's cancellation banner.
 */
import * as React from 'react';
import { Ban, CheckCircle2, Inbox, UserPlus } from 'lucide-react';
import { PageHeader } from '@/components/layout/app-shell';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const POLL_MS = 20_000;

interface NowTask {
  id: string;
  title: string;
  status: string;
  ownerUserId: string;
  ownerName: string | null;
  ownerPosition: string | null;
  points: number;
  rejectedReason: string | null;
  lastActivityAt: string;
  createdAt: string;
}

interface BlockedTask extends NowTask {
  blockId: string;
  reason: string;
  target: string;
  blockingName: string | null;
  blockedSince: string;
}

interface NowData {
  myOpenTasks: NowTask[];
  blocked: BlockedTask[];
  awaitingMyApproval: NowTask[];
  newlyAssigned: NowTask[];
}

const STATUS_LABEL: Record<string, string> = {
  todo: 'Backlog',
  in_progress: 'In progress',
  submitted: 'Submitted',
  verified: 'Verified',
  rejected: 'Returned',
  pending_cancellation: 'Awaiting cancellation decision',
};

function statusTone(status: string): 'neutral' | 'pending' | 'danger' {
  if (status === 'submitted' || status === 'verified') return 'pending';
  if (status === 'rejected' || status === 'pending_cancellation') return 'danger';
  return 'neutral';
}

function StatusChip({ status }: { status: string }) {
  const tone = statusTone(status);
  const tones = {
    neutral: 'border-hairline bg-surface-2 text-ink-2',
    pending: 'border-pending-border bg-pending-wash text-pending',
    danger: 'border-danger-border bg-danger-wash text-danger',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex h-[20px] shrink-0 items-center whitespace-nowrap rounded-xs border px-2 text-micro font-medium leading-none',
        tones[tone]
      )}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** Hours/days since an ISO timestamp — DESIGN.md §3.2: mono, tabular. */
function age(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.max(0, Math.round(ms / 3_600_000));
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function TaskRow({ task, meta }: { task: NowTask; meta?: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-hairline px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-strong text-ink">{task.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <StatusChip status={task.status} />
          {task.ownerName ? (
            <span className="text-micro text-ink-3">
              {task.ownerName}
              {task.ownerPosition ? ` · ${task.ownerPosition}` : ''}
            </span>
          ) : null}
          {meta}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="num text-num-sm text-ink-3" title="Last activity">
          {age(task.lastActivityAt)}
        </span>
        <span className="num text-num-md text-ink-2">{task.points}</span>
      </div>
    </li>
  );
}

function SectionPanel({
  icon,
  title,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-surface p-5">
      <div className="mb-3 flex items-center gap-1.5 border-b border-hairline pb-3">
        {icon}
        <h2 className="text-subtitle text-ink">{title}</h2>
        <span className="num text-num-xs ml-auto rounded bg-surface-2 px-1.5 py-0.5 text-ink-3">{count}</span>
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-body-sm text-ink-3">{children}</p>;
}

export function NowPage() {
  const { me } = useAuth();
  const isOversight = me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin';

  const resource = useResource((signal) => api.get<NowData>('/api/now', { signal }), []);
  const [data, setData] = React.useState<NowData | null>(null);

  React.useEffect(() => {
    if (resource.status === 'ready' && resource.data) setData(resource.data);
  }, [resource.status, resource.data]);

  // Silent background poll (DESIGN.md §7.2: values crossfade, nothing
  // moves) — reuses the loaded `data` state rather than re-running
  // `useResource`'s loader, so a dropped poll never flashes the screen
  // back to a skeleton. Same shape as `routes/board.tsx`'s `load()`.
  React.useEffect(() => {
    if (resource.status !== 'ready') return;
    const timer = window.setInterval(() => {
      api
        .get<NowData>('/api/now')
        .then(setData)
        .catch(() => {
          // A missed poll is not an error worth interrupting someone
          // over — the next one 20s later will catch up. The initial
          // load already proved the API is reachable at all.
        });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [resource.status]);

  const approvalLabel =
    me?.authority === 'gm'
      ? 'Submitted, waiting on you to verify'
      : me?.authority === 'founder' || me?.authority === 'admin'
        ? 'Verified, waiting on you to clear'
        : '';

  return (
    <div>
      <PageHeader title="Now" description="What's on your plate right now. Refreshes automatically every 20 seconds." />

      <ResourceView resource={resource} skeleton={<SkeletonRows rows={4} height={64} />}>
        {() => {
          const now = data ?? resource.data!;
          return (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <SectionPanel
                icon={<Inbox className="size-4 text-ink-3" aria-hidden />}
                title="My open work"
                count={now.myOpenTasks.length}
              >
                {now.myOpenTasks.length === 0 ? (
                  <Empty>Nothing in progress. Pick up something from the board.</Empty>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {now.myOpenTasks.map((t) => (
                      <TaskRow key={t.id} task={t} />
                    ))}
                  </ul>
                )}
              </SectionPanel>

              <SectionPanel
                icon={<Ban className="size-4 text-blocked" aria-hidden />}
                title="Blocked"
                count={now.blocked.length}
              >
                {now.blocked.length === 0 ? (
                  <Empty>Nothing blocked. Nice.</Empty>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {now.blocked.map((b) => (
                      <TaskRow
                        key={b.id}
                        task={b}
                        meta={
                          <span className="text-micro text-blocked" title={b.reason}>
                            {b.blockingName ? `${b.blockingName} — ` : ''}
                            {b.reason} · {age(b.blockedSince)}
                          </span>
                        }
                      />
                    ))}
                  </ul>
                )}
              </SectionPanel>

              {isOversight ? (
                <SectionPanel
                  icon={<CheckCircle2 className="size-4 text-pending" aria-hidden />}
                  title="Awaiting my approval"
                  count={now.awaitingMyApproval.length}
                >
                  {now.awaitingMyApproval.length === 0 ? (
                    <Empty>Nothing waiting on you.</Empty>
                  ) : (
                    <>
                      <p className="mb-2 text-micro text-ink-3">{approvalLabel}</p>
                      <ul className="flex flex-col gap-2">
                        {now.awaitingMyApproval.map((t) => (
                          <TaskRow key={t.id} task={t} />
                        ))}
                      </ul>
                    </>
                  )}
                </SectionPanel>
              ) : null}

              <SectionPanel
                icon={<UserPlus className="size-4 text-ink-3" aria-hidden />}
                title="Assigned to you, not started yet"
                count={now.newlyAssigned.length}
              >
                {now.newlyAssigned.length === 0 ? (
                  <Empty>Nothing waiting for you to start.</Empty>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {now.newlyAssigned.map((t) => (
                      <TaskRow key={t.id} task={t} />
                    ))}
                  </ul>
                )}
              </SectionPanel>
            </div>
          );
        }}
      </ResourceView>
    </div>
  );
}
