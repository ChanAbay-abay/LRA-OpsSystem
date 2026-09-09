/**
 * LRA Global Ops :: /login
 *
 * Supabase `signInWithPassword` in the browser (PLAN.md §1) — the API
 * never sees a password, only the resulting bearer token.
 */
import * as React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getDemoLogins } from '@/lib/demo-logins';

export function LoginPage() {
  const { session, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [switching, setSwitching] = React.useState<string | null>(null);
  // Computed once per mount, not per render — cheap either way, but this
  // reads clearer as "the fixed set this dev session has available".
  const demoLogins = React.useMemo(() => getDemoLogins(), []);

  if (session) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleDemoSignIn(demoEmail: string, demoPassword: string) {
    setError(null);
    setSwitching(demoEmail);
    try {
      await signIn(demoEmail, demoPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setSwitching(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="w-full max-w-[360px] rounded-lg border border-hairline bg-surface p-5">
        <div className="mb-5 flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded bg-brand-600 text-[12px] font-bold text-white">
            L
          </div>
          <span className="text-subtitle text-ink">LRA Ops</span>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error ? (
            <p role="alert" className="text-label text-danger">
              {error}
            </p>
          ) : null}

          <Button type="submit" size="default" loading={loading} className="w-full">
            Sign in
          </Button>
        </form>

        <DemoLoginPanel logins={demoLogins} switching={switching} onSelect={handleDemoSignIn} />
      </div>
    </div>
  );
}

/**
 * Split out on purpose, not inlined as a ternary in `LoginPage`. Vite
 * replaces `import.meta.env.DEV` with the literal `false` at build
 * time; an early `return null` gated on that literal is exactly the
 * shape esbuild's dead-code elimination collapses a whole function
 * body behind (the same fold `getDemoLogins()` relies on) — so in a
 * production build this becomes `function DemoLoginPanel(){return
 * null}` with the label text and button markup below it removed
 * entirely, not just left unreachable. A ternary keyed on
 * `demoLogins.length` (a runtime value) does NOT get this treatment:
 * esbuild cannot prove a runtime array's length is always zero, so the
 * markup would survive, inert, inside `dist/` — which is what the
 * first version of this file shipped and where an audit caught it.
 */
function DemoLoginPanel({
  logins,
  switching,
  onSelect,
}: {
  logins: ReturnType<typeof getDemoLogins>;
  switching: string | null;
  onSelect: (email: string, password: string) => void;
}) {
  if (!import.meta.env.DEV) return null;
  if (logins.length === 0) return null;

  return (
    <div className="mt-5 border-t border-hairline pt-4">
      <p className="text-eyebrow text-ink-3">Demo accounts — dev only, not a product feature</p>
      <div className="mt-2.5 flex flex-col gap-1.5">
        {logins.map((d) => (
          <Button
            key={d.email}
            type="button"
            variant="secondary"
            size="sm"
            className="w-full justify-between"
            loading={switching === d.email}
            disabled={switching !== null && switching !== d.email}
            onClick={() => onSelect(d.email, d.password)}
          >
            <span>{d.label}</span>
            <span className="text-ink-3">{d.email}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
