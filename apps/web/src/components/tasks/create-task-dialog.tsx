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
 * Fields: task type (carries the catalog's point value — picking one is
 * how the task gets priced), title, assignee, week. `weekId` is
 * required by the API; this dialog defaults to the current Manila week
 * (`GET /api/weeks/current`) and falls back to the most recent open/
 * planning week from `GET /api/weeks?limit=8` when the current one
 * hasn't been created yet, same as the briefing's own empty state.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';

interface TaskType {
  id: string;
  name: string;
  category: string;
  default_points: number | null;
  is_active: boolean;
}

interface Member {
  userId: string;
  email: string | null;
  authority: string | null;
  position: string;
  name: string | null;
}

interface Week {
  id: string;
  week_start: string;
  week_end: string;
  state: 'planning' | 'open' | 'closed';
}

export function CreateTaskDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { me } = useAuth();
  const isOversight = me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin';

  const [loadingLists, setLoadingLists] = React.useState(true);
  const [types, setTypes] = React.useState<TaskType[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [weeks, setWeeks] = React.useState<Week[]>([]);
  const [listError, setListError] = React.useState<string | null>(null);

  const [title, setTitle] = React.useState('');
  const [typeId, setTypeId] = React.useState<string>('');
  const [ownerId, setOwnerId] = React.useState<string>(me?.id ?? '');
  const [weekId, setWeekId] = React.useState<string>('');
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
        // A closed week is the finished artifact of that week
        // (docs/AGENT-LESSONS.md §9) — it cannot take a new, uncommitted
        // task, and the API's own RLS never checked week state on
        // insert (verified: `ops.tasks` `tasks_insert` policy in
        // 20260910120100_core_read_only_accounts.sql has no week-state
        // clause at all), so a closed week silently accepted one and it
        // rendered in today's Backlog regardless of the week it was
        // tagged with (2026-09-10 regression, defect #2). Fixing the
        // database guard is out of this pass's lane (routes/tasks.ts and
        // the migration aren't in it — see the coder's report); this
        // dialog does the honest thing it can do on its own side: never
        // offer a week the task couldn't really belong to. Prefer the
        // live current week; a fresh project may not have created it yet
        // (Phase 5's `POST /api/weeks` is oversight-only), so fall back
        // to the most recent NON-CLOSED week — never to `recent[0]`,
        // which can itself be closed right after a rollover.
        const selectable = recent.filter((w) => w.state !== 'closed');
        const fallback = selectable[0];
        const preferred = current && current.state !== 'closed' ? current : undefined;
        setWeekId(preferred?.id ?? fallback?.id ?? '');
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

  const selectedType = types.find((t) => t.id === typeId) ?? null;
  // Only a week that can actually receive a new task is offered — never
  // a dead option a person could pick and get a silent, wrong result
  // from (see the fetch effect above for why).
  const selectableWeeks = weeks.filter((w) => w.state !== 'closed');

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

  const canSubmit = title.trim().length > 0 && Boolean(weekId) && !loadingLists && !listError;

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
              <Label htmlFor="task-type">
                Task type <span className="text-micro text-ink-3">— sets the point value</span>
              </Label>
              <Select value={typeId} onValueChange={setTypeId} disabled={loadingLists}>
                <SelectTrigger id="task-type">
                  <SelectValue placeholder="No catalog type (price it later)" />
                </SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} — {t.default_points ?? '—'} pts
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedType ? (
                <p className="text-micro text-ink-3">
                  {selectedType.category} · {selectedType.default_points ?? 'unpriced'} points
                </p>
              ) : (
                <p className="text-micro text-ink-3">
                  A task needs a catalog type before it can be submitted for approval — this can be set now or from the
                  task later.
                </p>
              )}
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
                    .filter((m) => m.userId && m.userId !== me?.id)
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
                    {w.week_start} – {w.week_end} ({w.state})
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
              <Button type="submit" loading={submitting} disabled={!canSubmit}>
                Create task
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
