/**
 * LRA Global Ops :: Sidebar
 *
 * DESIGN.md §5.8. 240px, navy-900, full height. Active item gets the
 * 2x16 cyan bar — the one place `--cyan` is allowed to appear, always
 * on navy. Phase 1/2 wires only the routes that actually exist; a nav
 * item for an unbuilt screen is a dead link, and DESIGN.md's own rule
 * is that this app should never look like it is further along than it
 * is.
 *
 * DESIGN.md:1144 — at <768px this stops being a persistent column and
 * becomes a Radix `Sheet` behind a hamburger (defect #2). `SidebarNav`
 * holds the actual nav markup so both the persistent `<aside>` (≥768px)
 * and the off-canvas `Sheet` (<768px, see `MobileSidebarTrigger`) render
 * the identical content instead of two copies drifting apart.
 */
import * as React from 'react';
import { NavLink } from 'react-router-dom';
import {
  BookOpen,
  ClipboardCheck,
  Coins,
  FileClock,
  Home,
  Inbox,
  KanbanSquare,
  Menu,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { me, signOut } = useAuth();

  const items: NavItem[] = [
    { to: '/', label: 'Now', icon: Home, end: true },
    { to: '/board', label: 'Board', icon: KanbanSquare },
    { to: '/points', label: 'My points', icon: Coins },
    { to: '/inbox', label: 'Inbox', icon: Inbox },
    { to: '/catalog', label: 'Catalog', icon: BookOpen },
  ];
  if (me?.authority === 'gm' || me?.authority === 'founder' || me?.authority === 'admin') {
    items.push({ to: '/queue', label: 'Approvals', icon: ClipboardCheck });
  }

  const adminItems: NavItem[] = [
    { to: '/admin/users', label: 'People & access', icon: UserCog },
    { to: '/admin/settings', label: 'Settings', icon: SlidersHorizontal },
    { to: '/admin/everything', label: 'Everything', icon: FileClock },
    { to: '/admin/audit', label: 'Audit', icon: ShieldCheck },
  ];

  return (
    <div className="flex h-full w-sidebar shrink-0 flex-col bg-navy-900 on-navy">
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
            onClick={onNavigate}
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

      {me?.authority === 'admin' ? (
        <>
          <div className="px-3 pt-4 pb-1.5 text-eyebrow text-on-dark-3">Admin</div>
          <nav className="flex flex-col gap-0.5 px-3">
            {adminItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onNavigate}
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
                    {isActive && <span className="absolute left-0 h-4 w-0.5 rounded-r-sm bg-cyan" aria-hidden />}
                    <item.icon className="size-4" aria-hidden />
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </>
      ) : null}

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
    </div>
  );
}

/** ≥768px: the persistent column. Hidden below that per DESIGN.md:1144. */
export function Sidebar() {
  return (
    <aside className="hidden h-screen shrink-0 md:flex">
      <SidebarNav />
    </aside>
  );
}

/**
 * <768px: a hamburger in a top bar that opens the sidebar as a Radix
 * `Sheet` sliding in from the left, per DESIGN.md:1144. Rendered by
 * `AppShell` alongside (not inside) the persistent `<aside>` so exactly
 * one of the two is visible at any width.
 */
export function MobileSidebarTrigger() {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline bg-navy-900 px-3 on-navy md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label="Open navigation"
            className="flex size-8 items-center justify-center rounded-sm text-white hover:bg-white/[.06]"
          >
            <Menu className="size-5" aria-hidden />
          </button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0">
          <SheetTitle>LRA Ops navigation</SheetTitle>
          <SidebarNav onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex size-6 items-center justify-center rounded bg-brand-600 text-[11px] font-bold text-white">
        L
      </div>
      <span className="text-strong text-white">LRA Ops</span>
    </div>
  );
}
