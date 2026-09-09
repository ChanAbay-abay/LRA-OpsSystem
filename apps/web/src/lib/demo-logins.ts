/**
 * LRA Global Ops :: demo-account quick switch (dev only)
 *
 * Chan: "in the login screen, add a button to just try the different
 * accounts." These are throwaway test accounts and will be deleted, so
 * this is gated hard in two independent ways and either alone is
 * enough to keep it out of a production build:
 *
 *   1. `import.meta.env.DEV` — Vite statically replaces this with the
 *      literal `false` in a production build, so `parseDemoLogins()`'s
 *      entire body below is dead code a production `vite build` tree-
 *      shakes away. Nothing here reaches `dist/`.
 *   2. Even in dev, only an email ending in `@ops-demo.invalid` is ever
 *      returned — a stray real credential in `VITE_DEMO_LOGINS` would
 *      be silently dropped, not rendered as a button.
 *
 * Passwords come from `VITE_DEMO_LOGINS`, a JSON object mapping email to
 * password (see `.env.example`). If the var is unset or malformed, this
 * returns an empty list and the login screen simply renders no demo
 * buttons — never a broken screen, never a fallback credential.
 */

export interface DemoLogin {
  email: string;
  password: string;
}

const DEMO_EMAIL_SUFFIX = '@ops-demo.invalid';

/**
 * Names that are acronyms rather than words, so title-casing them reads
 * wrong ("Erc", "Dca", "Gm"). ERC and DCA are the two other brokerages,
 * whose principals get read-only observer accounts.
 */
const ACRONYMS = new Set(['gm', 'erc', 'dca']);

/** Best-effort label from the local part of a demo email, e.g. "founder-demo" -> "Founder". */
function labelFor(email: string): string {
  const local = email.split('@')[0] ?? email;
  const word = local.split('-')[0] ?? local;
  if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function getDemoLogins(): (DemoLogin & { label: string })[] {
  if (!import.meta.env.DEV) return [];

  const raw = import.meta.env.VITE_DEMO_LOGINS as string | undefined;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[demo-logins] VITE_DEMO_LOGINS is not valid JSON — no demo buttons rendered.');
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null) return [];

  return Object.entries(parsed as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[0].toLowerCase().endsWith(DEMO_EMAIL_SUFFIX)
    )
    .map(([email, password]) => ({ email, password, label: labelFor(email) }));
}
