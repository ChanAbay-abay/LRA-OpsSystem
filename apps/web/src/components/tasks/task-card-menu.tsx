/**
 * LRA Global Ops :: the task card's quick-action menu — the rendering half
 *
 * Chan, 2026-09-10 (PLAN.md §10 #2): "tasks should have a quick submit
 * and block button with right click commands and a 3 dot option that
 * opens the same right click." One list of items, decided in exactly
 * one place (`lib/task-menu-items.ts`'s `buildTaskMenuItems`, kept out
 * of this file so it can be unit-tested without React/Radix in the
 * loop), rendered here by two Radix primitives — `ContextMenuPrimitive`
 * for the right-click and `DropdownMenuPrimitive` for the
 * keyboard-reachable 3-dot button. Radix ships these as two separate
 * component trees (a context menu opens at the pointer, a dropdown
 * anchors to a trigger element — they cannot share one DOM subtree), so
 * the two outer shells are unavoidably distinct components; what must
 * never drift, and does not, is the CONTENT: item list, order, labels,
 * icons and enabled state all come from the one shared function.
 */
import * as React from 'react';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { MoreVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskMenuItem } from '@/lib/task-menu-items';

export type { TaskMenuItem, TaskMenuHandlers } from '@/lib/task-menu-items';
export { buildTaskMenuItems } from '@/lib/task-menu-items';

const MENU_CONTENT_CLASS =
  'z-50 min-w-[220px] overflow-hidden rounded-md border border-hairline bg-surface p-1 text-ink shadow-md ' +
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ' +
  'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95';

const MENU_ITEM_CLASS =
  'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-body-sm text-ink outline-none ' +
  'focus:bg-surface-2 data-[disabled]:pointer-events-none data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-disabled';

function MenuItemList({
  items,
  Item,
  Label,
}: {
  items: TaskMenuItem[];
  Item: React.ComponentType<{
    disabled?: boolean;
    onSelect?: (e: Event) => void;
    className?: string;
    title?: string;
    children?: React.ReactNode;
  }>;
  Label: React.ComponentType<{ className?: string; children?: React.ReactNode }>;
}) {
  if (items.length === 0) {
    return <Label className="px-2 py-1.5 text-body-sm text-ink-3">No actions available.</Label>;
  }
  return (
    <>
      {items.map((it) => (
        <Item
          key={it.key}
          disabled={it.disabled}
          title={it.reason}
          onSelect={(e) => {
            if (it.disabled) {
              e.preventDefault();
              return;
            }
            it.onSelect();
          }}
          className={MENU_ITEM_CLASS}
        >
          <it.icon className="size-3.5 shrink-0" aria-hidden />
          {it.label}
        </Item>
      ))}
    </>
  );
}

/** Wraps a task card so right-clicking it opens the shared menu. */
export function TaskCardContextMenu({ items, children }: { items: TaskMenuItem[]; children: React.ReactNode }) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content className={MENU_CONTENT_CLASS}>
          <MenuItemList items={items} Item={ContextMenuPrimitive.Item} Label={ContextMenuPrimitive.Label} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

/**
 * The 3-dot, keyboard-accessible trigger for the same menu. Radix's
 * `DropdownMenu.Trigger` already gives Enter/Space to open, arrow-key
 * navigation and Escape to close — DESIGN.md's keyboard-path requirement
 * for free, not hand-rolled. `onPointerDown`/`onClick` stop propagation
 * so a click here never reaches the card's own `onClick` (which opens
 * the detail dialog) or arms `@dnd-kit`'s drag listener on the card's
 * outer element, matching the pattern the card's existing flag/notes
 * buttons already use.
 */
export function TaskCardMenuButton({ items, taskTitle }: { items: TaskMenuItem[]; taskTitle: string }) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`More actions for "${taskTitle}"`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'flex size-6 items-center justify-center rounded-sm text-ink-3 opacity-0 transition-opacity',
            'hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2',
            'focus-visible:outline-ring group-hover:opacity-100 data-[state=open]:bg-surface-2 data-[state=open]:opacity-100'
          )}
        >
          <MoreVertical className="size-3.5" aria-hidden />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content align="end" sideOffset={4} className={MENU_CONTENT_CLASS}>
          <MenuItemList items={items} Item={DropdownMenuPrimitive.Item} Label={DropdownMenuPrimitive.Label} />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
