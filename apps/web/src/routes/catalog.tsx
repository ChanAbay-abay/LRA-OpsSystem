/**
 * LRA Global Ops :: /catalog — the task catalog
 *
 * PRD.md §3.3 / OPEN-QUESTIONS.md #3: every seeded type ships DRAFT with
 * no point value. This screen is where a real number replaces that —
 * "the catalog is the company's written statement of what it values",
 * so pricing is a deliberate act (a dedicated dialog, not an inline
 * click-to-edit), and the DRAFT banner stays up for as long as any row
 * is still unpriced. Read by every ops member; only GM/founder/admin see
 * the price/edit controls, matching `ops.task_types` RLS exactly.
 *
 * Chan: "keep those task types for now... add an option where you can
 * CRUD the task types incase there are more repeating ones." This
 * revision adds full type management (create/edit/deactivate) and a
 * Recurring Templates section, per `core.position`. "Delete" means
 * deactivate (`is_active = false`) — never a hard delete — EXCEPT when
 * a type or template has never been used by any task, in which case a
 * real DELETE is offered with its own confirmation, backed by
 * `ops.delete_task_type_if_unused` / `ops.delete_recurring_template_if_unused`
 * (the DB checks the reference count itself; the UI cannot bypass it).
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, Plus, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';

const FIB = [1, 2, 3, 5, 8, 13, 21];
const POSITIONS = ['founder', 'gm', 'sales', 'broker', 'hr_officer', 'accounting', 'other'] as const;

interface TaskType {
  id: string;
  name: string;
  category: string;
  guideline_note: string;
  default_points: number | null;
  is_recurring: boolean;
  is_active: boolean;
}

interface RecurringTemplate {
  id: string;
  position: (typeof POSITIONS)[number];
  task_type_id: string;
  title: string;
  description: string | null;
  is_active: boolean;
  task_type: { id: string; name: string; default_points: number | null } | null;
}

export function CatalogPage() {
  const { me } = useAuth();
  const canEdit = me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin';

  const typesResource = useResource(() => api.get<TaskType[]>('/api/catalog'), []);
  const templatesResource = useResource(() => api.get<RecurringTemplate[]>('/api/catalog/recurring'), []);

  const [pricing, setPricing] = React.useState<TaskType | null>(null);
  const [editingType, setEditingType] = React.useState<TaskType | 'new' | null>(null);
  const [deletingType, setDeletingType] = React.useState<TaskType | null>(null);
  const [editingTemplate, setEditingTemplate] = React.useState<RecurringTemplate | 'new' | null>(null);
  const [deletingTemplate, setDeletingTemplate] = React.useState<RecurringTemplate | null>(null);

  const types = typesResource.data;
  const draftCount = types?.filter((t) => t.is_active && t.default_points == null).length ?? 0;

  async function toggleActive(t: TaskType) {
    try {
      await api.patch(`/api/catalog/${t.id}`, { isActive: !t.is_active });
      typesResource.reload();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not update the type');
    }
  }

  async function toggleTemplateActive(t: RecurringTemplate) {
    try {
      await api.patch(`/api/catalog/recurring/${t.id}`, { isActive: !t.is_active });
      templatesResource.reload();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not update the template');
    }
  }

  return (
    <div>
      <PageHeader
        title="Task catalog"
        description="What LRA's work is worth, in the founder's own words."
        actions={
          canEdit ? (
            <Button onClick={() => setEditingType('new')}>
              <Plus className="size-4" aria-hidden />
              New task type
            </Button>
          ) : undefined
        }
      />

      {draftCount > 0 ? (
        <div className="mb-4 rounded-lg border border-[#EBD9AE] bg-[#FCF3E3] px-4 py-3 text-body-sm text-[#8A5A00]">
          {draftCount} of {types?.length} catalog types are still DRAFT and unpriced. Commitments made against a DRAFT value
          are not real commitments — the founder pricing every row here is a gate on the Monday briefing.
        </div>
      ) : null}

      <ResourceView
        resource={typesResource}
        skeleton={<SkeletonRows rows={6} height={56} />}
        empty={<p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">No task types yet.</p>}
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <div className="rounded-xl border border-hairline bg-surface">
            {rows.map((t) => (
              <div key={t.id} className={`flex items-start gap-4 border-b border-hairline px-4 py-3 last:border-0 ${!t.is_active ? 'opacity-60' : ''}`}>
                <div className="w-28 shrink-0 text-eyebrow text-ink-3">{t.category}</div>
                <div className="flex-1">
                  <p className="text-strong text-ink">
                    {t.name} {t.is_recurring ? <span className="text-eyebrow text-ink-3">· recurring</span> : null}
                    {!t.is_active ? <span className="ml-2 text-eyebrow text-danger">· deactivated</span> : null}
                  </p>
                  <p className="text-body-sm text-ink-3">{t.guideline_note}</p>
                </div>
                <div className="flex w-20 shrink-0 items-center justify-end">
                  {t.default_points != null ? (
                    <span className="num text-num-md text-ink">{t.default_points}</span>
                  ) : (
                    <span className="num text-num-sm text-pending">DRAFT</span>
                  )}
                </div>
                {canEdit ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="secondary" size="sm" onClick={() => setPricing(t)}>
                      Price
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingType(t)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title={t.is_active ? 'Deactivate' : 'Reactivate'}
                      onClick={() => toggleActive(t)}
                    >
                      {t.is_active ? <Archive className="size-4" aria-hidden /> : <ArchiveRestore className="size-4" aria-hidden />}
                    </Button>
                    <Button variant="ghost" size="sm" title="Delete permanently (only if never used)" onClick={() => setDeletingType(t)}>
                      <Trash2 className="size-4 text-danger" aria-hidden />
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </ResourceView>

      <div className="mt-8 mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-subtitle text-ink">Recurring templates</h2>
          <p className="text-body-sm text-ink-3">One weekly task per active member holding that position — this is where a new repeating item is added.</p>
        </div>
        {canEdit ? (
          <Button variant="secondary" onClick={() => setEditingTemplate('new')}>
            <Plus className="size-4" aria-hidden />
            New template
          </Button>
        ) : null}
      </div>

      <ResourceView
        resource={templatesResource}
        skeleton={<SkeletonRows rows={3} height={56} />}
        empty={<p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">No recurring templates yet.</p>}
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <div className="rounded-xl border border-hairline bg-surface">
            {rows.map((t) => (
              <div key={t.id} className={`flex items-start gap-4 border-b border-hairline px-4 py-3 last:border-0 ${!t.is_active ? 'opacity-60' : ''}`}>
                <div className="w-28 shrink-0 text-eyebrow text-ink-3">{t.position}</div>
                <div className="flex-1">
                  <p className="text-strong text-ink">
                    {t.title}
                    {!t.is_active ? <span className="ml-2 text-eyebrow text-danger">· deactivated</span> : null}
                  </p>
                  <p className="text-body-sm text-ink-3">
                    {t.task_type?.name ?? 'unknown type'} · {t.task_type?.default_points ?? 'DRAFT'} pts
                  </p>
                </div>
                {canEdit ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => setEditingTemplate(t)}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" title={t.is_active ? 'Deactivate' : 'Reactivate'} onClick={() => toggleTemplateActive(t)}>
                      {t.is_active ? <Archive className="size-4" aria-hidden /> : <ArchiveRestore className="size-4" aria-hidden />}
                    </Button>
                    <Button variant="ghost" size="sm" title="Delete permanently (only if never used)" onClick={() => setDeletingTemplate(t)}>
                      <Trash2 className="size-4 text-danger" aria-hidden />
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </ResourceView>

      {pricing ? (
        <PriceDialog type={pricing} onClose={() => setPricing(null)} onDone={() => { setPricing(null); typesResource.reload(); }} />
      ) : null}

      {editingType ? (
        <TypeDialog
          type={editingType === 'new' ? null : editingType}
          onClose={() => setEditingType(null)}
          onDone={() => { setEditingType(null); typesResource.reload(); }}
        />
      ) : null}

      {deletingType ? (
        <DeleteDialog
          label={`task type "${deletingType.name}"`}
          onClose={() => setDeletingType(null)}
          onConfirm={() => api.delete(`/api/catalog/${deletingType.id}`)}
          onDone={() => { setDeletingType(null); typesResource.reload(); }}
        />
      ) : null}

      {editingTemplate ? (
        <TemplateDialog
          template={editingTemplate === 'new' ? null : editingTemplate}
          types={types ?? []}
          onClose={() => setEditingTemplate(null)}
          onDone={() => { setEditingTemplate(null); templatesResource.reload(); }}
        />
      ) : null}

      {deletingTemplate ? (
        <DeleteDialog
          label={`recurring template "${deletingTemplate.title}"`}
          onClose={() => setDeletingTemplate(null)}
          onConfirm={() => api.delete(`/api/catalog/recurring/${deletingTemplate.id}`)}
          onDone={() => { setDeletingTemplate(null); templatesResource.reload(); }}
        />
      ) : null}
    </div>
  );
}

function PriceDialog({ type, onClose, onDone }: { type: TaskType; onClose: () => void; onDone: () => void }) {
  const [points, setPoints] = React.useState<number | null>(type.default_points);
  const [note, setNote] = React.useState(type.guideline_note.replace(/^DRAFT\s*—\s*/, ''));
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.patch(`/api/catalog/${type.id}`, { defaultPoints: points, guidelineNote: note });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Price "{type.name}"</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-1.5 text-label text-ink-2">Points (Fibonacci only)</p>
            <div className="flex flex-wrap gap-1.5">
              {FIB.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPoints(n)}
                  className={`h-8 w-8 rounded-md border text-strong ${points === n ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-hairline-strong text-ink-2 hover:bg-surface-2'}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-label text-ink-2">Guideline note</p>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error ? <p className="text-label text-danger">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={submitting} disabled={points == null || !note.trim()} onClick={submit}>
            Save price
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Full CRUD for a task type — name/category/guideline/points/is_recurring.
// Editing an existing row goes through the same append-only
// `ops.task_type_revisions` trail the price dialog already relies on;
// creating a new one starts DRAFT unless a price is set here directly.
function TypeDialog({ type, onClose, onDone }: { type: TaskType | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = React.useState(type?.name ?? '');
  const [category, setCategory] = React.useState(type?.category ?? '');
  const [note, setNote] = React.useState(type?.guideline_note ?? '');
  const [points, setPoints] = React.useState<number | null>(type?.default_points ?? null);
  const [isRecurring, setIsRecurring] = React.useState(type?.is_recurring ?? false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body = { name, category, guidelineNote: note, defaultPoints: points, isRecurring };
      if (type) {
        await api.patch(`/api/catalog/${type.id}`, body);
      } else {
        await api.post('/api/catalog', body);
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save the task type');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{type ? `Edit "${type.name}"` : 'New task type'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Category</Label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Brokerage, Sales, Admin" />
          </div>
          <div>
            <Label>Guideline note (required)</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What this value means at LRA" />
          </div>
          <div>
            <p className="mb-1.5 text-label text-ink-2">Points (leave unset for DRAFT)</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setPoints(null)}
                className={`h-8 rounded-md border px-2 text-label ${points == null ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-hairline-strong text-ink-2 hover:bg-surface-2'}`}
              >
                DRAFT
              </button>
              {FIB.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPoints(n)}
                  className={`h-8 w-8 rounded-md border text-strong ${points === n ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-hairline-strong text-ink-2 hover:bg-surface-2'}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-body-sm text-ink-2">
            <input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
            Recurring (used by weekly templates)
          </label>
          {error ? <p className="text-label text-danger">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={submitting} disabled={!name.trim() || !category.trim() || !note.trim()} onClick={submit}>
            {type ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Full CRUD for a recurring template, keyed on core.position — "add an
// option ... incase there are more repeating ones" is exactly this.
function TemplateDialog({
  template,
  types,
  onClose,
  onDone,
}: {
  template: RecurringTemplate | null;
  types: TaskType[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [position, setPosition] = React.useState<(typeof POSITIONS)[number]>(template?.position ?? 'other');
  const [taskTypeId, setTaskTypeId] = React.useState(template?.task_type_id ?? types.find((t) => t.is_active)?.id ?? '');
  const [title, setTitle] = React.useState(template?.title ?? '');
  const [description, setDescription] = React.useState(template?.description ?? '');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const activeTypes = types.filter((t) => t.is_active || t.id === taskTypeId);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body = { position, taskTypeId, title, description: description || undefined };
      if (template) {
        await api.patch(`/api/catalog/recurring/${template.id}`, body);
      } else {
        await api.post('/api/catalog/recurring', body);
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save the template');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{template ? `Edit "${template.title}"` : 'New recurring template'}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div>
            <Label>Position</Label>
            <Select value={position} onValueChange={(v) => setPosition(v as (typeof POSITIONS)[number])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POSITIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Task type</Label>
            <Select value={taskTypeId} onValueChange={setTaskTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a task type" />
              </SelectTrigger>
              <SelectContent>
                {activeTypes.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.default_points ?? 'DRAFT'})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly billing and collection" />
          </div>
          <div>
            <Label>Description (optional)</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {error ? <p className="text-label text-danger">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={submitting} disabled={!title.trim() || !taskTypeId} onClick={submit}>
            {template ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Shared confirm for the hard-delete path. The button is always
// offered — Chan's ask was to offer it only when unused, but the
// cheapest honest way to enforce "only if unused" is to let the
// database's own check decide and surface its refusal verbatim, rather
// than have the client guess reference counts and be wrong under a
// race. Confirmed here; the DB is still the real gate.
function DeleteDialog({
  label,
  onClose,
  onConfirm,
  onDone,
}: {
  label: string;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
  onDone: () => void;
}) {
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Could not delete this — it may already have been used by a task.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Permanently delete {label}?</DialogTitle>
        </DialogHeader>
        <p className="text-body-sm text-ink-3">
          This is a real, permanent delete — not a deactivation. It only succeeds if no task has ever referenced this row; if
          it has, deactivate it instead.
        </p>
        {error ? <p className="text-label text-danger">{error}</p> : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" loading={submitting} onClick={submit}>
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
