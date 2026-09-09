/**
 * LRA Global Ops :: App shell
 *
 * DESIGN.md §5.8. Sidebar + a scrollable content column capped at
 * `max-w-app` (1440px). The week context strip described in the same
 * section depends on `GET /api/weeks/current`, which is Phase 3 API
 * surface — deferred until that route exists rather than shipped
 * against fake data.
 *
 * DESIGN.md:1144 (defect #2) — below 768px the persistent `<aside>`
 * (`Sidebar`) hides itself and `MobileSidebarTrigger`'s top bar takes
 * over instead; exactly one renders at any given width, both driven by
 * the same `md:` breakpoint so they can never both show or both hide.
 *
 * `overflow-x-hidden` alongside `overflow-y-auto` (tester defect,
 * 2026-09-09): per the CSS overflow spec a non-`visible` `overflow-y`
 * on its own computes `overflow-x: auto`, so a row anywhere below that
 * is even a few pixels wider than the content column would silently
 * scroll *inside* `<main>` with no visible scrollbar, instead of either
 * fitting or visibly breaking. That is exactly how the catalog's action
 * buttons at 768px went missing — reachable only via a horizontal
 * scroll nobody could see was there. Individual pages now own fitting
 * their own content to the column (see routes/catalog.tsx); `<main>`
 * itself no longer offers an invisible horizontal escape hatch to hide
 * the next instance of that bug.
 */
import type { ReactNode } from 'react';
import { MobileSidebarTrigger, Sidebar } from './sidebar';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas md:flex-row">
      <Sidebar />
      <MobileSidebarTrigger />
      <main className="flex-1 overflow-y-auto overflow-x-hidden">
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
