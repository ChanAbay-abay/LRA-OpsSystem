/**
 * LRA Global Ops :: App
 *
 * Every route here is a screen that actually exists — wiring a nav item
 * or a route for an unbuilt screen is the "looks further along than it
 * is" failure DESIGN.md warns against. PLAN.md §4 lists the full MVP
 * route set; `/scoreboard` and `/people/:id` (Phase 8) shipped in this
 * session.
 */
import { Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/layout/app-shell';
import { SkeletonRows } from '@/components/ui/resource-state';
import { LoginPage } from '@/routes/login';
import { SetPasswordPage } from '@/routes/set-password';
import { NowPage } from '@/routes/now';
import { BoardPage } from '@/routes/board';
import { BriefingPage } from '@/routes/briefing';
import { PointsPage } from '@/routes/points';
import { QueuePage } from '@/routes/queue';
import { FounderDigest } from '@/routes/founder-digest';
import { ScoreboardPage } from '@/routes/scoreboard';
import { PersonPage } from '@/routes/person';
import { InboxPage } from '@/routes/inbox';
import { CatalogPage } from '@/routes/catalog';
import { AdminUsersPage } from '@/routes/admin-users';
import { AdminSettingsPage } from '@/routes/admin-settings';
import { AdminAuditPage } from '@/routes/admin-audit';
import { AdminEverythingPage } from '@/routes/admin-everything';

/**
 * The app's own boot placeholder. It used to be a bare centred
 * "Loading…" on an empty page, which is a different layout from the one
 * that replaces it — so the first paint after sign-in was a jump from
 * nothing to a full shell. This is the shell's silhouette instead: the
 * navy sidebar column and a content skeleton in the same places the
 * real ones land.
 */
function ShellSkeleton() {
  return (
    <div className="flex h-screen overflow-hidden bg-canvas" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading LRA Ops…</span>
      <div className="hidden w-sidebar shrink-0 flex-col gap-1 bg-navy-900 p-3 md:flex" aria-hidden>
        <div className="mb-4 flex items-center gap-2 p-1">
          <div className="flex size-6 items-center justify-center rounded bg-brand-600 text-[11px] font-bold text-white">L</div>
          <span className="text-strong text-white">LRA Ops</span>
        </div>
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="skeleton-pulse h-[34px] rounded-sm bg-white/[.06]"
            style={{ animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
      <main className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto max-w-app px-6 py-6 lg:px-8">
          <div className="skeleton-pulse mb-2 h-6 w-48 rounded-md bg-surface-2" aria-hidden />
          <div className="skeleton-pulse mb-5 h-3 w-72 rounded-xs bg-surface-2" style={{ animationDelay: '80ms' }} aria-hidden />
          <SkeletonRows rows={5} height={44} />
        </div>
      </main>
    </div>
  );
}

function ProtectedRoute({
  children,
  requireAdmin = false,
  requireOversight = false,
  requireFounder = false,
}: {
  children: React.ReactNode;
  requireAdmin?: boolean;
  /**
   * gm/founder/admin only. `/queue` reads `GET /api/points/queue`,
   * which is `requireOversight()` server-side — without this guard a
   * Sales or Broker who types the URL (or follows a stale link) lands
   * on a 403 error panel for a screen that was never theirs. Chan's
   * ask: approvals should not exist at all for the people who do not
   * approve, not merely fail for them.
   */
  requireOversight?: boolean;
  /**
   * founder/admin only. `/admin/settings` is `requireAuthority('founder',
   * 'admin')` server-side (`settings.ts`) and `ops.settings`'s RLS
   * update policy is `core.is_founder()`, which already includes admin
   * — so a plain `requireAdmin` here was stricter than both server
   * layers and left a founder with no path to a screen the server
   * grants them. This is per-route, not a change to `requireAdmin`
   * itself: `/admin/users`, `/admin/audit` and `/admin/everything` are
   * genuinely admin-only (`admin.ts`'s whole router is
   * `requireAuthority('admin')`) and stay on `requireAdmin`.
   */
  requireFounder?: boolean;
}) {
  const { session, me, loading } = useAuth();

  if (loading) return <ShellSkeleton />;
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  // `me` is still in flight for a beat after the session settles; the
  // shell skeleton is the honest answer, not a redirect on a role we
  // have not read yet.
  if ((requireAdmin || requireOversight || requireFounder) && !me) return <ShellSkeleton />;
  if (requireAdmin && me?.authority !== 'admin') {
    return <Navigate to="/" replace />;
  }
  if (requireOversight && !['gm', 'founder', 'admin'].includes(me?.authority ?? '')) {
    return <Navigate to="/" replace />;
  }
  if (requireFounder && !['founder', 'admin'].includes(me?.authority ?? '')) {
    return <Navigate to="/" replace />;
  }

  return <AppShell>{children}</AppShell>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <NowPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/board"
        element={
          <ProtectedRoute>
            <BoardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/briefing"
        element={
          <ProtectedRoute>
            <BriefingPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/points"
        element={
          <ProtectedRoute>
            <PointsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/queue"
        element={
          <ProtectedRoute requireOversight>
            <QueuePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/digest"
        element={
          <ProtectedRoute requireOversight>
            <FounderDigest />
          </ProtectedRoute>
        }
      />
      <Route
        path="/scoreboard"
        element={
          <ProtectedRoute>
            <ScoreboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/people/:id"
        element={
          <ProtectedRoute>
            <PersonPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/inbox"
        element={
          <ProtectedRoute>
            <InboxPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/catalog"
        element={
          <ProtectedRoute>
            <CatalogPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/users"
        element={
          <ProtectedRoute requireAdmin>
            <AdminUsersPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/settings"
        element={
          <ProtectedRoute requireFounder>
            <AdminSettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/audit"
        element={
          <ProtectedRoute requireAdmin>
            <AdminAuditPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/everything"
        element={
          <ProtectedRoute requireAdmin>
            <AdminEverythingPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Toaster position="bottom-right" />
      <AppRoutes />
    </AuthProvider>
  );
}
