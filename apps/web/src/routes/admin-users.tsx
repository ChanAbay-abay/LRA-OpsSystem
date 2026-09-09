/**
 * LRA Global Ops :: /admin/users — provisioning
 *
 * Admin only (Chan). PLAN.md Phase 2: invite the GM, Sales and Broker.
 * The table shows whether each account has ever actually logged in —
 * "the invite was sent" and "they logged in" are different claims, and
 * only the second one counts (PLAN.md Phase 2 verify step).
 */
import * as React from 'react';
import { PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
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

const AUTHORITIES = ['staff', 'gm', 'founder', 'admin'] as const;
const POSITIONS = ['founder', 'gm', 'sales', 'broker', 'hr_officer', 'accounting', 'other'] as const;

interface AdminUserRow {
  id: string;
  email: string;
  authority: (typeof AUTHORITIES)[number];
  is_active: boolean;
  is_clearing_founder: boolean;
  last_login: string | null;
  opsMembership: { position: string; is_active: boolean } | null;
}

export function AdminUsersPage() {
  const resource = useResource(() => api.get<AdminUserRow[]>('/api/admin/users'), []);
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
                  <TableHead>Last login</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.email}</TableCell>
                    <TableCell className="text-eyebrow">{r.authority}</TableCell>
                    <TableCell className="text-eyebrow">{r.opsMembership?.position ?? '—'}</TableCell>
                    <TableCell>{r.is_active ? 'Active' : 'Deactivated'}</TableCell>
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
                    <TableCell className="num text-num-sm">
                      {r.last_login ? new Date(r.last_login).toLocaleString() : 'Never logged in'}
                    </TableCell>
                    <TableCell>
                      <button
                        className="text-label text-ink-3 hover:text-ink"
                        onClick={async () => {
                          await api.patch(`/api/admin/users/${r.id}`, { isActive: !r.is_active });
                          resource.reload();
                        }}
                      >
                        {r.is_active ? 'Deactivate' : 'Activate'}
                      </button>
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

function InviteDialog({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = React.useState('');
  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [authority, setAuthority] = React.useState<(typeof AUTHORITIES)[number]>('staff');
  const [position, setPosition] = React.useState<(typeof POSITIONS)[number]>('other');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/admin/users', { email, firstName, lastName, authority, position });
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
