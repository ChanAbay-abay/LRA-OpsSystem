/**
 * LRA Global Ops :: New task dialog
 *
 * Phase 3 gap (PLAN.md §7): tasks only ever arrived via the seed or
 * recurring generation — there was no way to create one by hand, so
 * anyone trialling the app hit a dead end within a minute. This posts
 * straight to `POST /api/tasks` (routes/tasks.ts's `createSchema`), the
 * same route the seed and recurring generation use.
 *
 * Permission is read from the API contract, not guessed: `POST /api/tasks`
 * throws 403 when a staff caller sets `ownerUserId` to anyone but
 * themselves ("only oversight may create a task for someone else"). The
 * assignee field is disabled to everyone but self for a non-oversight
 * caller instead of letting them submit and eat that refusal — the
 * standing rule that the UI must not offer what the database will
 * refuse.
 *
 * Fields: task type (`<TaskTypePicker>` — carries the catalog's point
 * value; picking one is how the task gets priced), title, assignee,
 * week.
 *
 * `weekId` is required by the API, and this dialog preselects the
 * current Manila week (`GET /api/weeks/current`) ONLY when it can
 * actually take a task (not `closed`). It never falls back to a
 * different week on the user's behalf — an earlier revision did (the
 * most recent open/planning week from `GET /api/weeks?limit=8`), and
 * that silently landed a task in last week whenever the current one was
 * closed (Chan, 2026-09-11). When the current week can't take a task,
 * the field is left empty, the reason is stated next to it, and the
 * person picks a week themselves.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TaskTypePicker, type PickableTaskType } from '@/components/tasks/task-type-picker';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';
import { fmtWeekRange } from '@/lib/dates';
import { weekStateLabel } from '@/lib/labels';

type TaskType = PickableTaskType;

interface Member {
  userId: string;
  email: string | null;
  authority: string | null;
  position: string;
  name: string | null;
  /** `core.users.read_only` (ERC, DCA). Optional: a missing value must never exclude a real teammate. */
  readOnly?: boolean;
}

interface Week {
  id: string;
  week_start: string;
  week_end: string;
  state: 'planning' | 'open' | 'closed';
}

