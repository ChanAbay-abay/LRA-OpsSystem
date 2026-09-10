/**
 * LRA Global Ops :: the briefing's Commit step — DESIGN.md §21 / §16.4
 *
 * Step 4 of 4: each person picks this week's work. Extracted out of
 * `routes/briefing.tsx` (it was an inline function there) because this
 * pass adds real behaviour to it — a below-`md` collapsible per person
 * (§16.4) and the "No backlog work to pick from" empty-state fix
 * (§21.3, "the single biggest unaided-usage fix on the screen") — and
 * both are big enough to want their own file and their own tests later.
 *
 * The below-`md` / at-or-above-`md` split is a real fork in what mounts,
 * not a CSS toggle: DESIGN.md is explicit that "a collapsible with a
 * dead trigger is worse than no collapsible," so above `md` this
 * renders the body unconditionally with no Radix Collapsible in the
 * tree at all, and below `md` every person is a real `Collapsible` with
 * the reader's own card open by default.
 */
import * as React from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { CheckCircle2, ChevronDown, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { CreateTaskDialog } from '@/components/tasks/create-task-dialog';
import { initials } from '@/lib/task-types';
import { useMediaQuery } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';

export interface CommitCandidateTask {
  id: string;
  title: string;
  status: string;
  catalog_points: number | null;
  points_override: number | null;
  committed_points: number | null;
}

export interface CommitRosterPerson {
  userId: string;
  name: string | null;
  position: string;
}

export function CommitSection({
  roster,
  candidates,
  committed,
  locked,
  meId,
  isOversight,
  readOnly,
  onCommit,
  onUncommit,
  onTaskCreated,
}: {
  roster: CommitRosterPerson[];
  candidates: Record<string, CommitCandidateTask[]>;
  committed: Record<string, CommitCandidateTask[]>;
  locked: boolean;
  meId?: string;
  isOversight: boolean;
  readOnly: boolean;
  onCommit: (taskId: string) => void;
  onUncommit: (taskId: string) => void;
  /** A task was created from the "No backlog work to pick from" fix — reload the briefing. */
  onTaskCreated: () => void;
}) {
  const visibleRoster = roster.filter((r) => r.position !== 'other');
  // Below `md` the grid becomes one collapsible per person — see the
  // module comment for why this is a real fork, not a CSS hide.
  const stacked = !useMediaQuery('(min-width: 768px)');
  const [newTaskFor, setNewTaskFor] = React.useState<CommitRosterPerson | null>(null);

  return (
    <section>
      {locked ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-pending-border bg-pending-wash px-4 py-3">
          <Lock className="mt-0.5 size-4 shrink-0 text-pending" aria-hidden />
          <div>
            <p className="text-body font-medium text-ink">Commitments are locked for this week.</p>
            <p className="text-body-sm text-ink-2">
              Monday's record can't be changed. A GM can suggest edits below; the founder or admin approves them.
            </p>
          </div>
        </div>
      ) : null}
      <div className={cn('grid grid-cols-1 gap-4', stacked ? 'gap-3' : 'md:grid-cols-2 lg:grid-cols-3')}>
        {visibleRoster.map((person) => {
          // Two different questions, kept separate on purpose
          // (task-permissions.ts's rule, already used elsewhere on this
          // screen: "absence for a whole meaningless surface, a reason
          // for a control inside a screen they legitimately read"):
          //
          // `relevant` — is this row's commit control ever this
          // person's business at all? A staff bystander has no
          // plausible reason to touch a colleague's row, so the control
          // is simply absent there, same as before.
          //
          // `canAct` — given it IS their business (oversight, or their
          // own row), can they actually use it right now? A read-only
          // founder (ERC/DCA) reads every card exactly like a real
          // founder would, so the control stays VISIBLE — just disabled,
          // with the reason — instead of vanishing the way it does for
          // an unrelated bystander. `locked` still removes it outright:
          // the top-of-section banner already states that reason once,
          // and repeating it on every row would be noise.
          const relevant = isOversight || person.userId === meId;
          const canAct = relevant && !readOnly && !locked;
          const disabledReason = relevant && !locked && readOnly ? 'Your account is read-only.' : undefined;
          const theirCommitted = committed[person.userId] ?? [];
          const theirCandidates = candidates[person.userId] ?? [];
          const total = theirCommitted.reduce((sum, t) => sum + (t.committed_points ?? 0), 0);
          const isMe = person.userId === meId;

          const body = (
            <CommitPersonBody
              committed={theirCommitted}
              candidates={theirCandidates}
              canAct={canAct}
              disabledReason={disabledReason}
              onCommit={onCommit}
              onUncommit={onUncommit}
              onRequestNewTask={() => setNewTaskFor(person)}
            />
          );

          if (!stacked) {
            return (
              <div key={person.userId} className="rounded-xl border border-hairline bg-surface p-4">
                <CommitPersonHeader name={person.name} total={total} />
                {body}
              </div>
            );
          }

          return (
            <CollapsiblePrimitive.Root
              key={person.userId}
              // The reader's own card is open by default; everyone
              // else's starts closed (§16.4).
              defaultOpen={isMe}
              className="overflow-hidden rounded-xl border border-hairline bg-surface"
            >
              <CollapsiblePrimitive.Trigger className="flex w-full items-center justify-between gap-3 p-4 text-left">
                <CommitPersonHeader name={person.name} total={total} compact />
                <ChevronDown
                  className="size-4 shrink-0 text-ink-3 transition-transform duration-fast data-[state=open]:rotate-180"
                  aria-hidden
                />
              </CollapsiblePrimitive.Trigger>
              <CollapsiblePrimitive.Content className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
                <div className="px-4 pb-4">{body}</div>
              </CollapsiblePrimitive.Content>
            </CollapsiblePrimitive.Root>
          );
        })}
      </div>

      {newTaskFor ? (
        <CreateTaskDialog
          onClose={() => setNewTaskFor(null)}
          onCreated={onTaskCreated}
          defaultOwnerId={newTaskFor.userId}
        />
      ) : null}
    </section>
  );
}

