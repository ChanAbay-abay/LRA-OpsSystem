/**
 * LRA Global Ops :: "Request a change" — a GM's proposed edit to a locked task
 *
 * PLAN.md §10.1 / Chan: "GM can flag for edits with the founder (LRA) or
 * admin (me) approving the edits." Posts straight to
 * `POST /api/task-edit-requests` (routes/task-edit-requests.ts's
 * `createSchema`) — field PRESENCE is what proposes a change there
 * (`.optional()` on the zod schema, all the way down to `change_*` on the
 * DB row), so each field's checkbox literally decides whether its key is
 * sent at all, not just whether its value differs from what is on the
 * task today. Unchecked fields are never sent, so a GM can propose a
 * single field without silently re-asserting the other four.
 *
 * It must be obvious this is a proposal, not an edit: nothing here writes
 * to the task, the submit button reads "Send request", the intro line
 * says who decides, and every field shows what it would replace right
 * next to the input.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ReasonTextarea } from '@/components/ui/reason-textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, ApiClientError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

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

export interface LockedTask {
  id: string;
  title: string;
  description: string | null;
  task_type_id: string | null;
  owner_user_id: string;
  client_ref: string | null;
}

export function TaskEditRequestDialog({
  task,
  onClose,
  onCreated,
}: {
  task: LockedTask;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { me } = useAuth();
  const [loadingLists, setLoadingLists] = React.useState(true);
  const [types, setTypes] = React.useState<TaskType[]>([]);
  const [members, setMembers] = React.useState<Member[]>([]);
  const [listError, setListError] = React.useState<string | null>(null);

  const [changeTitle, setChangeTitle] = React.useState(false);
  const [title, setTitle] = React.useState(task.title);
  const [changeDescription, setChangeDescription] = React.useState(false);
  const [description, setDescription] = React.useState(task.description ?? '');
  const [changeType, setChangeType] = React.useState(false);
  const [typeId, setTypeId] = React.useState(task.task_type_id ?? '');
  const [changeOwner, setChangeOwner] = React.useState(false);
  const [ownerId, setOwnerId] = React.useState(task.owner_user_id);
  const [changeClientRef, setChangeClientRef] = React.useState(false);
  const [clientRef, setClientRef] = React.useState(task.client_ref ?? '');

  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([api.get<TaskType[]>('/api/catalog'), api.get<Member[]>('/api/members')])
      .then(([allTypes, roster]) => {
        if (cancelled) return;
        setTypes(allTypes.filter((t) => t.is_active));
        setMembers(roster);
      })
      .catch((err) => {
        if (cancelled) return;
        setListError(err instanceof ApiClientError ? err.message : 'Could not load task types or people.');
      })
      .finally(() => {
        if (!cancelled) setLoadingLists(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const anyChange = changeTitle || changeDescription || changeType || changeOwner || changeClientRef;
  const reasonReady = reason.trim().length >= 10;
  const titleReady = !changeTitle || title.trim().length > 0;
  const canSubmit = anyChange && reasonReady && titleReady && !loadingLists && !listError;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { taskId: task.id, reason: reason.trim() };
      if (changeTitle) body.title = title.trim();
      if (changeDescription) body.description = description.trim() ? description.trim() : null;
      if (changeType) body.taskTypeId = typeId || null;
      if (changeOwner) body.ownerUserId = ownerId;
      if (changeClientRef) body.clientRef = clientRef.trim() ? clientRef.trim() : null;
      await api.post('/api/task-edit-requests', body);
      toast.success('Change request sent — the clearing founder will decide it.');
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not send the request');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] w-[min(560px,92vw)] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="pr-6">Request a change — "{task.title}"</DialogTitle>
        </DialogHeader>
        <p className="text-body-sm text-ink-2">
          This task's definition is locked for the week. You're <strong className="text-ink">proposing</strong> a
          change, not making it — the clearing founder or admin decides, and nothing here changes the task until
          they approve it. Toggle only the fields you want to change.
        </p>

        {listError ? (
          <p className="text-body-sm text-danger">{listError}</p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <FieldRow label="Title" checked={changeTitle} onCheck={setChangeTitle} current={task.title}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={loadingLists} />
            </FieldRow>

            <FieldRow
              label="Description"
              checked={changeDescription}
              onCheck={setChangeDescription}
              current={task.description || '—'}
            >
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={loadingLists}
                placeholder="Leave blank to clear the description"
                className="min-h-[70px] w-full rounded-md border border-hairline-strong bg-white px-[10px] py-2 text-body text-ink placeholder:text-ink-3 focus-visible:border-brand-600 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-100"
              />
            </FieldRow>

            <FieldRow
              label="Catalog type"
              checked={changeType}
              onCheck={setChangeType}
              current={types.find((t) => t.id === task.task_type_id)?.name ?? 'No catalog type'}
            >
              <Select value={typeId} onValueChange={setTypeId} disabled={loadingLists}>
                <SelectTrigger>
                  <SelectValue placeholder="No catalog type" />
                </SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} — {t.default_points ?? '—'} pts
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>

            <FieldRow
              label="Owner"
              checked={changeOwner}
              onCheck={setChangeOwner}
              current={
                members.find((m) => m.userId === task.owner_user_id)?.name ??
                (task.owner_user_id === me?.id ? 'You' : 'Unknown')
              }
            >
              <Select value={ownerId} onValueChange={setOwnerId} disabled={loadingLists}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {me ? <SelectItem value={me.id}>{me.email} (you)</SelectItem> : null}
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
            </FieldRow>

            <FieldRow
              label="Client reference"
              checked={changeClientRef}
              onCheck={setChangeClientRef}
              current={task.client_ref || '—'}
            >
              <Input
                value={clientRef}
                onChange={(e) => setClientRef(e.target.value)}
                disabled={loadingLists}
                placeholder="Leave blank to clear"
              />
            </FieldRow>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-request-reason">Reason</Label>
              <ReasonTextarea id="edit-request-reason" value={reason} onChange={setReason} placeholder="Why does this need to change?" />
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
                Send request
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FieldRow({
  label,
  checked,
  onCheck,
  current,
  children,
}: {
  label: string;
  checked: boolean;
  onCheck: (v: boolean) => void;
  current: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-surface-2 p-3">
      <label className="flex cursor-pointer items-center gap-2 text-body-sm text-ink">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheck(e.target.checked)}
          className="size-4 shrink-0 cursor-pointer accent-brand-600"
        />
        Propose a new {label.toLowerCase()}
        <span className="ml-auto min-w-0 max-w-[220px] truncate text-micro text-ink-3" title={current}>
          now: {current}
        </span>
      </label>
      {checked ? children : null}
    </div>
  );
}
