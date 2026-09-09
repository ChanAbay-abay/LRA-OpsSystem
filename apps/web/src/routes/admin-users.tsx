/**
 * LRA Global Ops :: /admin/users — provisioning
 *
 * Admin only (Chan). PLAN.md Phase 2: invite the GM, Sales and Broker.
 * The table shows whether each account has ever actually logged in —
 * "the invite was sent" and "they logged in" are different claims, and
 * only the second one counts (PLAN.md Phase 2 verify step).
 *
 * Delete/restore, added later: soft delete is immediate (the database
 * refuses a deleted account access the moment it happens — this UI is
 * a convenience, not the enforcement) and reversible for 14 days. The
 * confirm dialog states the exact purge date so nobody clicks it not
 * knowing what "delete" means here; deleted rows render distinctly with
 * a days-remaining countdown and a Restore action, using DESIGN.md's
 * existing `danger` semantic token — no new colour invented for this.
 *
 * Read-only accounts (ERC, DCA — OPEN-QUESTIONS.md #5), added later
 * still: `core.users.read_only` is the real guard (every write policy
 * and definer function refuses one — see
 * 20260910120100_core_read_only_accounts.sql), so this UI's job is only
 * to make the flag visible and settable, never to imply it's the
 * enforcement. An observer who looks like a full founder is the actual
 * failure mode here, so the badge sits directly next to Authority
 * rather than in a column someone would have to go looking for, and it
 * repeats in the invite dialog so ERC/DCA are never provisioned as a
 * silent afterthought. DESIGN.md's `info` semantic token, same pattern
 * `board.tsx`'s Chip already uses for a non-alarming, deliberate state
 * — read-only isn't an error, so it doesn't borrow `danger`.
 */
import * as React from 'react';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { api, ApiClientError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const AUTHORITIES = ['staff', 'gm', 'founder', 'admin'] as const;
const POSITIONS = ['founder', 'gm', 'sales', 'broker', 'hr_officer', 'accounting', 'other'] as const;

interface AdminUserRow {
  id: string;
  email: string;
  authority: (typeof AUTHORITIES)[number];
  is_active: boolean;
  is_clearing_founder: boolean;
  read_only: boolean;
  last_login: string | null;
  deleted_at: string | null;
  purge_due_at: string | null;
  opsMembership: { position: string; is_active: boolean } | null;
}

/** DESIGN.md's `info` semantic token — a deliberate, non-alarming state, not an error. Same pattern as `board.tsx`'s Chip. */
function ReadOnlyBadge() {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-xs border border-info-border bg-info-wash px-[7px] text-label text-info">
      Read-only
    </span>
  );
}

/** Whole days remaining until purge, floored — "0 days left" still reads as "today", never negative. */
function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

