/**
 * LRA Global Ops :: the briefing's first-run "what is this" — DESIGN.md §21.5
 *
 * "On first visit to `/briefing` with no `localStorage['lra.seen.briefing.v1']`,
 * the `<WhatIsThis>` popover opens automatically… It never re-opens on its
 * own; the icon stays for later."
 *
 * Honest limitation, per the spec: this is per-browser, not per-user.
 * Clearing site data re-shows it. That is acceptable for four users and
 * does not justify a `core.people` column.
 *
 * Both functions degrade rather than throw. Safari private mode (and any
 * browser with storage disabled by policy) throws on `localStorage`
 * access itself, not just on writes — `getItem`/`setItem` both wrapped.
 * A read that throws is treated as "not seen yet" so the popover still
 * does its job once; a write that throws simply never persists, so the
 * popover opens again next visit instead of the app crashing.
 */

const STORAGE_KEY = 'lra.seen.briefing.v1';

export function hasSeenBriefingIntro(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markBriefingIntroSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Private mode or storage disabled: nothing to persist. The popover
    // will simply open again next visit — a minor repeat, not a crash.
  }
}
