/**
 * LRA Global Ops :: shared loading / unreachable / error / empty states
 *
 * DESIGN.md §8: skeletons that match the real layout's geometry (never
 * a centred spinner), a panel-level danger band with the server's own
 * message and a Retry, and `0` vs `—` kept honest. Paired with
 * `lib/use-resource.ts` so every screen renders the same four states
 * instead of a bespoke "Loading…" string each.
 *
 * `unreachable` gets its own, more prominent treatment than `error`
 * (DESIGN.md's ordinary panel-level error band) because it means the
 * whole system is down, not just this one request -- Chan's ask was
 * explicit: say so plainly, offer Retry, and say how to reach the
 * developer. `chanabayabay@gmail.com` is Chan's own address; he is the
 * system's operator (`core.authority = 'admin'`) as well as its
 * developer, so it is also the correct contact for "something is
 * broken," not just a placeholder.
 */
import type { ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Resource } from '@/lib/use-resource';

const DEV_CONTACT_EMAIL = 'chanabayabay@gmail.com';

export function UnreachablePanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-danger-border bg-danger-wash px-6 py-12 text-center"
    >
      <AlertTriangle className="size-6 text-danger" aria-hidden />
      <p className="text-strong text-ink">The LRA Ops server can't be reached</p>
      <p className="max-w-md text-body-sm text-ink-2">
        {message} This isn't something you did — the app will keep working as soon as the connection is back.
      </p>
      <div className="mt-1 flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCcw className="size-3.5" aria-hidden />
          Retry
        </Button>
        <a
          href={`mailto:${DEV_CONTACT_EMAIL}?subject=${encodeURIComponent('LRA Ops is unreachable')}`}
          className="text-label text-brand-700 underline underline-offset-2"
        >
          Contact the developer
        </a>
      </div>
    </div>
  );
}

/**
 * The server answered, and the answer is no.
 *
 * Deliberately NOT `UnreachablePanel`. That one says the connection is
 * the problem and the app will start working again on its own; for a
 * 403 both halves are false. Driven 2026-09-10 against a deactivated
 * account, which was shown "The LRA Ops server can't be reached" while
 * the server was answering `403 Account is deactivated` in 600ms.
 *
 * So: the server's own sentence, no Retry (there is nothing to retry --
 * the account is the problem, and only somebody with admin can change
 * that), and a way out of the dead session instead.
 */
export function RefusedPanel({ message, onSignOut }: { message: string; onSignOut: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-danger-border bg-danger-wash px-6 py-12 text-center"
    >
      <AlertTriangle className="size-6 text-danger" aria-hidden />
      <p className="text-strong text-ink">{message}</p>
      <p className="max-w-md text-body-sm text-ink-2">
        The server answered — this is not a connection problem, and waiting will not change it.
        Ask a GM, founder or admin at LRA to check your account.
      </p>
      <div className="mt-1 flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={onSignOut}>
          Sign out
        </Button>
        <a
          href={`mailto:${DEV_CONTACT_EMAIL}?subject=${encodeURIComponent('LRA Ops account access')}`}
          className="text-label text-brand-700 underline underline-offset-2"
        >
          Contact the developer
        </a>
      </div>
    </div>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-danger-border bg-danger-wash px-4 py-3">
      <p className="text-body-sm text-ink">{message}</p>
      <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
        <RotateCcw className="size-3.5" aria-hidden />
        Retry
      </Button>
    </div>
  );
}

/**
 * A row of skeleton blocks matching a table's real row geometry
 * (DESIGN.md §8). The inner bar is inset and radiused rather than a
 * full-bleed rectangle so the placeholder reads as the same family of
 * shapes as the rows it stands in for -- Chan's "round the corners or
 * something to match the container".
 */
