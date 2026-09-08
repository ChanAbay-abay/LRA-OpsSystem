/**
 * LRA Global Ops :: App shell
 *
 * DESIGN.md §5.8. Sidebar + a scrollable content column capped at
 * `max-w-app` (1440px). The week context strip described in the same
 * section depends on `GET /api/weeks/current`, which is Phase 3 API
 * surface — deferred until that route exists rather than shipped
 * against fake data.
 */
import type { ReactNode } from 'react';
import { Sidebar } from './sidebar';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-canvas">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-app px-6 py-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-title text-ink">{title}</h1>
        {description ? <p className="mt-1 text-body-sm text-ink-3">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}
