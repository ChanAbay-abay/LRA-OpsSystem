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
 *
 * The shell owns the viewport (`h-screen overflow-hidden`) and `<main>`
 * is the only scroller (Chan, 2026-09-09). The sidebar is navigation:
 * it has to stay put while a long board or briefing scrolls past it,
 * the same way it does in Linear or Notion.
 */
import type { ReactNode } from 'react';
import { MobileSidebarTrigger, Sidebar } from './sidebar';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas md:flex-row">
      <Sidebar />
      <MobileSidebarTrigger />
      {/*
        `min-h-0` is what actually makes the scroll happen HERE and not
        on the document (Chan: "when scrolling, it scrolls the whole
        page … it should just scroll the right section, not the nav on
        the left"). A flex child's default `min-height: auto` refuses to
        shrink below its content, so `overflow-y-auto` on it never has
        anything to scroll and the overflow escapes to the page — taking
        the sidebar with it. The wrapper above is `h-screen
        overflow-hidden` so there is no page scroll left to escape to.
      */}
      <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/*
          `h-full` so a route that wants to own the viewport can. The shell
          already claims to (`h-screen overflow-hidden` above), but this
          wrapper was content-sized, so a route asking for `h-full` resolved
          against its own content instead of the screen and got nothing.
          `/board` needs it: its lane scroller must be the vertical scroll
          container for `position: sticky` lane headers to have anything to
          stick to (DESIGN.md §13).

          Safe for every other route: with `border-box` sizing this is exactly
          `<main>`'s height, and a page taller than that simply overflows the
          wrapper and is scrolled by `<main>` as before -- verified on
          /scoreboard, /briefing and /points, which are all taller than one
          screen.
        */}
        <div className="mx-auto h-full max-w-app px-6 py-6 lg:px-8">{children}</div>
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
