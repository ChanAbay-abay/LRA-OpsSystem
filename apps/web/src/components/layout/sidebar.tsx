/**
 * LRA Global Ops :: Sidebar
 *
 * DESIGN.md §5.8. 240px, navy-900, full height. Active item gets the
 * 2x16 cyan bar — the one place `--cyan` is allowed to appear, always
 * on navy. Phase 1/2 wires only the routes that actually exist; a nav
 * item for an unbuilt screen is a dead link, and DESIGN.md's own rule
 * is that this app should never look like it is further along than it
 * is.
 */
import { NavLink } from 'react-router-dom';
import { Home, UserCog } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
}

export function Sidebar() {
  const { me, signOut } = useAuth();

  const items: NavItem[] = [{ to: '/', label: 'Now', icon: Home, end: true }];
  if (me?.authority === 'admin') {
    items.push({ to: '/admin/users', label: 'Provisioning', icon: UserCog });
  }

  return (
    <aside className="flex h-screen w-sidebar shrink-0 flex-col bg-navy-900 on-navy">
      <div className="flex items-center gap-2 p-4">
        <div className="flex size-6 items-center justify-center rounded bg-brand-600 text-[11px] font-bold text-white">
          L
        </div>
        <span className="text-strong text-white">LRA Ops</span>
      </div>

      <div className="px-3 pt-3 pb-1.5 text-eyebrow text-on-dark-3">Ops</div>
      <nav className="flex flex-col gap-0.5 px-3">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'relative flex h-[34px] items-center gap-2.5 rounded-sm px-2.5 text-body text-on-dark-2',
                'hover:bg-white/[.06] hover:text-white',
                isActive && 'bg-white/10 font-semibold text-white'
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span className="absolute left-0 h-4 w-0.5 rounded-r-sm bg-cyan" aria-hidden />
                )}
                <item.icon className="size-4" aria-hidden />
                {item.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto border-t border-white/10 p-3">
        <div className="mb-2 truncate text-body-sm text-on-dark-2">{me?.email}</div>
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-label text-on-dark-3 hover:text-white"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
