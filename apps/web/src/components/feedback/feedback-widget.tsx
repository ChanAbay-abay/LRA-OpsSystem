/**
 * LRA Global Ops :: the bottom-left feedback affordance
 *
 * Chan: "add a feature at the bottom left where they can leave either a
 * suggestion or bug that they found (switchable). make it like a form
 * then it just gets sent to me via the inbox and i can just archive and
 * delete stuff once its okay."
 *
 * One control, two modes — a segmented toggle (same shape as
 * `scoreboard/period-tabs.tsx`'s `PeriodTabs`, DESIGN.md's existing
 * two/four-way switch pattern), never two separate "Report a bug" /
 * "Leave a suggestion" buttons. The page it was opened from is read from
 * `useLocation()` and sent automatically — never a field the reporter
 * fills in themselves (a bug report with no "where" is half a report).
 *
 * Mounted once in `AppShell` (persistent on every authenticated screen,
 * per the ask), `position: fixed` so the shell's own internal scrolling
 * (`<main>` is the only scroller, app-shell.tsx) never carries it away.
 * `md:left-[256px]` clears the 240px sidebar plus the same 16px inset
 * the trigger sits at everywhere else — `routes/founder-digest.tsx`'s
 * sticky footer bar uses the identical `md:left-[240px]` technique for
 * the same reason (the persistent `<aside>` only exists at `md:` and up).
 *
 * Reuses `<ReasonTextarea>` for the body: its 10-character live minimum
 * is the exact floor `core.feedback`'s CHECK constraint enforces
 * (20260911130000_core_feedback_channel.sql), so this is a genuine fit,
 * not a borrowed component pressed into a shape it wasn't meant for.
 *
 * Deliberately does NOT check `me?.readOnly` anywhere in this file. A
 * read-only founder (ERC/DCA) can submit feedback exactly like anyone
 * else — the one write in this whole app that is not gated behind that
 * flag. See the migration's point 3 for why.
 */
import * as React from 'react';
import { useLocation } from 'react-router-dom';
import { MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ReasonTextarea, REASON_MIN_LENGTH } from '@/components/ui/reason-textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Hint } from '@/components/ui/hint';
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/utils';

type FeedbackKind = 'suggestion' | 'bug';

/**
 * The switch itself — same segmented-control shape as `PeriodTabs`
 * (`components/scoreboard/period-tabs.tsx`): a labelled `role="group"`
 * of toggle buttons rather than a `tablist`, so both options stay
 * reachable with a plain Tab and `aria-pressed` states the selection
 * with no roving-focus management to reimplement.
 */
function KindSwitch({ value, onChange }: { value: FeedbackKind; onChange: (v: FeedbackKind) => void }) {
  const options: { key: FeedbackKind; label: string }[] = [
    { key: 'suggestion', label: 'Suggestion' },
    { key: 'bug', label: 'Bug' },
  ];
  return (
    <div
      role="group"
      aria-label="Suggestion or bug"
      className="inline-flex items-center gap-0.5 self-start rounded-md border border-hairline bg-surface-2 p-0.5"
    >
      {options.map((opt) => {
        const selected = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(opt.key)}
            className={cn(
              'h-[28px] rounded-sm px-3 text-label transition-[background-color,color] duration-press ease',
              selected ? 'bg-surface text-ink shadow-none' : 'text-ink-3 hover:bg-surface-3 hover:text-ink-2'
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function FeedbackWidget() {
  const location = useLocation();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<FeedbackKind>('suggestion');
  const [body, setBody] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function reset() {
    setKind('suggestion');
    setBody('');
    setError(null);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (body.trim().length < REASON_MIN_LENGTH) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/feedback', {
        kind,
        body: body.trim(),
        // Automatic, never asked for — the screen the reporter was
        // actually looking at when they noticed something.
        page: location.pathname,
      });
      toast.success(kind === 'bug' ? 'Bug reported. Thanks for the flag.' : 'Suggestion sent. Thanks for the idea.');
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not send this — try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = body.trim().length >= REASON_MIN_LENGTH && !submitting;

  return (
    <>
      <Hint text="Leave a suggestion or report a bug" side="right">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Leave a suggestion or report a bug"
          className={cn(
            'fixed bottom-4 left-4 z-20 flex h-[40px] items-center gap-2 rounded-full border border-hairline bg-surface px-4 text-label text-ink-2 shadow-pop',
            'transition-[background-color,transform] duration-press ease hover:bg-surface-2 hover:text-ink active:scale-[.98]',
            'md:left-[256px]'
          )}
        >
          <MessageSquarePlus className="size-4" aria-hidden />
          Feedback
        </button>
      </Hint>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send feedback</DialogTitle>
          </DialogHeader>

          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>What is this?</Label>
              <KindSwitch value={kind} onChange={setKind} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="feedback-body">
                {kind === 'bug' ? 'What went wrong?' : 'What would help?'}
              </Label>
              <ReasonTextarea
                id="feedback-body"
                value={body}
                onChange={setBody}
                placeholder={
                  kind === 'bug'
                    ? 'What happened, and what did you expect instead?'
                    : "What's missing, or what would make this easier?"
                }
              />
              <p className="text-micro text-ink-3">This goes straight to Chan, along with the page you're on.</p>
            </div>

            {error ? (
              <p role="alert" className="text-label text-danger">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={submitting} disabled={!canSubmit}>
                {kind === 'bug' ? 'Send bug report' : 'Send suggestion'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
