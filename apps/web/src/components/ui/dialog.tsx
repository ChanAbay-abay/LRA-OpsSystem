import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-[var(--scrim)] backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

/**
 * Below `md`, DESIGN.md §16.5: a dialog is a full-screen sheet, not a
 * centred modal — "a centred modal on a 375px screen wastes the edges
 * and puts actions in awkward places (verified still centred at
 * 375px)." Every value below is written as a bare (mobile) utility plus
 * an `md:` override that restores the *original* desktop value byte for
 * byte — the same mobile-first override technique DESIGN.md already
 * uses everywhere else (`w-column md:w-column`, §16.3) — so desktop
 * never renders anything this block didn't already render before.
 *
 * The centring mechanism itself (`left-[50%] top-[50%]` plus the
 * `-50%` translate) is deliberately left untouched at every width,
 * rather than switched to `inset-0` below `md` — with `w-full h-[100dvh]`
 * it resolves to exactly the same flush, edge-to-edge box `inset-0`
 * would (translating a 100%-wide box left by 50% of its own width lands
 * its left edge at 0, and the same identity holds for height), but it
 * also keeps every consumer that passes its own width/height override
 * on `DialogContent`'s `className` (there are a few — `grep -n
 * "DialogContent className" src`) correctly CENTRED at that size
 * instead of shoved into a corner, with no per-consumer change needed.
 *
 * `DialogContent` itself becomes the sheet's one scroller
 * (`overflow-y-auto`) so header and footer can pin with `position:
 * sticky` against it. That also fixes the nested-scroll trap the task
 * detail dialog's bounded History timeline (`max-h-56 overflow-y-auto`)
 * was at risk of: previously nothing outside History could scroll at
 * all in a centred modal taller than the viewport, so overflow above or
 * below it was simply unreachable. Now the outer sheet scrolls too, and
 * the browser's default scroll-chaining hands the gesture from History
 * to the sheet once History hits its own bound — both regions genuinely
 * scroll, so there is no dead zone. `DialogHeader`/`DialogFooter` pin
 * with negative margins that reclaim `DialogContent`'s own mobile
 * `p-4`, which only works because the two paddings are the same 1rem —
 * if that base padding ever changes, these must change with it.
 */
const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid h-[100dvh] w-full max-w-none translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-none border-0 bg-surface p-4 shadow-modal duration-dialog",
        "md:h-auto md:max-w-lg md:overflow-visible md:rounded-xl md:border md:border-hairline md:p-6",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]",
        className
      )}
      {...props}
    >
      {children}
      {/*
        `absolute`, not `fixed`, at every width — anchored to
        DialogContent (itself always `fixed`, so it's this button's
        containing block regardless of DialogContent's own size),
        rather than to the viewport. That keeps the close button sat on
        the sheet's corner even for the one consumer whose own
        width/height override keeps it short of full-bleed (see the
        module comment above).
      */}
      <DialogPrimitive.Close
        className={cn(
          "absolute right-3 top-3 z-20 flex items-center justify-center rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground",
          "md:right-4 md:top-4"
        )}
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      // Mobile sheet only (§16.5): pinned to the top of DialogContent's
      // own scroller, `-mx-4 -mt-4` reclaiming its 1rem padding so the
      // bar bleeds edge to edge, `pr-14` clearing the fixed close button.
      "sticky top-0 z-10 -mx-4 -mt-4 border-b border-hairline bg-surface px-4 pr-14 py-3",
      "md:static md:z-auto md:mx-0 md:mt-0 md:border-0 md:bg-transparent md:p-0",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      // Mobile sheet only (§16.5): pinned to the bottom, holding the
      // primary actions clear of the home indicator via
      // `env(safe-area-inset-bottom)` (index.html carries
      // `viewport-fit=cover` for this to resolve to a real value on iOS).
      "sticky bottom-0 z-10 -mx-4 -mb-4 border-t border-hairline bg-surface px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]",
      "md:static md:z-auto md:mx-0 md:mb-0 md:border-0 md:bg-transparent md:p-0",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-subtitle text-ink", className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-body-sm text-ink-3", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
