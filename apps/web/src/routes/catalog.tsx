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
 */
import * as React from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/lib/auth-context';
import { api, ApiClientError } from '@/lib/api';

const FIB = [1, 2, 3, 5, 8, 13, 21];

interface TaskType {
  id: string;
  name: string;
  category: string;
  guideline_note: string;
  default_points: number | null;
  is_recurring: boolean;
  is_active: boolean;
}

export function CatalogPage() {
  const { me } = useAuth();
  const canEdit = me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin';
  const [types, setTypes] = React.useState<TaskType[] | null>(null);
  const [pricing, setPricing] = React.useState<TaskType | null>(null);

  const load = React.useCallback(() => {
    api.get<TaskType[]>('/api/catalog').then(setTypes).catch(() => toast.error('Could not load the catalog'));
  }, []);
  React.useEffect(() => load(), [load]);

  const draftCount = types?.filter((t) => t.default_points == null).length ?? 0;

  return (
    <div>
      <PageHeader title="Task catalog" description="What LRA's work is worth, in the founder's own words." />

      {draftCount > 0 ? (
        <div className="mb-4 rounded-lg border border-[#EBD9AE] bg-[#FCF3E3] px-4 py-3 text-body-sm text-[#8A5A00]">
          {draftCount} of {types?.length} catalog types are still DRAFT and unpriced. Commitments made against a DRAFT value
          are not real commitments — the founder pricing every row here is a gate on the Monday briefing.
        </div>
      ) : null}

      <div className="rounded-xl border border-hairline bg-surface">
        {types?.map((t) => (
          <div key={t.id} className="flex items-start gap-4 border-b border-hairline px-4 py-3 last:border-0">
            <div className="w-28 shrink-0 text-eyebrow text-ink-3">{t.category}</div>
            <div className="flex-1">
              <p className="text-strong text-ink">
                {t.name} {t.is_recurring ? <span className="text-eyebrow text-ink-3">· recurring</span> : null}
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
              <Button variant="secondary" size="sm" onClick={() => setPricing(t)}>
                Price
              </Button>
            ) : null}
          </div>
        ))}
      </div>

      {pricing ? (
        <PriceDialog
          type={pricing}
          onClose={() => setPricing(null)}
          onDone={() => {
            setPricing(null);
            load();
          }}
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
