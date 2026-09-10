/**
 * LRA Global Ops :: `/` — Now, the real screen
 *
 * PLAN.md Phase 7. Replaces the Phase 1 placeholder (which only proved
 * auth + the roster) with what `GET /api/now` actually gives: one
 * person's whole picture in a single call — their own open work, which
 * of it is blocked and why, the work THEY are holding up, what is
 * waiting on them to approve (oversight only), and what was just handed
 * to them. Polls every 20s per PLAN.md §4/DESIGN.md §7.2 ("who's
 * working now… changed values crossfade, nothing moves") — the poll is a
 * silent background refresh of the same local `data` state the initial
 * `useResource` load seeds, exactly the pattern `routes/board.tsx`'s
 * `load()` already uses, so a dropped connection mid-poll never wipes
 * what's on screen.
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
 *
 * Chan, 2026-09-10, three changes:
 *   1. "now page tasks should be interactable" — every row is a real
 *      button that opens the SAME detail modal the board opens
 *      (`components/tasks/task-detail-dialog.tsx`). Now's payload is
 *      slim, so the modal fetches the full row from `GET /api/tasks/:id`
 *      itself; see `TaskDetailById`.
 *   2. "i want it to be more clear which tasks you're blocking and
 *      which tasks you're not" — the work this person is holding up is
 *      its own section, at the top, and it is the only tinted region on
 *      the screen (DESIGN.md §11). The Blocked section below it now
 *      names who is holding each task and distinguishes a block this
 *      person raised themselves from one someone else raised.
 *   3. Sections are ordered by who is waiting, not by whose data it is:
 *      others waiting on you → decisions waiting on you → your work
 *      stuck on someone else → your open work → not started. And every
 *      list is height-capped with its own scroll region, because four
 *      unbounded panels in a 2-column grid made a person with 30 open
 *      tasks unreadable.
 */
import * as React from 'react';
import { Ban, CheckCircle2, HandHelping, Inbox, UserPlus } from 'lucide-react';
import { PageHeader } from '@/components/layout/app-shell';
import { TaskDetailById } from '@/components/tasks/task-detail-dialog';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { STATUS_LABEL, blockRelation, blockRelationLabel, statusTone } from '@/lib/task-types';

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
  // Added 2026-09-10 (build contract §B): who the block names and who
  // raised it. Without these, "your work is stuck" could not say who is
  // holding it, and the client could not mirror who may resolve it.
  blockingUserId: string | null;
  blockCreatedBy: string;
  blockCreatedByName: string | null;
}

/**
 * An open block that names THIS person as the blocker, on someone
 * else's task (build contract §B). This is the accountability half of
 * the screen: the reader is the reason this work is stopped.
 */
interface BlockingOther {
  blockId: string;
  reason: string;
  target: string;
  blockedSince: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  points: number;
  ownerUserId: string;
  ownerName: string | null;
  ownerPosition: string | null;
}

interface NowData {
  /**
   * Server-decided (build contract §B, extended 2026-09-10): whether this
   * caller can actually act on the approvals list. NOT re-derived from
   * `authority` here — a read-only founder (ERC, DCA) and a founder without
   * the clearing seat both hold an oversight authority and neither can clear
   * anything, so an authority-only test showed them a panel addressed to
   * somebody else. One decision, made in `routes/now.ts`; this screen renders
   * what it is told. See PLAN.md §11.1 on mirrors nobody diffs.
   */
  canActOnApprovals: boolean;
  myOpenTasks: NowTask[];
  blocked: BlockedTask[];
  awaitingMyApproval: NowTask[];
  newlyAssigned: NowTask[];
  blockingOthers: BlockingOther[];
}