/** Display-only estimate for the confirm dialog, before the real `purge_due_at` exists server-side. */
function estimatedPurgeDateLabel(): string {
  return new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function AdminUsersPage() {
  const { me } = useAuth();
  const resource = useResource((signal) => api.get<AdminUserRow[]>('/api/admin/users', { signal }), []);
  const [open, setOpen] = React.useState(false);

  return (
    <div>
      <PageHeader
        title="Provisioning"
        description="Invite the GM, Sales and Broker. Re-running an invite is safe — it repairs missing rows instead of duplicating."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>Invite</Button>
            </DialogTrigger>
            <InviteDialog
              onDone={() => {
                setOpen(false);
                resource.reload();
              }}
            />
          </Dialog>
        }
      />

      <ResourceView
        resource={resource}
        skeleton={<SkeletonRows rows={4} height={44} />}
        empty={
          <div className="rounded-lg border border-hairline bg-surface p-4 text-center text-body-sm text-ink-3">
            Nobody invited yet.
          </div>
        }
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <div className="rounded-lg border border-hairline bg-surface p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Authority</TableHead>
                  <TableHead>Position</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Clearing founder</TableHead>
                  <TableHead>Read-only</TableHead>
                  <TableHead>Last login</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.email}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="text-eyebrow">{r.authority}</span>
                        {r.read_only ? <ReadOnlyBadge /> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-eyebrow">{r.opsMembership?.position ?? '—'}</TableCell>
                    <TableCell>
                      {r.deleted_at && r.purge_due_at ? (
                        <span className="inline-flex h-5 items-center gap-1 rounded-xs border border-danger-border bg-danger-wash px-[7px] text-label text-danger">
                          Deleted — purges in {daysUntil(r.purge_due_at)}d
                        </span>
                      ) : r.is_active ? (
                        'Active'
                      ) : (
                        'Deactivated'
                      )}
                    </TableCell>
                    <TableCell>
                      {r.authority === 'founder' ? (
                        <button
                          className={`text-label ${r.is_clearing_founder ? 'text-cleared' : 'text-ink-3 hover:text-ink'}`}
                          onClick={async () => {
                            await api.patch(`/api/admin/users/${r.id}`, { isClearingFounder: !r.is_clearing_founder });
                            resource.reload();
                          }}
                        >
                          {r.is_clearing_founder ? 'Yes — the seat' : 'Make the clearing founder'}
                        </button>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <ReadOnlyToggle row={r} onDone={() => resource.reload()} />
                    </TableCell>
                    <TableCell className="num text-num-sm">
                      {r.last_login ? new Date(r.last_login).toLocaleString() : 'Never logged in'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-3">
                        {r.deleted_at ? (
                          <button
                            className="text-label text-ink-3 hover:text-ink"
                            onClick={async () => {
                              await api.post(`/api/admin/users/${r.id}/restore`, {});
                              resource.reload();
                            }}
                          >
                            Restore
                          </button>
                        ) : (
                          <>
                            <button
                              className="text-label text-ink-3 hover:text-ink"
                              onClick={async () => {
                                await api.patch(`/api/admin/users/${r.id}`, { isActive: !r.is_active });
                                resource.reload();
                              }}
                            >
                              {r.is_active ? 'Deactivate' : 'Activate'}
                            </button>
                            {r.id !== me?.id ? (
                              <DeleteAccountAction row={r} onDone={() => resource.reload()} />
                            ) : null}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </ResourceView>
    </div>
  );
}

/**
 * Toggling read-only either way is a permission change on the
 * highest-privilege class of account (three founders, per
 * OPEN-QUESTIONS.md #5) — confirmed the same way delete is, with the
 * dialog stating plainly what the new state means rather than leaving
 * a bare "Make read-only" to speak for itself.
 */
function ReadOnlyToggle({ row, onDone }: { row: AdminUserRow; onDone: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      await api.patch(`/api/admin/users/${row.id}`, { readOnly: !row.read_only });
      setOpen(false);
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not change read-only status');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className={`text-label ${row.read_only ? 'text-info' : 'text-ink-3 hover:text-ink'}`}>
          {row.read_only ? 'Yes — remove' : 'Make read-only'}
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {row.read_only ? `Remove read-only from ${row.email}?` : `Make ${row.email} read-only?`}
          </DialogTitle>
          <DialogDescription>
            {row.read_only ? (
              <>
                {row.email} will be able to submit, verify, clear, commit and change data again —
                exactly like any other account at their authority level. Only do this if they are
                no longer meant to be a strictly-observing account.
              </>
            ) : (
              <>
                {row.email} will keep seeing everything oversight sees, but every write —
                submitting, verifying, clearing, committing, overriding points, editing the
                catalog, all of it — will be refused by the database. This is the ERC/DCA shape:
                an account that watches the business without being able to act in it.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-label text-danger">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button loading={submitting} onClick={handleConfirm}>
            {row.read_only ? 'Remove read-only' : 'Make read-only'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = React.useState('');
  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [authority, setAuthority] = React.useState<(typeof AUTHORITIES)[number]>('staff');
  const [position, setPosition] = React.useState<(typeof POSITIONS)[number]>('other');
  const [readOnly, setReadOnly] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/admin/users', { email, firstName, lastName, authority, position, readOnly });
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Invite failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Invite a teammate</DialogTitle>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="firstName">First name</Label>
            <Input id="firstName" required value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lastName">Last name</Label>
            <Input id="lastName" required value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Authority</Label>
            <Select value={authority} onValueChange={(v) => setAuthority(v as typeof authority)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTHORITIES.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Ops position</Label>
            <Select value={position} onValueChange={(v) => setPosition(v as typeof position)}>
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
        </div>

        {authority === 'founder' ? (
          <label className="flex items-start gap-2.5 rounded-lg border border-info-border bg-info-wash px-3 py-2.5">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
              className="mt-0.5 size-3.5 accent-info"
            />
            <span className="text-body-sm text-ink-2">
              <span className="font-medium text-ink">Read-only (ERC / DCA).</span> Sees everything
              oversight sees; every write is refused by the database. Use this for a brokerage that
              only keeps tabs — not the clearing founder.
            </span>
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="text-label text-danger">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="submit" loading={submitting}>
            Send invite
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * Delete, with a confirmation that states plainly what happens and
 * when — "delete" here means immediate loss of access plus a 14-day
 * restore window, not instant erasure, and the dialog says so rather
 * than leaving "Delete" to speak for itself.
 */
function DeleteAccountAction({ row, onDone }: { row: AdminUserRow; onDone: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Lazy initializer, not a bare call in the render body: React only
  // ever runs this once, on mount, which is both what we want (the
  // dialog is only open for a few seconds; the actual 14-day guarantee
  // comes from the database trigger, this is display copy only) and
  // what satisfies oxlint's react(purity) check for `Date.now()`.
  const [purgeDate] = React.useState(() => estimatedPurgeDateLabel());

  async function handleDelete() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/admin/users/${row.id}/delete`, {});
      setOpen(false);
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Delete failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="text-label text-danger hover:text-[#9C201A]">Delete</button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {row.email}?</DialogTitle>
          <DialogDescription>
            Access ends immediately — {row.email} will not be able to sign in again after you
            confirm. Their tasks, points and history are kept exactly as they are, and you can
            restore this account any time in the next 14 days. If nobody restores it, it is{' '}
            <strong className="text-ink">permanently purged on {purgeDate}</strong>: their login
            is removed and their name and email are erased, but their work stays attributed to
            this account forever.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-label text-danger">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" loading={submitting} onClick={handleDelete}>
            Delete account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
