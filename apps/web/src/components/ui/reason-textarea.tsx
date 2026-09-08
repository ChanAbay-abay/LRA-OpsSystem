/**
 * LRA Global Ops :: Reason textarea
 *
 * DESIGN.md §5.2: every `reason` field (rejection, points override,
 * block) is a textarea with a live character minimum (10), a counter
 * that only turns danger after first blur, because "submitting a reason
 * is a moment of accountability; the UI should make it feel deliberate,
 * not like a formality."
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

const MIN_LENGTH = 10;

export function ReasonTextarea({
  value,
  onChange,
  id,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  placeholder?: string;
}) {
  const [touched, setTouched] = React.useState(false);
  const short = value.trim().length < MIN_LENGTH;

  return (
    <div className="flex flex-col gap-1">
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTouched(true)}
        placeholder={placeholder}
        aria-invalid={touched && short ? true : undefined}
        className={cn(
          'min-h-[80px] w-full rounded-md border border-[#CBD2E0] bg-white px-[10px] py-2 text-body text-ink',
          'placeholder:text-ink-3',
          'hover:border-[#B7C0D2]',
          'focus-visible:outline-none focus-visible:border-[#1662E8] focus-visible:ring-[3px] focus-visible:ring-[#E8F0FE]',
          touched && short && 'border-[#B3261E] focus-visible:border-[#B3261E] focus-visible:ring-[#FBEBE9]'
        )}
      />
      <span className={cn('num num-xs self-end', touched && short ? 'text-danger' : 'text-ink-3')}>
        {value.trim().length}/{MIN_LENGTH} min
      </span>
    </div>
  );
}

export { MIN_LENGTH as REASON_MIN_LENGTH };
