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

/** A row of skeleton blocks matching a table's real row geometry (DESIGN.md §8). */
export function SkeletonRows({ rows = 5, height = 36 }: { rows?: number; height?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="border-b border-hairline px-4 py-2 last:border-0" style={{ height }}>
          <div className="h-full w-full animate-pulse rounded bg-surface-2" style={{ animationDuration: '1.4s' }} />
        </div>
      ))}
    </div>
  );
}

/** Three skeleton cards, the board column's real card height, per DESIGN.md §8. */
export function SkeletonCards({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-[86px] animate-pulse rounded-lg bg-surface-2" style={{ animationDuration: '1.4s' }} />
      ))}
    </div>
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
