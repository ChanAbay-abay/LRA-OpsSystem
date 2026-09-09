/**
 * LRA Global Ops :: /set-password — first-login flow
 *
 * PLAN.md §7 Phase 2 gap. Provisioning (`routes/admin.ts`) uses
 * `inviteUserByEmail`, so an invited person's email link lands them back
 * on this app with a Supabase-issued token in the URL and, before this
 * route existed, nowhere to go — `App.tsx` had no route that consumed
 * it. `lib/supabase.ts`'s client has `detectSessionInUrl: true` by
 * default, so simply mounting on this path is what turns the link's
 * token into a real session; this screen's only job after that is to
 * collect a new password and call `supabase.auth.updateUser`.
 *
 * Two states the SDK hands back that both have to be told apart from a
 * plain "still loading":
 *
 *  1. **A session was established** (the link was valid) — show the
 *     form.
 *  2. **The link carries `#error=...`** (expired, already used, or
 *     malformed — the exact state an invited user is most likely to
 *     hit, since invite links are one-time and easy to double-click or
 *     open from an old email) — show that explicitly, never a bare
 *     spinner or a silent redirect to /login that leaves someone
 *     wondering if they mistyped a password that was never asked for.
 *
 * Deliberately outside `<ProtectedRoute>` (App.tsx) and does not use
 * `useAuth()`/`GET /api/me` — a brand-new invitee's session is the
 * *reason* this screen exists, not a precondition it can assume, and
 * this must render even if `/api/me` is briefly unhappy about a
 * password-recovery-typed token.
 */
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// The project's real password policy (Supabase Auth settings on the
// hosted project — not `supabase/config.toml`'s `minimum_password_length
// = 6`, which is the *local* dev stack's default and does not describe
// what the hosted Auth server will actually accept). Checked client-side
// so the requirements are visible before submit; the server's own
// refusal is still rendered verbatim if it disagrees, per DESIGN.md §8
// ("every server message is surfaced verbatim").
const REQUIREMENTS: { key: string; label: string; test: (p: string) => boolean }[] = [
  { key: 'length', label: 'At least 10 characters', test: (p) => p.length >= 10 },
  { key: 'lower', label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) },
  { key: 'upper', label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { key: 'digit', label: 'A number', test: (p) => /[0-9]/.test(p) },
];

/** Supabase puts recovery/invite failures in the URL hash, e.g. `#error=access_denied&error_code=otp_expired&error_description=...`. */
function readUrlError(): string | null {
  const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(raw || window.location.search);
  const description = params.get('error_description');
  if (description) return description.replace(/\+/g, ' ');
  if (params.get('error')) return 'This link is invalid.';
  return null;
}

type Screen = 'checking' | 'form' | 'invalid' | 'done';

export function SetPasswordPage() {
  const navigate = useNavigate();
  const [screen, setScreen] = React.useState<Screen>('checking');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [touchedConfirm, setTouchedConfirm] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const urlError = readUrlError();
    if (urlError) {
      setScreen('invalid');
      return;
    }

    // `detectSessionInUrl` resolves the invite/recovery token
    // asynchronously. A `PASSWORD_RECOVERY` event fires once that's
    // done; `getSession()` covers the case where it already resolved
    // before this effect subscribed (invite links redirect through a
    // full page load, so this is the common case, not an edge one).
    let settled = false;
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (settled) return;
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) {
        settled = true;
        setScreen('form');
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      if (settled) return;
      if (data.session) {
        settled = true;
        setScreen('form');
      }
    });

    // No token in the URL and no session ever showed up — this is not
    // "still checking", it's a link with nothing usable in it (opened
    // directly, or the token was stripped by an email client's link
    // scanner). Give it a couple of seconds for the async exchange
    // above before concluding that.
    const timer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        setScreen('invalid');
      }
    }, 4000);

    return () => {
      sub.subscription.unsubscribe();
      window.clearTimeout(timer);
    };
  }, []);

  const failing = REQUIREMENTS.filter((r) => !r.test(password));
  const passwordOk = failing.length === 0;
  const confirmOk = confirm.length > 0 && confirm === password;
  const canSubmit = passwordOk && confirmOk && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouchedConfirm(true);
    if (!passwordOk || !confirmOk) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setScreen('done');
      toast.success('Password set. You are signed in.');
      window.setTimeout(() => navigate('/', { replace: true }), 900);
    } catch (err) {
      // The database/Auth server's own message, verbatim — DESIGN.md §8.
      setServerError(err instanceof Error ? err.message : 'Could not set the password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-[400px] rounded-lg border border-hairline bg-surface p-5">
        <div className="mb-5 flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded bg-brand-600 text-[12px] font-bold text-white">
            L
          </div>
          <span className="text-subtitle text-ink">LRA Ops</span>
        </div>

        {screen === 'checking' ? (
          <p className="text-body-sm text-ink-3">Checking your invite link…</p>
        ) : null}

        {screen === 'invalid' ? (
          <div className="flex flex-col gap-3">
            <p className="text-subtitle text-ink">This link is invalid or has expired</p>
            <p className="text-body-sm text-ink-2">
              Invite and password-reset links only work once and expire after a while. Ask whoever provisioned your
              account (Chan) to send a new invite, or use{' '}
              <a href="/login" className="text-brand-700 underline">
                the sign-in page
              </a>{' '}
              if you already have a password.
            </p>
          </div>
        ) : null}

        {screen === 'done' ? <p className="text-body-sm text-ink-2">Signing you in…</p> : null}

        {screen === 'form' ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-body-sm text-ink-2">Set a password for your account to finish signing in.</p>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                invalid={password.length > 0 && !passwordOk}
              />
              <ul className="mt-1 flex flex-col gap-1">
                {REQUIREMENTS.map((r) => {
                  const met = r.test(password);
                  return (
                    <li
                      key={r.key}
                      className={cn(
                        'flex items-center gap-1.5 text-micro',
                        met ? 'text-cleared' : 'text-ink-3'
                      )}
                    >
                      {met ? (
                        <Check className="size-3" aria-hidden />
                      ) : (
                        <X className="size-3" aria-hidden />
                      )}
                      {r.label}
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onBlur={() => setTouchedConfirm(true)}
                invalid={touchedConfirm && confirm.length > 0 && !confirmOk}
              />
              {touchedConfirm && confirm.length > 0 && !confirmOk ? (
                <p className="text-label text-danger">Passwords don’t match.</p>
              ) : null}
            </div>

            {serverError ? (
              <p role="alert" className="text-label text-danger">
                {serverError}
              </p>
            ) : null}

            <Button type="submit" size="default" loading={submitting} disabled={!canSubmit} className="w-full">
              Set password and continue
            </Button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