export function CreateTaskDialog({
  onClose,
  onCreated,
  defaultOwnerId,
}: {
  onClose: () => void;
  onCreated: () => void;
  /**
   * DESIGN.md §21.3: the briefing's "No backlog work to pick from" empty
   * state opens this dialog with the person already chosen, so it reads
   * as a shortcut rather than a second form to fill in. Optional and
   * oversight-only in effect — an owner other than yourself is disabled
   * below for anyone who is not oversight regardless of this prop, same
   * as today.
   */
  defaultOwnerId?: string;
}) {
  const { me } = useAuth();
  const isOversight = me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin';

  const [loadingLists, setLoadingLists] = React.useState(true);
  const [types, setTypes] = React.useState<TaskType[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [weeks, setWeeks] = React.useState<Week[]>([]);
  const [listError, setListError] = React.useState<string | null>(null);

  const [title, setTitle] = React.useState('');
  const [typeId, setTypeId] = React.useState<string>('');
  const [ownerId, setOwnerId] = React.useState<string>(defaultOwnerId ?? me?.id ?? '');
  const [weekId, setWeekId] = React.useState<string>('');
  // The live Manila week, as `GET /api/weeks/current` reported it — kept
  // separately from `weeks` so the "why is nothing preselected" message
  // below can say WHY (never created yet vs. closed) rather than a bare
  // "pick one".
  const [currentWeek, setCurrentWeek] = React.useState<Week | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<TaskType[]>('/api/catalog'),
      api.get<Member[]>('/api/members'),
      api.get<Week | null>('/api/weeks/current'),
      api.get<Week[]>('/api/weeks?limit=8'),
    ])
      .then(([allTypes, roster, current, recent]) => {
        if (cancelled) return;
        setTypes(allTypes.filter((t) => t.is_active));
        setMembers(roster);
        setWeeks(recent);
        setCurrentWeek(current ?? null);
        // A closed week is the finished artifact of that week
        // (docs/AGENT-LESSONS.md §9) — it cannot take a new, uncommitted
        // task, and the API's own RLS never checked week state on
        // insert (verified: `ops.tasks` `tasks_insert` policy in
        // 20260910120100_core_read_only_accounts.sql has no week-state
        // clause at all), so a closed week silently accepted one and it
        // rendered in today's Backlog regardless of the week it was
        // tagged with (2026-09-10 regression, defect #2).
        //
        // A previous pass here "fixed" that by falling back to the most
        // recent non-closed week when the current one was closed — but
        // that is the same bug in a smaller costume: the fallback week
        // is never THIS week, so a task created with no explanation
        // landed in an older week the person never chose (Chan,
        // 2026-09-11: "when creating a task it falls into last week
        // instead of this week"). A silently wrong week is worse than an
        // empty picker. So: preselect the current week ONLY when it can
        // actually take a task. When it can't — closed, or not created
        // yet — leave the field empty, and the message block below says
        // exactly why. The person picks a week themselves; nothing is
        // ever chosen for them.
        setWeekId(current && current.state !== 'closed' ? current.id : '');
      })
      .catch((err) => {
        if (cancelled) return;
        setListError(err instanceof ApiClientError ? err.message : 'Could not load task types, people or weeks.');
      })
      .finally(() => {
        if (!cancelled) setLoadingLists(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only a week that can actually receive a new task is offered — never
  // a dead option a person could pick and get a silent, wrong result
  // from (see the fetch effect above for why).
  const selectableWeeks = weeks.filter((w) => w.state !== 'closed');
  const selectedWeek = weeks.find((w) => w.id === weekId) ?? null;
  // Says WHY nothing was preselected — "closed" and "doesn't exist yet"
  // are different situations and read as different sentences.
  const currentWeekUnavailableReason = !currentWeek
    ? "This week hasn't been created yet."
    : currentWeek.state === 'closed'
      ? "This week is closed and can't take a new task."
      : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !weekId) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/tasks', {
        weekId,
        ownerUserId: ownerId || undefined,
        taskTypeId: typeId || null,
        title: title.trim(),
      });
      toast.success('Task created.');
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create the task');
    } finally {
      setSubmitting(false);
    }
  }

  // `!me?.readOnly` belongs HERE, not only on the button that opens this
  // dialog.
  //
  // Both of today's entry points (`/board`'s New task, twice) already disable
  // themselves for a read-only account, so this is unreachable for ERC and DCA
  // as things stand. It is not speculative all the same: `ops.tasks`'
  // insert policy carries `not core.is_read_only()`, so a Create button that a
  // read-only caller can press is a button the database refuses, and this
  // project's standing rule is that the UI must not offer what the database
  // will refuse. Twice today a screen opened to founders handed a read-only
  // founder a live write precisely because the guard lived one level up --
  // `/admin/settings`' Save and Now's approvals list. This dialog owns the
  // write, so it owns the check; a third entry point that forgets to disable
  // its trigger then costs nothing.
  const readOnly = me?.readOnly ?? false;
  const canSubmit = title.trim().length > 0 && Boolean(weekId) && !loadingLists && !listError && !readOnly;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>

        {listError ? (
          <p className="text-body-sm text-danger">{listError}</p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs doing?"
                autoFocus
                required
                disabled={loadingLists}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>
                Task type <span className="text-micro text-ink-3">— sets the point value</span>
              </Label>
              <TaskTypePicker types={types} value={typeId} onChange={setTypeId} disabled={loadingLists} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-owner">Assignee</Label>
              <Select
                value={ownerId}
                onValueChange={setOwnerId}
                disabled={loadingLists || !isOversight}
              >
                <SelectTrigger id="task-owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {me ? (
                    <SelectItem value={me.id}>
                      {me.email} (you)
                    </SelectItem>
                  ) : null}
                  {members
                    // Read-only accounts (ERC, DCA -- the two other
                    // brokerages' principals) are excluded as owners: a
                    // read-only caller cannot start, submit or clear
                    // anything, so a task assigned to one can never move.
                    // Same reasoning as the block picker and the
                    // scoreboard rail (PLAN.md §11.4 #1).
                    .filter((m) => m.userId && m.userId !== me?.id && !m.readOnly)
                    .map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.name ?? m.email ?? m.userId}
                        {m.position ? ` · ${m.position}` : ''}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {!isOversight ? (
                <p className="text-micro text-ink-3">Only a GM or founder can create a task for someone else.</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-week">Week</Label>
              {/*
                A plain native `<select>`, not the Radix `Select` used
                above — deliberately. Radix's hidden native-`<select>`
                bridge only learns about an `<option>` once its
                `SelectItem` has actually mounted
                (@radix-ui/react-select's `SelectContentImpl`, gated
                behind `open`), and this field is the one Select in the
                dialog that gets a value set PROGRAMMATICALLY (the
                current week) before the user has ever opened it. With
                no matching `<option>` registered yet, the browser
                coerces the bridge select back to `""` and Radix reports
                that as `onValueChange('')` — silently wiping the
                default the instant the fetch resolves (reproduced;
                radix-ui/primitives #1569/#2705). `forceMount` works
                around the registration timing but forces the popper to
                render unpositioned while never open, pushing the rest
                of the form down. A native element has neither problem:
                the browser's own `<option>` matching needs no
                registration step. Styled to match `Input` (DESIGN.md
                §5.2 — height 34, radius 8, `#CBD2E0` border) since
                shadcn has no bare "native select styled as our input"
                primitive to reuse.
              */}
              <select
                id="task-week"
                value={weekId}
                onChange={(e) => setWeekId(e.target.value)}
                disabled={loadingLists || selectableWeeks.length === 0}
                className="h-[34px] w-full rounded-md border border-[#CBD2E0] bg-white px-[10px] text-body text-ink hover:border-[#B7C0D2] focus-visible:border-[#1662E8] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#E8F0FE] disabled:bg-[#F1F3F7] disabled:border-[#E2E6EE] disabled:text-ink-disabled"
              >
                {selectableWeeks.length === 0 ? <option value="">No open week to create a task in</option> : null}
                {!weekId ? <option value="">Pick a week</option> : null}
                {selectableWeeks.map((w) => (
                  <option key={w.id} value={w.id}>
                    {fmtWeekRange(w.week_start, w.week_end)} · {weekStateLabel(w.state)}
                  </option>
                ))}
              </select>
              {weeks.length === 0 && !loadingLists ? (
                <p className="text-micro text-danger">
                  No week has been created yet. Ask a GM or founder to open one from the briefing.
                </p>
              ) : selectableWeeks.length === 0 && !loadingLists ? (
                <p className="text-micro text-danger">
                  Every recent week is closed — a closed week is the finished record of that week and can't take a new
                  task. Ask a GM or founder to open this week from the briefing first.
                </p>
              ) : !weekId && currentWeekUnavailableReason && !loadingLists ? (
                // Never a silent substitute (Chan, 2026-09-11: the task
                // landed in last week). Say why nothing is preselected
                // and hand the person the picker instead.
                <p className="text-micro text-pending">
                  {currentWeekUnavailableReason} Pick a week above, or ask a GM or founder to open this week from the
                  briefing.
                </p>
              ) : null}
            </div>

            {error ? (
              <p role="alert" className="text-label text-danger">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={submitting}
                disabled={!canSubmit}
                title={readOnly ? 'This account is read-only. It can see everything here and change nothing.' : undefined}
              >
                {/* Names the week it will actually use — the submit
                    button is the last honest place to say so before the
                    write happens (never a silent substitute). */}
                {selectedWeek ? `Create task — ${fmtWeekRange(selectedWeek.week_start, selectedWeek.week_end)}` : 'Create task'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
