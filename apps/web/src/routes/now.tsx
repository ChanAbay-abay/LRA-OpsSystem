/**
 * LRA Global Ops :: `/` — placeholder Now screen
 *
 * PLAN.md Phase 1 asks for a placeholder here, not the real "who is
 * working on what right now" board — that needs tasks, which are Phase
 * 3/7. What this proves today: auth works end to end, and a logged-in
 * member can see the rest of the ops team, which is the Phase 1
 * "demoable" bar (PLAN.md §7).
 */
import * as React from 'react';
import { PageHeader } from '@/components/layout/app-shell';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

interface Member {
  userId: string;
  email: string;
  authority: string;
  position: string;
  name: string;
}

export function NowPage() {
  const { me } = useAuth();
  const [members, setMembers] = React.useState<Member[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    api
      .get<Member[]>('/api/members')
      .then(setMembers)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load team'));
  }, []);

  return (
    <div>
      <PageHeader
        title="Now"
        description="The real 'who is working on what' board arrives with the task board in a later phase. This is the team, once."
      />

      <div className="rounded-lg border border-hairline bg-surface p-5">
        <div className="mb-4 border-b border-hairline pb-4">
          <span className="text-subtitle text-ink">Signed in as</span>
          <p className="text-body text-ink-2">
            {me?.email} · <span className="text-eyebrow text-ink-3">{me?.authority}</span>
          </p>
        </div>

        <h2 className="mb-3 text-eyebrow text-ink-3">The ops team</h2>

        {error ? <p className="text-label text-danger">{error}</p> : null}
        {!members && !error ? <p className="text-body-sm text-ink-3">Loading…</p> : null}
        {members && members.length === 0 ? (
          <p className="text-body-sm text-ink-3">
            Nobody has been provisioned into the ops module yet. Use Provisioning to invite
            the GM, Sales and Broker.
          </p>
        ) : null}

        <ul className="flex flex-col gap-2">
          {members?.map((m) => (
            <li
              key={m.userId}
              className="flex items-center justify-between rounded-md border border-hairline px-3 py-2"
            >
              <div>
                <p className="text-strong text-ink">{m.name}</p>
                <p className="text-body-sm text-ink-3">{m.email}</p>
              </div>
              <span className="text-eyebrow text-ink-3">{m.position}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
