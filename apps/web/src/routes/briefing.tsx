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
 *
 * 2026-09-10, Chan: "make sure for the monday briefing one the admin and
 * founder be able to edit stuff. GM can send a request to edit (should be
 * done by bulk like an edit feature on google docs), then approve by
 * admin or founder showing what changed like before and after." That is
 * the two sections at the bottom of this screen —
 * `components/briefing/committed-work-section.tsx` (the editable Monday
 * record: a founder/admin edits inline, a GM builds a batch of
 * suggestions nothing writes until submitted) and
 * `components/briefing/pending-batches-section.tsx` (the before -> after
 * decision surface). The definitions they edit come from
 * `GET /api/tasks?weekId=…&committed=true`, which is the only read that
 * returns a task's full definition; `/api/briefing/:id`'s own
 * `commitCandidates`/`committed` carry titles and points, not
 * description/type/owner/client-ref, and it is not this lane's endpoint
 * to widen.
 *
 * 2026-09-10, Chan: "they should be guided with how to do it with the
 * input placeholders etc. and once its done, there are tooltips… i dont
 * want this webapp to be too daunting." This pass (DESIGN.md §21, §16,
 * §20, §24) makes the ritual a stated, four-step flow rather than four
 * unlabelled sections: a step rail under the header, a step marker and
 * purpose line above each section (`components/briefing/step-rail.tsx`),
 * plain-words empty states that explain what to do next instead of
 * describing the schema, a `<WhatIsThis>` that opens itself the first
 * time anyone visits (`lib/briefing-first-run.ts`), and a below-`md`
 * layout that turns the four-column commit grid into one collapsible
 * card per person and the scorecard table into a stack of cards
 * (`components/briefing/commit-section.tsx`, §16.4) so the whole ritual
 * is runnable from a phone, not just the shared display in the room.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { fmtDate, fmtTime, weekLabel, fmtWeekRange } from '@/lib/dates';
import { formatDuration, formatDurationLong } from '@/lib/duration';
import { hasSeenBriefingIntro, markBriefingIntroSeen } from '@/lib/briefing-first-run';
import { StepHeading, StepRail, type BriefingStep } from '@/components/briefing/step-rail';
import { useActiveBriefingStep } from '@/components/briefing/use-active-briefing-step';
import { CommitSection, type CommitCandidateTask, type CommitRosterPerson } from '@/components/briefing/commit-section';
import type { Actor } from '@/lib/task-permissions';
import type { DiffResolvers } from '@/lib/task-edit-requests';
import type { SuggestionResolvers } from '@/lib/edit-suggestions';
import { CommittedWorkSection } from '@/components/briefing/committed-work-section';
import { PendingBatchesSection } from '@/components/briefing/pending-batches-section';
import type {
  BriefingMember,
  BriefingTask,
  BriefingTaskType,
} from '@/components/briefing/task-definition-row';