function CommitPersonHeader({ name, total, compact }: { name: string | null; total: number; compact?: boolean }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', compact ? '' : 'mb-2 justify-between')}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-navy-800 text-micro text-on-dark">
          {initials(name)}
        </span>
        <p className="truncate text-strong text-ink">{name}</p>
      </div>
      <span className="num text-num-md shrink-0 text-ink-2">{total}</span>
    </div>
  );
}

function CommitPersonBody({
  committed,
  candidates,
  canAct,
  disabledReason,
  onCommit,
  onUncommit,
  onRequestNewTask,
}: {
  committed: CommitCandidateTask[];
  candidates: CommitCandidateTask[];
  canAct: boolean;
  /** Set when the row is relevant to this reader but not `canAct` for a stateable reason (read-only) — renders disabled, not absent. */
  disabledReason?: string;
  onCommit: (taskId: string) => void;
  onUncommit: (taskId: string) => void;
  onRequestNewTask: () => void;
}) {
  return (
    <>
      <p className="mb-1 text-eyebrow text-ink-3">Committed</p>
      {committed.length === 0 ? (
        <p className="mb-3 text-body-sm text-ink-3">Nothing committed yet. Pick from the candidates below.</p>
      ) : (
        <ul className="mb-3 flex flex-col gap-1">
          {committed.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 text-body-sm">
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                <CheckCircle2 className="size-3.5 shrink-0 text-cleared" aria-hidden />
                <span className="truncate">{t.title}</span>
              </span>
              {canAct ? (
                <button
                  type="button"
                  className="shrink-0 text-label text-ink-3 underline"
                  onClick={() => onUncommit(t.id)}
                >
                  Uncommit
                </button>
              ) : disabledReason ? (
                <Hint text={disabledReason}>
                  <button type="button" disabled className="shrink-0 text-label text-ink-disabled underline">
                    Uncommit
                  </button>
                </Hint>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="mb-1 text-eyebrow text-ink-3">Candidates</p>
      {candidates.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-body-sm text-ink-3">No backlog work to pick from.</p>
          {/*
            DESIGN.md §21.3: "This is the single biggest unaided-usage
            fix on the screen — today it is a dead end phrased in
            schema." Only offered where a commit could actually be
            made; a bystander with no stake in this row gets nothing,
            same as every other control on it, and a read-only reader
            gets the same disabled-with-reason treatment as Commit
            below rather than a button that would just 403.
          */}
          {canAct ? (
            <Button variant="secondary" size="sm" onClick={onRequestNewTask}>
              New task
            </Button>
          ) : disabledReason ? (
            <Hint text={disabledReason}>
              <Button variant="secondary" size="sm" disabled>
                New task
              </Button>
            </Hint>
          ) : null}
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {candidates.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 text-body-sm">
              <span className="min-w-0 truncate">{t.title}</span>
              {canAct ? (
                <Hint text="Move this into your committed work for the week.">
                  <Button size="sm" variant="secondary" onClick={() => onCommit(t.id)}>
                    Commit
                  </Button>
                </Hint>
              ) : disabledReason ? (
                <Hint text={disabledReason}>
                  <Button size="sm" variant="secondary" disabled>
                    Commit
                  </Button>
                </Hint>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
