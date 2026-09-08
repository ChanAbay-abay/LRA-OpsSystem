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

export function LoginPage() {
  const { session, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

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
      </div>
    </div>
  );
}