interface Week {
  id: string;
  week_start: string;
  week_end: string;
  state: 'planning' | 'open' | 'closed';
  briefing_opened_at: string | null;
  briefing_closed_at: string | null;
  /** Who closed it — resolved to a name against `members` below, for the completion banner (§21.4). */
  briefing_closed_by: string | null;
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

interface BriefingData {
  week: Week;
  previousWeek: Week | null;
  roster: CommitRosterPerson[];
  scorecard: ScorecardRow[];
  carryOvers: CarryOver[];
  blocks: { open: OpenBlock[]; byBlocker: Array<{ label: string; hours: number }> };
  commitCandidates: Record<string, CommitCandidateTask[]>;
  committed: Record<string, CommitCandidateTask[]>;
}

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** DESIGN.md §21.1 — the four steps, in order, stated on the screen. */
const STEPS: BriefingStep[] = [
  { id: 'step-scorecard', title: "Last week's scorecard" },
  { id: 'step-carryovers', title: 'Carry-overs' },
  { id: 'step-blocks', title: 'Blocks' },
  { id: 'step-commit', title: 'Commit' },
];
const STEP_IDS = STEPS.map((s) => s.id);

export function BriefingPage() {
  const { me } = useAuth();
  const isOversight = me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin';
  // ERC / DCA sit on this shared-display screen with everyone else, so
  // the write controls stay visible-but-disabled rather than vanishing
  // (task-permissions.ts's rule: absence for a whole meaningless surface,
  // a reason for a control inside a screen they legitimately read).
  const readOnly = me?.readOnly ?? false;
  const readOnlyReason = 'Your account is read-only.';

  // `?weekId=` — a READ selector, defaulting to the live current week.
  //
  // Why it exists: this screen could only ever show `/api/weeks/current`,
  // and that is the structural reason the Monday ritual had never been
  // driven through a browser (PLAN.md §12.9). Opening and closing a
  // briefing are irreversible, so with no way to point the screen at a
  // throwaway week the only thing to practise on was the real one — which
  // is why the most important flow in this system was verified solely by
  // API-level tests, the exact evidence §12.7 shows to be insufficient.
  // It also gives a founder the only way to review a PAST briefing.
  //
  // Deliberately read-only in scope: `Open`/`Close` below act on
  // `week.id`, i.e. whatever is actually on screen, so there is no path
  // where someone closes a different week by editing a URL. The banner
  // is the other half of that guarantee — a founder must never mistake
  // another week's briefing for this week's.
  const [searchParams] = useSearchParams();
  const requestedWeekId = searchParams.get('weekId');
  //
  // `GET /api/weeks/:id` now exists (`routes/weeks.ts`, 2026-09-10) — one
  // bounded read for the exact row, an honest 404 for an id that is not
  // there or that RLS hides, and no ceiling on how far back a week can be.
  //
  // It replaced a list-scan workaround written when the route genuinely did
  // not exist yet: `GET /api/weeks?limit=104` and find-by-id. That worked,
  // but it fetched up to 104 rows to answer a question about one, and it
  // silently could not see a week older than its own limit — a cap that
  // would have surfaced as "no such week" for a week that plainly exists.
  // The route's own shadowing hazard against the literal `/current` is
  // pinned by a test against the real router
  // (`apps/api/test/tasks-route.test.ts`), not by reading registration
  // order, because that is how `/board` and `/:id` nearly collided.
  const weekResource = useResource<Week | null>(
    (signal) =>
      requestedWeekId
        ? api.get<Week | null>(`/api/weeks/${requestedWeekId}`, { signal })
        : api.get<Week | null>('/api/weeks/current', { signal }),
    [requestedWeekId]
  );
  const week = weekResource.data;
  // True only when an explicit week was asked for AND it is not the one
  // `/api/weeks/current` would have returned anyway.
  const viewingExplicitWeek = Boolean(requestedWeekId) && Boolean(week);

  const briefingResource = useResource(
    (signal) => (week ? api.get<BriefingData>(`/api/briefing/${week.id}`, { signal }) : Promise.resolve(null)),
    [week?.id]
  );

  const [confirmingClose, setConfirmingClose] = React.useState(false);
  /*
    The pending-batch list fetches for itself, and a submit happens in
    the committed-work section above it, which holds no handle on that
    fetch. Bumping this is how the two are told about each other.
  */
  const [batchesToken, setBatchesToken] = React.useState(0);

  // The editable Monday record. A separate read from `/api/briefing/:id`
  // on purpose: that endpoint answers "what does the meeting need to
  // see", and a task's DEFINITION (description, catalog type, owner,
  // client reference) is not part of that answer. `GET /api/tasks` is the
  // read that carries the whole row, and it is already RLS-scoped the
  // same way.
  const committedResource = useResource(
    (signal) =>
      week
        ? api.get<BriefingTask[]>(`/api/tasks?weekId=${week.id}&committed=true`, { signal })
        : Promise.resolve<BriefingTask[]>([]),
    [week?.id]
  );

  // The catalog and roster the diff needs to render an id as a name, and
  // the completion banner needs to resolve `briefing_closed_by` to a name.
  const [types, setTypes] = React.useState<BriefingTaskType[]>([]);
  const [members, setMembers] = React.useState<BriefingMember[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    Promise.all([api.get<BriefingTaskType[]>('/api/catalog'), api.get<BriefingMember[]>('/api/members')])
      .then(([t, m]) => {
        if (cancelled) return;
        setTypes(t);
        setMembers(m);
      })
      .catch(() => {
        // Non-fatal: without these, an id renders as "Unknown type" /
        // "Unknown" rather than the screen failing. Never a silent
        // wrong-looking name.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // DESIGN.md §21.5: "On first visit to `/briefing` with no
  // `localStorage['lra.seen.briefing.v1']`, the `<WhatIsThis>` popover
  // opens automatically… It never re-opens on its own." Controlled
  // permanently on THIS screen (the only screen this applies to) rather
  // than only for the first render, so a later manual click of the icon
  // still opens the very same popover through the very same state.
  //
  // Derived at mount via a lazy `useState` initializer, not an effect —
  // both flags come from the same one-time `localStorage` read, so there
  // is one `wasFirstVisit` computed once and reused for both, rather
  // than a `setState` call inside a `useEffect` that fires the render it
  // could have started with.
  const [wasFirstVisit] = React.useState(() => !hasSeenBriefingIntro());
  const [helpOpen, setHelpOpen] = React.useState(wasFirstVisit);
  const [helpIsFirstRun, setHelpIsFirstRun] = React.useState(wasFirstVisit);
  function handleHelpOpenChange(next: boolean) {
    setHelpOpen(next);
    if (!next) {
      // Any dismissal counts — Esc, outside click or "Got it" — per
      // §21.5's "must be dismissible… must never re-open once dismissed".
      markBriefingIntroSeen();
      setHelpIsFirstRun(false);
    }
  }

  const activeStepIndex = useActiveBriefingStep(STEP_IDS);

  const actor: Actor | null = me
    ? { id: me.id, authority: me.authority, isClearingFounder: me.isClearingFounder, readOnly: me.readOnly }
    : null;

  const resolve: DiffResolvers & SuggestionResolvers = React.useMemo(
    () => ({
      taskTypeName: (id) => types.find((t) => t.id === id)?.name ?? 'Unknown type',
      memberName: (id) =>
        members.find((m) => m.userId === id)?.name ?? members.find((m) => m.userId === id)?.email ?? 'Unknown',
    }),
    [types, members]
  );

  // Keyed off the resource's own data, not off a `?? []` fallback that is
  // a fresh array on every render.
  const tasksById = React.useMemo(
    () => new Map((committedResource.data ?? []).map((t) => [t.id, t])),
    [committedResource.data]
  );

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
        description={week ? `${weekLabel(week.week_start)} · ${fmtWeekRange(week.week_start, week.week_end)}` : undefined}
        help="briefing"
        helpOpen={helpOpen}
        onHelpOpenChange={handleHelpOpenChange}
        helpFooter={
          helpIsFirstRun ? (
            <Button size="sm" onClick={() => handleHelpOpenChange(false)}>
              Got it
            </Button>
          ) : undefined
        }
        actions={
          isOversight && week && week.state === 'planning' ? (
            <div className="flex gap-2">
              {!week.briefing_opened_at ? (
                <Hint text={readOnly ? readOnlyReason : undefined}>
                  <Button variant="secondary" onClick={openBriefing} disabled={readOnly}>
                    Open the briefing
                  </Button>
                </Hint>
              ) : null}
            </div>
          ) : undefined
        }
      />

      <StepRail steps={STEPS} activeIndex={activeStepIndex} className="mb-5" />

      <ResourceView
        resource={weekResource}
        skeleton={<BriefingSkeleton />}
        empty={
          <div className="mx-auto max-w-[420px] rounded-xl border border-hairline bg-surface p-8 text-center">
            <p className="mb-3 text-body text-ink-2">{weekLabel(new Date().toISOString())} hasn't been opened.</p>
            {isOversight ? (
              <Hint text={readOnly ? readOnlyReason : undefined}>
                <Button onClick={openTheWeek} disabled={readOnly}>
                  Open the week
                </Button>
              </Hint>
            ) : null}
          </div>
        }
        isEmpty={(w) => !w}
      >
        {(w) => (
          <>
            {/*
              The other half of the `?weekId=` guarantee. Open and Close are
              irreversible and they act on whatever week is on screen, so the
              one real risk of a week selector is a founder acting on a week
              they think is this one. This says which week they are looking
              at, in the `--pending` semantic rather than a neutral one,
              because "not this week" is a state to be careful in — and it
              offers the way back rather than expecting a URL edit.
            */}
            {viewingExplicitWeek && w ? (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-pending-border bg-pending-wash px-4 py-3">
                <p className="text-body-sm text-ink-2">
                  You are viewing a <strong className="font-semibold">specific week</strong>, not necessarily the
                  current one — {weekLabel(w.week_start)}, {fmtWeekRange(w.week_start, w.week_end)}. Opening or closing
                  a briefing here acts on <em>this</em> week.
                </p>
                <a href="/briefing" className="shrink-0 text-label text-brand-700 underline">
                  Back to the current week
                </a>
              </div>
            ) : null}
            {w && w.state !== 'planning' ? (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-cleared-border bg-cleared-wash px-4 py-3">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-cleared" aria-hidden />
                <div>
                  <p className="text-body font-medium text-ink">
                    {weekLabel(w.week_start)} is {w.state}. Committed work is locked.
                  </p>
                  <p className="text-body-sm text-ink-3">
                    {w.briefing_closed_at ? (
                      <>
                        Closed{' '}
                        <span className="num text-num-xs">
                          {fmtDate(w.briefing_closed_at)}, {fmtTime(w.briefing_closed_at)}
                        </span>
                        {closedByName(members, w.briefing_closed_by) ? ` by ${closedByName(members, w.briefing_closed_by)}` : ''}
                        .
                      </>
                    ) : (
                      "New tasks can still be created and worked mid-week; they won't count as commitments."
                    )}
                  </p>
                </div>
              </div>
            ) : null}
            {readOnly ? (
              <div className="mb-4 rounded-lg border border-blocked-border bg-blocked-wash px-4 py-3 text-body-sm text-ink-2">
                You have read-only access. You can see everything and change nothing.
              </div>
            ) : null}
          </>
        )
        }
      </ResourceView>

      {week ? (
        <ResourceView resource={briefingResource} skeleton={<BriefingSkeleton />}>
          {(data) =>
            data ? (
              <div className="flex flex-col gap-8">
                <section id="step-scorecard">
                  <StepHeading
                    step={1}
                    total={4}
                    title="Last week's scorecard"
                    purpose="What we said we'd do last week, and what actually cleared."
                  />
                  <ScorecardSection scorecard={data.scorecard} previousWeek={data.previousWeek} />
                </section>

                <section id="step-carryovers">
                  <StepHeading
                    step={2}
                    total={4}
                    title="Carry-overs"
                    purpose="Work that didn't finish. Decide if it's still worth doing."
                  />
                  <CarryOverSection carryOvers={data.carryOvers} />
                </section>

                <section id="step-blocks">
                  <StepHeading
                    step={3}
                    total={4}
                    title="Blocks"
                    purpose="What stopped people, and who is clearing each one."
                  />
                  <BlocksSection blocks={data.blocks} />
                </section>

                <section id="step-commit">
                  <StepHeading
                    step={4}
                    total={4}
                    title="Commit"
                    purpose="Each person picks this week's work. This is the record."
                  />
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
                    onTaskCreated={() => briefingResource.reload()}
                  />
                </section>

                {isOversight && week.state === 'planning' ? (
                  <CloseBar
                    roster={data.roster}
                    committed={data.committed}
                    readOnly={readOnly}
                    readOnlyReason={readOnlyReason}
                    onRequestClose={() => setConfirmingClose(true)}
                  />
                ) : null}
              </div>
            ) : null
          }
        </ResourceView>
      ) : null}

      {/*
        The edit surfaces sit OUTSIDE the briefing payload's ResourceView
        on purpose: they read a different endpoint, and a failure of the
        standup payload must not take the record and its pending edit
        decisions down with it (DESIGN.md §8 — never a full-page error for
        a partial failure).
      */}
      {week ? (
        <div className="mt-8 flex flex-col gap-8">
          <ResourceView resource={committedResource} skeleton={<SkeletonRows rows={4} height={64} />}>
            {(tasks) => (
              <CommittedWorkSection
                weekId={week.id}
                weekState={week.state}
                actor={actor}
                tasks={tasks ?? []}
                types={types}
                members={members}
                resolve={resolve}
                onChanged={() => {
                  committedResource.reload();
                  briefingResource.reload();
                  setBatchesToken((n) => n + 1);
                }}
              />
            )}
          </ResourceView>

          {/*
            Any ops member may READ a pending batch, but for staff this
            whole surface is something they can neither raise nor decide,
            so it is absent rather than rendered inert — the same rule the
            commit controls above follow. A GM sees it because it is how
            they find out what happened to what they sent.
          */}
          {isOversight ? (
            <PendingBatchesSection
              actor={actor}
              tasksById={tasksById}
              resolve={resolve}
              onDecided={() => {
                committedResource.reload();
                briefingResource.reload();
              }}
              reloadToken={batchesToken}
            />
          ) : null}
        </div>
      ) : null}

      {confirmingClose ? (
        <Dialog open onOpenChange={(v) => !v && setConfirmingClose(false)}>
          <DialogContent>
            <DialogHeader>
              {/*
                The week is NAMED in the title, because `?weekId=` means
                the week on screen is no longer necessarily this one and
                this action is irreversible. The write already targets
                `week.id` — what was missing was the reader being told
                which week that is at the moment they confirm.
              */}
              <DialogTitle>Close the briefing for {week ? weekLabel(week.week_start) : 'this week'}?</DialogTitle>
            </DialogHeader>
            <p className="text-body-sm text-ink-2">
              Closing locks Monday's record. Nobody can change what was committed after this — a GM can only suggest
              edits, and you or the admin approve them. Tasks can still be created and worked mid-week; they won't
              count as commitments.
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

function closedByName(members: BriefingMember[], userId: string | null): string | null {
  if (!userId) return null;
  const m = members.find((x) => x.userId === userId);
  return m?.name ?? m?.email ?? null;
}

/**
 * DESIGN.md §21.4: the sticky close bar. `bottom-0`, holding the live
 * readout on the left and the one `primary` action on the right —
 * "that band is what makes 'done' a visible state rather than an
 * absence of buttons," and the same discipline applies before closing:
 * the reader should never have to count committed cards by eye to know
 * whether the week is ready to lock.
 */
function CloseBar({
  roster,
  committed,
  readOnly,
  readOnlyReason,
  onRequestClose,
}: {
  roster: CommitRosterPerson[];
  committed: Record<string, CommitCandidateTask[]>;
  readOnly: boolean;
  readOnlyReason: string;
  onRequestClose: () => void;
}) {
  const visibleRoster = roster.filter((r) => r.position !== 'other');
  const committedCounts = visibleRoster.map((p) => (committed[p.userId] ?? []).length);
  const numCommitted = committedCounts.filter((n) => n > 0).length;
  const totalPoints = visibleRoster.reduce(
    (sum, p) => sum + (committed[p.userId] ?? []).reduce((s, t) => s + (t.committed_points ?? 0), 0),
    0
  );
  const everyoneHasOne = visibleRoster.length > 0 && committedCounts.every((n) => n > 0);
  const disabledReason = readOnly
    ? readOnlyReason
    : !everyoneHasOne
      ? 'Everyone needs at least one committed task before the week can be locked.'
      : undefined;

  return (
    <div
      className="sticky bottom-0 z-10 -mx-6 flex flex-wrap items-center justify-between gap-3 border-t border-hairline bg-surface px-6 py-3 lg:mx-0 lg:rounded-xl lg:border"
      style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
    >
      <p className="text-body-sm text-ink-2">
        <span className="num text-num-sm text-ink">
          {numCommitted} of {visibleRoster.length}
        </span>{' '}
        people have committed · <span className="num text-num-sm text-ink">{totalPoints}</span> points
      </p>
      <Hint text={disabledReason}>
        <Button onClick={onRequestClose} disabled={Boolean(disabledReason)}>
          Close the briefing
        </Button>
      </Hint>
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
        <div className="skeleton-pulse mb-1 h-2.5 w-20 rounded-xs bg-surface-3" aria-hidden />
        <div className="skeleton-pulse mb-3 h-5 w-48 rounded-md bg-surface-2" aria-hidden />
        <SkeletonRows rows={4} height={40} />
      </section>
      <section>
        <div className="skeleton-pulse mb-1 h-2.5 w-20 rounded-xs bg-surface-3" aria-hidden />
        <div className="skeleton-pulse mb-3 h-5 w-32 rounded-md bg-surface-2" aria-hidden />
        <SkeletonRows rows={2} height={40} />
      </section>
      <section>
        <div className="skeleton-pulse mb-1 h-2.5 w-20 rounded-xs bg-surface-3" aria-hidden />
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
        <div className="skeleton-pulse mb-1 h-2.5 w-20 rounded-xs bg-surface-3" aria-hidden />
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

function ScorecardSection({ scorecard, previousWeek }: { scorecard: ScorecardRow[]; previousWeek: Week | null }) {
  // PLAN.md §10 #4: hit-rate is founder/admin only. The API already
  // strips it from the payload; this drops the column too, so the
  // standup table has no empty gap where the numbers used to be.
  const { me } = useAuth();
  const showHitRate = me?.authority === 'founder' || me?.authority === 'admin';

  if (!previousWeek) {
    return (
      <div className="rounded-xl border border-hairline bg-surface px-4 py-3">
        <p className="text-body-sm text-ink-3">There is no previous week yet — this is the first one.</p>
        <a href="#step-commit" className="mt-2 inline-block text-label text-brand-700 underline">
          Skip to Commit ↓
        </a>
      </div>
    );
  }
  if (scorecard.length === 0) {
    return (
      <p className="rounded-xl border border-hairline bg-surface px-4 py-3 text-body-sm text-ink-3">
        Nobody committed to anything last week.
      </p>
    );
  }

  return (
    <>
      {/* ≥sm: the real table, unchanged. Below sm: a stack of cards — a
          4-5 column table hides the hit-rate off the right edge of a
          343px phone rather than scrolling, and a scroller here would
          hide exactly the number the founder most needs (§16.4). */}
      <div className="hidden overflow-hidden rounded-xl border border-hairline bg-surface sm:block">
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
                <td className="num text-num-sm px-3 text-right">{row.committedPoints}</td>
                <td className="num text-num-sm px-3 text-right">{row.clearedCommittedPoints}</td>
                {showHitRate ? (
                  <td className="num text-num-sm px-3 text-right">{row.hitRate == null ? '—' : `${Math.round(row.hitRate * 100)}%`}</td>
                ) : null}
                <td className="num text-num-sm px-3 text-right text-ink">{row.clearedPoints}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2 sm:hidden">
        {scorecard.map((row) => (
          <div key={row.userId} className="rounded-xl border border-hairline bg-surface p-3">
            <p className="text-strong text-ink">
              {row.name} <span className="text-eyebrow text-ink-3">{row.position}</span>
            </p>
            <div className={cn('mt-2 grid gap-2', showHitRate ? 'grid-cols-4' : 'grid-cols-3')}>
              <ScorecardStat label="Committed" value={row.committedPoints} />
              <ScorecardStat label="Cleared" value={row.clearedCommittedPoints} />
              {showHitRate ? (
                <ScorecardStat label="Hit-rate" value={row.hitRate == null ? '—' : `${Math.round(row.hitRate * 100)}%`} />
              ) : null}
              <ScorecardStat label="This week" value={row.clearedPoints} emphasis />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ScorecardStat({ label, value, emphasis }: { label: string; value: number | string; emphasis?: boolean }) {
  return (
    <div>
      <p className="text-eyebrow text-ink-3">{label}</p>
      <p className={cn('num text-num-sm', emphasis ? 'text-ink' : 'text-ink-2')}>{value}</p>
    </div>
  );
}

function CarryOverSection({ carryOvers }: { carryOvers: CarryOver[] }) {
  if (carryOvers.length === 0) {
    return (
      <p className="flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-4 py-3 text-body-sm text-ink-3">
        <CheckCircle2 className="size-4 shrink-0 text-cleared" aria-hidden />
        Nothing carried over. Everything committed last week finished.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-hairline bg-surface">
      {carryOvers.map((c) => (
        <div key={c.id} className="flex items-center gap-4 border-b border-hairline px-4 py-2 text-body-sm last:border-0">
          <span className="min-w-0 flex-1 truncate">{c.title}</span>
          <span className="hidden text-ink-3 sm:inline">{c.ownerName}</span>
          <Hint text={`Carried over for ${formatDurationLong(c.carryOverCount * WEEK_MS)} in a row.`}>
            <span
              className={cn(
                'num text-num-xs flex shrink-0 items-center gap-1',
                c.carryOverCount >= 3 ? 'text-danger' : 'text-ink-3'
              )}
            >
              <RotateCcw className="size-3 shrink-0" aria-hidden />
              {formatDuration(c.carryOverCount * WEEK_MS)}
            </span>
          </Hint>
        </div>
      ))}
    </div>
  );
}

function BlocksSection({ blocks }: { blocks: { open: OpenBlock[]; byBlocker: Array<{ label: string; hours: number }> } }) {
  if (blocks.open.length === 0 && blocks.byBlocker.length === 0) {
    return (
      <p className="rounded-xl border border-hairline bg-surface px-4 py-3 text-body-sm text-ink-3">
        No blocks were raised last week.
      </p>
    );
  }
  return (
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
                <Hint text={`Blocked for ${formatDurationLong(b.hoursOpen * HOUR_MS)}.`}>
                  <span className="num text-num-xs text-ink-3">({formatDuration(b.hoursOpen * HOUR_MS)})</span>
                </Hint>
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
                <span className="min-w-0 truncate">{b.label}</span>
                <span className="num text-num-sm shrink-0 text-ink">{formatDuration(b.hours * HOUR_MS)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
