/**
 * LRA Global Ops :: the GM's suggestion draft — state, survival, and the leave warning
 *
 * Chan asked for "an edit feature like google docs". Two of the things
 * that phrase actually implies are behaviours, not layout, and they live
 * here rather than in a component:
 *
 * - **Leaving with unsubmitted suggestions warns, it does not silently
 *   discard.** `beforeunload` covers a reload, a close and a typed URL.
 *   In-app navigation needs its own answer, because this app mounts
 *   `<BrowserRouter>` (main.tsx) rather than a data router, so
 *   react-router's `useBlocker` is unavailable — it throws outside a
 *   data router. So an in-flight draft installs a capture-phase click
 *   listener that catches a click on any `<a href>` leading off this
 *   route and hands the intended destination back to the caller for a
 *   confirm step. Capture phase and a real DOM listener are deliberate:
 *   PLAN.md §11.6 is the story of React's synthetic events travelling the
 *   fiber tree instead of the DOM tree, and a nav link in a portal or a
 *   sheet would defeat a React-level handler.
 *
 * - **A warning that gets past you still must not destroy work.** The
 *   draft is mirrored into `sessionStorage`, keyed by week, so Back,
 *   Forward, a bypassed prompt or an accidental reload all come back to
 *   the same suggestions instead of an empty form. Nothing here is ever
 *   sent anywhere: `sessionStorage` is this tab only, it is cleared on
 *   submit or discard, and the batch is still written by exactly one
 *   POST. That is the property the Google Docs analogy is really about.
 */
import * as React from 'react';
import {
  EMPTY_SUGGESTIONS,
  hasSuggestions,
  type SuggestionState,
} from '@/lib/edit-suggestions';

const STORAGE_PREFIX = 'lra.ops.editSuggestions.';

function storageKey(weekId: string): string {
  return `${STORAGE_PREFIX}${weekId}`;
}

function read(weekId: string): SuggestionState {
  try {
    const raw = sessionStorage.getItem(storageKey(weekId));
    if (!raw) return EMPTY_SUGGESTIONS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_SUGGESTIONS;
    return parsed as SuggestionState;
  } catch {
    // A draft we cannot parse is a draft we do not have. Never throw on a
    // mount because of a stale storage entry.
    return EMPTY_SUGGESTIONS;
  }
}

export function useSuggestionDraft(weekId: string | undefined) {
  const [draft, setDraft] = React.useState<SuggestionState>(() => (weekId ? read(weekId) : EMPTY_SUGGESTIONS));
  // True only for a draft that came back from storage rather than being
  // typed this visit — the screen says so, so restored suggestions are
  // never mistaken for something the app invented.
  const [restored, setRestored] = React.useState<boolean>(() => (weekId ? hasSuggestions(read(weekId)) : false));

  // A week arriving after mount (the briefing chains two requests) must
  // still pick up that week's own draft.
  const loadedWeek = React.useRef<string | undefined>(weekId);
  React.useEffect(() => {
    if (weekId === loadedWeek.current) return;
    loadedWeek.current = weekId;
    const next = weekId ? read(weekId) : EMPTY_SUGGESTIONS;
    setDraft(next);
    setRestored(hasSuggestions(next));
  }, [weekId]);

  React.useEffect(() => {
    if (!weekId) return;
    try {
      if (hasSuggestions(draft)) sessionStorage.setItem(storageKey(weekId), JSON.stringify(draft));
      else sessionStorage.removeItem(storageKey(weekId));
    } catch {
      // Storage being unavailable (private mode, quota) must not break
      // editing — the draft still lives in React state for this visit.
    }
  }, [draft, weekId]);

  const clear = React.useCallback(() => {
    setDraft(EMPTY_SUGGESTIONS);
    setRestored(false);
  }, []);

  const update = React.useCallback((next: SuggestionState) => {
    setDraft(next);
    setRestored(false);
  }, []);

  return { draft, update, clear, restored, dirty: hasSuggestions(draft) };
}

/**
 * While `active`, warn before the tab goes away and intercept in-app
 * navigation, calling `onLeaveAttempt` with the href that was clicked.
 * Returns nothing; the caller renders the confirm step.
 */
export function useLeaveGuard(active: boolean, onLeaveAttempt: (href: string) => void) {
  // Kept in a ref so the listener below is installed once per `active`
  // change rather than on every render, and updated in an effect rather
  // than during render (a ref written during render is a render side
  // effect, and React's own lint rule is right about that).
  const handler = React.useRef(onLeaveAttempt);
  React.useEffect(() => {
    handler.current = onLeaveAttempt;
  });

  React.useEffect(() => {
    if (!active) return;

    function beforeUnload(e: BeforeUnloadEvent) {
      // The browser shows its own wording; the only thing a page can do
      // is ask for the prompt at all.
      e.preventDefault();
      e.returnValue = '';
    }

    function onClick(e: MouseEvent) {
      // Left click only, and never a modified click — cmd/ctrl-click opens
      // a new tab and leaves this draft exactly where it is.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      // Same-route links (there are none today, but an in-page anchor
      // must never trigger a leave prompt).
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;

      e.preventDefault();
      e.stopPropagation();
      handler.current(url.pathname + url.search);
    }

    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [active]);
}