function StatusChip({ status }: { status: string }) {
  const tones = {
    neutral: 'border-hairline bg-surface-2 text-ink-2',
    pending: 'border-pending-border bg-pending-wash text-pending',
    cleared: 'border-cleared-border bg-cleared-wash text-cleared',
    danger: 'border-danger-border bg-danger-wash text-danger',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex h-[20px] shrink-0 items-center whitespace-nowrap rounded-xs border px-2 text-micro font-medium leading-none',
        tones[statusTone(status)]
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

function hoursSince(iso: string): number {
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 3_600_000);
}

/**
 * How long a block has been open. DESIGN.md §2.3, verbatim: "blocked is
 * a stall, not an error — nobody did anything wrong. If a block passes
 * 24h the age counter turns `--danger`, which is the part that should
 * feel bad." That is the whole reason the blocked hue itself stays a
 * slate here and nothing invents a sixth colour.
 */
function BlockAge({ since }: { since: string }) {
  const stale = hoursSince(since) >= 24;
  return (
    <span
      className={cn('num text-num-xs', stale ? 'text-danger' : 'text-ink-3')}
      title={`Blocked since ${new Date(since).toLocaleString()}`}
    >
      {age(since)}
    </span>
  );
}

/** Time since the task itself last moved. Neutral: staleness is not blame. */
function ActivityAge({ iso, label }: { iso: string; label: string }) {
  return (
    <span className="num text-num-sm text-ink-3" title={`${label}: ${new Date(iso).toLocaleString()}`}>
      {age(iso)}
    </span>
  );
}

/**
 * One row. Chan: "now page tasks should be interactable." A real
 * `<button>`, not a `<div onClick>` — so it is in the tab order,
 * Enter/Space open it natively, and the focus ring is the app's
 * standard one (DESIGN.md §12: focus is never removed, focus order
 * follows visual order). `aria-haspopup="dialog"` says what pressing it
 * does before it happens.
 */
function TaskRow({
  title,
  status,
  ownerName,
  ownerPosition,
  points,
  ageSlot,
  meta,
  onOpen,
}: {
  title: string;
  status: string;
  ownerName: string | null;
  ownerPosition: string | null;
  points: number;
  /**
   * The row's one age counter. Exactly one per row, and it measures the
   * thing that matters for that section: how long a block has been open
   * where the section is about blocks, how long since the task moved
   * everywhere else. Two age numbers on one row is two numbers nobody
   * reads (DESIGN.md §11).
   */
  ageSlot: React.ReactNode;
  meta?: React.ReactNode;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        className={cn(
          'flex w-full items-center justify-between gap-3 rounded-md border border-hairline bg-surface px-3 py-2 text-left',
          'transition-colors duration-press hover:border-hairline-strong hover:bg-canvas',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
        )}
      >
        <span className="min-w-0">
          <span className="block truncate text-strong text-ink">{title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <StatusChip status={status} />
            {ownerName ? (
              <span className="text-micro text-ink-3">
                {ownerName}
                {ownerPosition ? ` · ${ownerPosition}` : ''}
              </span>
            ) : null}
            {meta}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {ageSlot}
          <span className="num text-num-md text-ink-2">{points}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * A panel. `summary` is the right-hand figure next to the count — the
 * board's own column header pattern (count chip + point total), reused
 * so the two screens summarise a pile of work the same way.
 *
 * The body is height-capped and scrolls on its own. Four unbounded
 * panels in a 2-column grid meant one person with 30 open tasks pushed
 * every other section off the screen entirely — the "too much data"
 * state Now had no answer for. DESIGN.md §11's density rules apply to
 * what is inside the cap, not to the page's total height.
 */
function SectionPanel({
  icon,
  title,
  count,
  summary,
  tone = 'plain',
  className,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  summary?: React.ReactNode;
  /** `accent` is the screen's ONE tinted region (DESIGN.md §11). */
  tone?: 'plain' | 'accent';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-surface p-5',
        tone === 'accent' ? 'border-blocked-border bg-blocked-wash' : 'border-hairline',
        className
      )}
    >
      <div className="mb-3 flex items-center gap-1.5 border-b border-hairline pb-3">
        {icon}
        <h2 className="text-subtitle text-ink">{title}</h2>
        <span className="num text-num-xs ml-auto rounded bg-surface-2 px-1.5 py-0.5 text-ink-3">{count}</span>
        {summary}
      </div>
      <div className="max-h-[420px] overflow-y-auto overscroll-contain">{children}</div>
    </div>
  );
}

/** A panel's point total, in the board column header's own register. */
function PointsTotal({ points }: { points: number }) {
  return (
    <span className="num text-num-sm text-ink-3" title="Points on the table in this section">
      {points}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-body-sm text-ink-3">{children}</p>;
}

export function NowPage() {
  const { me } = useAuth();
  // Only decides who may FLAG a cancellation now; the approvals section is
  // gated by the server's `canActOnApprovals` instead (see `NowData`).
  const isOversight = me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin';

  const resource = useResource((signal) => api.get<NowData>('/api/now', { signal }), []);
  const [data, setData] = React.useState<NowData | null>(null);
  // Which task's detail modal is open. The title comes from the row
  // that was clicked so the modal's own loading state carries the real
  // task's name instead of a placeholder.
  const [detail, setDetail] = React.useState<{ id: string; title: string } | null>(null);

  // The definition lock (PLAN.md §10.1) needs each task's WEEK state,
  // and neither `/api/now` nor `/api/tasks/:id` carries it — `week_id`
  // only. Read once for the page, exactly as `routes/board.tsx` does it
  // (a dozen recent weeks covers every task a live screen can show),
  // never once per opened card.
  const weeksResource = useResource(
    (signal) => api.get<{ id: string; state: string }[]>('/api/weeks?limit=12', { signal }),
    []
  );
  const weekStateById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const w of weeksResource.data ?? []) m.set(w.id, w.state);
    return m;
  }, [weeksResource.data]);

  React.useEffect(() => {
    if (resource.status === 'ready' && resource.data) setData(resource.data);
  }, [resource.status, resource.data]);

  // The silent refresh path (DESIGN.md §7.2: values crossfade, nothing
  // moves) — reuses the loaded `data` state rather than re-running
  // `useResource`'s loader, so neither a dropped poll nor a change made
  // inside the modal ever flashes the screen back to a skeleton. Same
  // shape as `routes/board.tsx`'s `load()`.
  const refresh = React.useCallback(() => {
    api
      .get<NowData>('/api/now')
      .then(setData)
      .catch(() => {
        // A missed refresh is not an error worth interrupting someone
        // over — the next poll will catch up. The initial load already
        // proved the API is reachable at all.
      });
  }, []);

  // The poll is FROZEN while the detail modal is open. Decided rather
  // than defaulted: a 20s background write to `data` while someone is
  // mid-note or mid-decision re-renders the list underneath them, and
  // if the task has since left the section they were reading, the row
  // they opened disappears from behind the dialog. Nothing on this
  // screen is time-critical over the span of one modal, and the modal
  // re-reads its own task and refreshes this list on close, so the
  // stale window costs nothing and closes itself.
  const modalOpen = detail != null;

  React.useEffect(() => {
    if (resource.status !== 'ready' || modalOpen) return;
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [resource.status, modalOpen, refresh]);

  // WHETHER this section renders is the server's decision
  // (`now.canActOnApprovals`); this only names WHICH step it is. So the
  // founder/admin arm is gone: re-deriving "you may clear" from
  // `authority === 'founder'` was a third copy of a rule the server
  // already owns, and the copy is wrong for the two founders it does not
  // distinguish — a read-only founder and a founder without the clearing
  // seat both read as "founder" here. Everyone the server lets act who
  // is not a GM is at the clearing step, so asking about the GM alone
  // cannot drift as the clearing rule changes.
  const approvalLabel =
    me?.authority === 'gm' ? 'Submitted, waiting on you to verify' : 'Verified, waiting on you to clear';

  return (
    <div>
      <PageHeader title="Now" description="What's on your plate right now. Refreshes automatically every 20 seconds." />

      <ResourceView resource={resource} skeleton={<SkeletonRows rows={4} height={64} />}>
        {() => {
          const now = data ?? resource.data!;
          // Build contract §B is additive and ships with the API lane;
          // a payload from before it simply has no `blockingOthers`
          // key, and an absent section is not a crash.
          const blockingOthers = now.blockingOthers ?? [];
          const sum = (tasks: { points: number }[]) => tasks.reduce((n, t) => n + t.points, 0);

          return (
            <div className="flex flex-col gap-4">
              {/*
                Chan: "i want it to be more clear which tasks you're
                blocking and which tasks you're not." This is the one
                section where the person reading it is the problem, so it
                leads the screen, spans it, and is the only tinted region
                on it (DESIGN.md §11) — weighted, not scolding: it says
                what is waiting and for how long, and every row opens the
                task so the block can actually be resolved.
              */}
              <SectionPanel
                icon={<HandHelping className="size-4 text-blocked" aria-hidden />}
                title="Work you are holding up"
                count={blockingOthers.length}
                tone={blockingOthers.length > 0 ? 'accent' : 'plain'}
                summary={blockingOthers.length > 0 ? <PointsTotal points={sum(blockingOthers)} /> : undefined}
              >
                {blockingOthers.length === 0 ? (
                  <p className="flex items-center gap-2 py-2 text-body-sm text-ink-2">
                    <CheckCircle2 className="size-4 shrink-0 text-cleared" aria-hidden />
                    You are not holding anyone up. Nothing on the team is waiting on you.
                  </p>
                ) : (
                  <>
                    <p className="mb-2 text-micro text-ink-2">
                      These are other people's tasks, stopped on you. Longest wait first.
                    </p>
                    <ul className="flex flex-col gap-2">
                      {blockingOthers.map((b) => (
                        <TaskRow
                          key={b.blockId}
                          title={b.taskTitle}
                          status={b.taskStatus}
                          ownerName={b.ownerName}
                          ownerPosition={b.ownerPosition}
                          points={b.points}
                          ageSlot={<BlockAge since={b.blockedSince} />}
                          onOpen={() => setDetail({ id: b.taskId, title: b.taskTitle })}
                          meta={
                            <span className="text-micro text-blocked" title={b.reason}>
                              Waiting on you — {b.reason}
                            </span>
                          }
                        />
                      ))}
                    </ul>
                  </>
                )}
              </SectionPanel>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/*
                  `now.canActOnApprovals`, not `isOversight`. The section is
                  hidden entirely rather than rendered empty — the same rule
                  Chan gave for /queue and the board's cancellation banner:
                  "it should just stay blank". A read-only founder or a founder
                  without the clearing seat is oversight and still has no path
                  to clear anything, so an authority-only test handed them a
                  to-do list addressed to somebody else.
                */}
                {now.canActOnApprovals ? (
                  <SectionPanel
                    icon={<CheckCircle2 className="size-4 text-pending" aria-hidden />}
                    title="Awaiting my approval"
                    count={now.awaitingMyApproval.length}
                    summary={
                      now.awaitingMyApproval.length > 0 ? <PointsTotal points={sum(now.awaitingMyApproval)} /> : undefined
                    }
                  >
                    {now.awaitingMyApproval.length === 0 ? (
                      <Empty>Nothing waiting on you.</Empty>
                    ) : (
                      <>
                        <p className="mb-2 text-micro text-ink-3">{approvalLabel}</p>
                        <ul className="flex flex-col gap-2">
                          {now.awaitingMyApproval.map((t) => (
                            <TaskRow
                              key={t.id}
                              title={t.title}
                              status={t.status}
                              ownerName={t.ownerName}
                              ownerPosition={t.ownerPosition}
                              points={t.points}
                              ageSlot={<ActivityAge iso={t.lastActivityAt} label="Last activity" />}
                              onOpen={() => setDetail({ id: t.id, title: t.title })}
                            />
                          ))}
                        </ul>
                      </>
                    )}
                  </SectionPanel>
                ) : null}

                {/*
                  The other half of Chan's ask: this section is "your
                  work, stuck." Each row now names WHO is holding it and
                  says whether the reader raised the block themselves —
                  the two used to render identically, which is exactly
                  the confusion he described.
                */}
                <SectionPanel
                  icon={<Ban className="size-4 text-blocked" aria-hidden />}
                  title="Your work, stuck"
                  count={now.blocked.length}
                  summary={now.blocked.length > 0 ? <PointsTotal points={sum(now.blocked)} /> : undefined}
                >
                  {now.blocked.length === 0 ? (
                    <Empty>Nothing of yours is blocked.</Empty>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {now.blocked.map((b) => {
                        const relation = blockRelation(
                          { created_by: b.blockCreatedBy, blocking_user_id: b.blockingUserId },
                          me?.id
                        );
                        // Three genuinely different situations, and the
                        // first one is the odd case worth calling out:
                        // your own task is stopped on YOU. The words are
                        // `blockRelationLabel`'s (lib/task-types.ts), the
                        // same ones the board card and the modal use --
                        // this screen used to spell them out itself and
                        // so kept saying "someone else" for a block that
                        // names another TASK rather than a person.
                        const who =
                          blockRelationLabel(relation, b.blockingName, b.target) +
                          (relation === 'waiting-on-other' && b.blockCreatedByName
                            ? ` · raised by ${b.blockCreatedByName}`
                            : '');
                        return (
                          <TaskRow
                            key={b.blockId}
                            title={b.title}
                            status={b.status}
                            ownerName={b.ownerName}
                            ownerPosition={b.ownerPosition}
                            points={b.points}
                            ageSlot={<BlockAge since={b.blockedSince} />}
                            onOpen={() => setDetail({ id: b.id, title: b.title })}
                            meta={
                              <span
                                className={cn('text-micro text-blocked', relation === 'waiting-on-you' && 'font-semibold')}
                                title={b.reason}
                              >
                                {who} — {b.reason}
                              </span>
                            }
                          />
                        );
                      })}
                    </ul>
                  )}
                </SectionPanel>

                <SectionPanel
                  icon={<Inbox className="size-4 text-ink-3" aria-hidden />}
                  title="My open work"
                  count={now.myOpenTasks.length}
                  summary={now.myOpenTasks.length > 0 ? <PointsTotal points={sum(now.myOpenTasks)} /> : undefined}
                >
                  {now.myOpenTasks.length === 0 ? (
                    <Empty>Nothing in progress. Pick up something from the board.</Empty>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {now.myOpenTasks.map((t) => (
                        <TaskRow
                          key={t.id}
                          title={t.title}
                          status={t.status}
                          ownerName={t.ownerName}
                          ownerPosition={t.ownerPosition}
                          points={t.points}
                          ageSlot={<ActivityAge iso={t.lastActivityAt} label="Last activity" />}
                          onOpen={() => setDetail({ id: t.id, title: t.title })}
                        />
                      ))}
                    </ul>
                  )}
                </SectionPanel>

                <SectionPanel
                  icon={<UserPlus className="size-4 text-ink-3" aria-hidden />}
                  title="Assigned to you, not started yet"
                  count={now.newlyAssigned.length}
                  summary={now.newlyAssigned.length > 0 ? <PointsTotal points={sum(now.newlyAssigned)} /> : undefined}
                >
                  {now.newlyAssigned.length === 0 ? (
                    <Empty>Nothing waiting for you to start.</Empty>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {now.newlyAssigned.map((t) => (
                        <TaskRow
                          key={t.id}
                          title={t.title}
                          status={t.status}
                          ownerName={t.ownerName}
                          ownerPosition={t.ownerPosition}
                          points={t.points}
                          ageSlot={<ActivityAge iso={t.createdAt} label="Assigned" />}
                          onOpen={() => setDetail({ id: t.id, title: t.title })}
                        />
                      ))}
                    </ul>
                  )}
                </SectionPanel>
              </div>
            </div>
          );
        }}
      </ResourceView>

      {detail ? (
        <TaskDetailById
          taskId={detail.id}
          fallbackTitle={detail.title}
          weekStateById={weekStateById}
          canFlagCancellation={isOversight && !me?.readOnly}
          onClose={() => {
            setDetail(null);
            // Closing after a change refreshes through the silent path,
            // never back through `useResource` — the screen must not
            // flash to a skeleton on the way out of a modal.
            refresh();
          }}
          onChanged={refresh}
        />
      ) : null}
    </div>
  );
}
