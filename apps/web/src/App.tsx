/**
 * LRA Global Ops :: App
 *
 * Route table is deliberately short in Phase 1/2 — PLAN.md §4 lists the
 * full MVP route set, but wiring a nav item or a route for a screen
 * that doesn't exist yet is exactly the "looks further along than it
 * is" failure DESIGN.md warns against. Only `/login`, `/` (placeholder)
 * and `/admin/users` are real.
 */
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/layout/app-shell';
import { LoginPage } from '@/routes/login';
import { NowPage } from '@/routes/now';
import { AdminUsersPage } from '@/routes/admin-users';

function ProtectedRoute({
  children,
  requireAdmin = false,
}: {
  children: React.ReactNode;
  requireAdmin?: boolean;
}) {
  const { session, me, loading } = useAuth();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-body-sm text-ink-3">Loading…</div>;
  }
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (requireAdmin && me?.authority !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return <AppShell>{children}</AppShell>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <NowPage />
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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
