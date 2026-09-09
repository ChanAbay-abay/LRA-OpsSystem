/**
 * LRA Global Ops :: /inbox — notifications
 *
 * DESIGN.md §5.8's popover is the quick-glance version; this route is
 * the full list. Marking read is the only mutation, matching what
 * `core.notifications`' RLS trigger allows.
 */
import { PageHeader } from '@/components/layout/app-shell';
import { ResourceView, SkeletonRows } from '@/components/ui/resource-state';
import { useResource } from '@/lib/use-resource';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Notification {
  id: string;
  title: string;
  message: string;
  link: string | null;
  is_read: boolean;
  created_at: string;
}

export function InboxPage() {
  const { me } = useAuth();
  const resource = useResource((signal) => api.get<Notification[]>('/api/notifications', { signal }), []);
  // `core.notifications`' own update policy refuses a read-only caller
  // (`… and not core.is_read_only()`,
  // supabase/migrations/20260910120100_core_read_only_accounts.sql) — so
  // an unread dot simply never clears for ERC/DCA rather than the click
  // silently failing against the database.
  const readOnly = me?.readOnly ?? false;

  async function markRead(id: string) {
    if (readOnly) return;
    await api.post(`/api/notifications/${id}/read`);
    resource.reload();
  }

  return (
    <div>
      <PageHeader title="Notifications" />
      <ResourceView
        resource={resource}
        skeleton={<SkeletonRows rows={5} height={56} />}
        empty={<p className="rounded-xl border border-hairline bg-surface p-4 text-body-sm text-ink-3">Nothing yet.</p>}
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <div className="rounded-xl border border-hairline bg-surface">
            {rows.map((n) => (
              <button
                key={n.id}
                onClick={() => !n.is_read && markRead(n.id)}
                className={cn('flex w-full flex-col gap-0.5 border-b border-hairline px-4 py-3 text-left last:border-0', !n.is_read && 'bg-[#F2F7FF]')}
              >
                <div className="flex items-center gap-2">
                  {!n.is_read ? <span className="size-1.5 rounded-full bg-brand-600" aria-hidden /> : null}
                  <span className="text-strong text-ink">{n.title}</span>
                  <span className="num text-num-xs ml-auto text-ink-3">{new Date(n.created_at).toLocaleString()}</span>
                </div>
                <p className="text-body-sm text-ink-2">{n.message}</p>
              </button>
            ))}
          </div>
        )}
      </ResourceView>
    </div>
  );
}