export function SkeletonRows({ rows = 5, height = 36 }: { rows?: number; height?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center border-b border-hairline px-4 py-2 last:border-0" style={{ height }}>
          <div
            className="skeleton-pulse h-[60%] w-full rounded-md bg-surface-2"
            style={{ animationDelay: `${i * 90}ms`, maxWidth: `${88 - (i % 3) * 12}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Board-column placeholders. These used to be flat `bg-surface-2`
 * blocks sitting inside a `bg-surface-2` column -- the same colour as
 * the thing behind them, which is exactly the "ghosting" Chan is
 * describing. They now carry the real card's own geometry: white
 * surface, hairline border, `rounded-lg`, and three inset bars where a
 * card's eyebrow / title / footer actually sit.
 */
export function SkeletonCards({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-2 rounded-lg border border-hairline bg-surface p-3"
          style={{ opacity: 1 - i * 0.15 }}
        >
          <div className="skeleton-pulse h-2 w-10 rounded-xs bg-surface-3" style={{ animationDelay: `${i * 90}ms` }} />
          <div className="skeleton-pulse h-3 w-full rounded-xs bg-surface-2" style={{ animationDelay: `${i * 90 + 60}ms` }} />
          <div className="skeleton-pulse h-3 w-3/5 rounded-xs bg-surface-2" style={{ animationDelay: `${i * 90 + 120}ms` }} />
          <div className="mt-1 flex items-center justify-between">
            <div className="skeleton-pulse size-5 rounded-full bg-surface-3" style={{ animationDelay: `${i * 90}ms` }} />
            <div className="skeleton-pulse h-3 w-6 rounded-xs bg-surface-2" style={{ animationDelay: `${i * 90 + 60}ms` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A full board placeholder: the real column chrome (rounded shell,
 * header, count pill) with skeleton cards inside it, so the first paint
 * is the board's own geometry and the real data lands into a layout
 * that is already the right shape instead of replacing a different one.
 */
export function SkeletonBoard({ columns = 7 }: { columns?: number }) {
  return (
    <>
      {/* The filter toolbar's own footprint, so the columns don't jump
          up the page the moment the data lands. */}
      <div className="mb-4 flex items-center gap-2" aria-hidden>
        <div className="skeleton-pulse h-[34px] w-[260px] rounded-md bg-surface-2" />
        <div className="skeleton-pulse h-[34px] w-[216px] rounded-md bg-surface-2" style={{ animationDelay: '80ms' }} />
      </div>
      <div className="flex gap-3 overflow-hidden pb-4" aria-hidden>
      {Array.from({ length: columns }).map((_, i) => (
        <div key={i} className="flex w-column shrink-0 flex-col gap-2 rounded-xl bg-surface-2 p-2">
          <div className="flex items-center justify-between px-2 py-1">
            <div className="skeleton-pulse h-2.5 w-16 rounded-xs bg-surface-3" style={{ animationDelay: `${i * 70}ms` }} />
            <div className="skeleton-pulse h-2.5 w-4 rounded-xs bg-surface-3" style={{ animationDelay: `${i * 70}ms` }} />
          </div>
          <SkeletonCards count={i < 4 ? 3 : 2} />
        </div>
      ))}
      </div>
    </>
  );
}

/**
 * The generic wrapper: given a `Resource<T>`, renders the right one of
 * loading/unreachable/error/ready. `skeleton` should mirror the real
 * layout's geometry (DESIGN.md §8) -- pass `<SkeletonRows />` /
 * `<SkeletonCards />` or a bespoke skeleton for anything shaped
 * differently (the balance panel, the board's columns).
 */
export function ResourceView<T>({
  resource,
  skeleton,
  empty,
  isEmpty,
  children,
}: {
  resource: Resource<T>;
  skeleton: ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (resource.status === 'loading') return <>{skeleton}</>;
  if (resource.status === 'unreachable') return <UnreachablePanel message={resource.message ?? ''} onRetry={resource.reload} />;
  if (resource.status === 'error') return <ErrorPanel message={resource.message ?? 'Something went wrong.'} onRetry={resource.reload} />;
  if (resource.data == null) return <>{skeleton}</>;
  if (empty && isEmpty?.(resource.data)) return <>{empty}</>;
  return <>{children(resource.data)}</>;
}
