/**
 * LRA Global Ops :: the one date module — DESIGN.md §22.2
 *
 * Chan: "the date displays are pretty bland on the my points page." The
 * cause was `new Date(x).toLocaleString()` scattered through the app:
 * browser-locale-dependent, seconds included, and reading a different
 * calendar day than the one the server actually recorded whenever the
 * reader's OS timezone isn't Manila's. This is a system whose purpose is
 * a record that cannot be quietly rewritten by whichever timezone
 * happens to be open in the reader's laptop settings, so every date this
 * app shows a person is computed in `Asia/Manila`, in exactly one place.
 *
 * `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` are
 * BANNED outside this file — the tester greps for them.
 *
 * One `Intl.DateTimeFormat` per shape, built once at module load and
 * reused (§22.2: "a single memoised `Intl.DateTimeFormat`"), reading
 * fields back out with `formatToParts` rather than trusting the
 * assembled string — `hourCycle: 'h23'` sidesteps the well-known engine
 * bug where a plain `hour12: false` can render midnight as `24:00`.
 */

const TZ = 'Asia/Manila';

const partsFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

interface ManilaParts {
  year: number;
  /** Numeric, 1–12 — for calendar-day arithmetic (week ranges, day keys). */
  monthNum: number;
  /** `Sep` — Title Case, as Intl renders it. */
  month: string;
  day: number;
  /** `Mon` — Title Case, as Intl renders it. */
  weekday: string;
  hour: string;
  minute: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function manilaParts(iso: string | Date): ManilaParts {
  const parts = partsFmt.formatToParts(iso instanceof Date ? iso : new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const month = get('month');
  return {
    year: Number(get('year')),
    monthNum: Math.max(0, MONTHS.indexOf(month)) + 1,
    month,
    day: Number(get('day')),
    weekday: get('weekday'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `2026-09-15` — the Manila calendar day an instant falls on. This is
 * the register's grouping key (§22.1): a ledger row at 00:30 Manila must
 * group under the Manila day, not the UTC one, and the only way to get
 * that right is to never touch `Date#getDate()` (always the browser's
 * own zone) or a raw UTC slice of the ISO string.
 */
export function manilaDayKey(iso: string | Date): string {
  const { year, monthNum, day } = manilaParts(iso);
  return `${year}-${pad2(monthNum)}-${pad2(day)}`;
}

/** `14:05` — 24-hour, no seconds, no date (DESIGN.md §22.1). */
export function fmtTime(iso: string): string {
  const { hour, minute } = manilaParts(iso);
  return `${hour}:${minute}`;
}

/** `15 Sep 2026`. */
export function fmtDate(iso: string): string {
  const { day, month, year } = manilaParts(iso);
  return `${day} ${month} ${year}`;
}

/** `Mon 15 Sep 2026, 14:05 (Asia/Manila)` — the `<Hint>` body for a time or a duration badge. */
export function fmtDateTime(iso: string): string {
  const { weekday, day, month, year, hour, minute } = manilaParts(iso);
  return `${weekday} ${day} ${month} ${year}, ${hour}:${minute} (${TZ})`;
}

/**
 * The register's day heading (§22.1):
 *
 *   today          -> `TODAY · MON 15 SEP`
 *   yesterday      -> `YESTERDAY · SUN 14 SEP`
 *   this year      -> `MON 15 SEP`
 *   otherwise      -> `MON 15 SEP 2025`
 *
 * `now` is a parameter (defaulting to the real clock) purely so the
 * boundary can be tested without mocking global time.
 */
export function fmtDayHeading(iso: string, now: Date = new Date()): string {
  const key = manilaDayKey(iso);
  const todayKey = manilaDayKey(now);
  const yesterdayKey = manilaDayKey(new Date(now.getTime() - 86_400_000));
  const p = manilaParts(iso);
  const nowYear = manilaParts(now).year;
  const dateWord = `${p.weekday.toUpperCase()} ${p.day} ${p.month.toUpperCase()}`;

  if (key === todayKey) return `TODAY · ${dateWord}`;
  if (key === yesterdayKey) return `YESTERDAY · ${dateWord}`;
  if (p.year === nowYear) return dateWord;
  return `${dateWord} ${p.year}`;
}

/**
 * `15–21 Sep 2026` (en dash). `a`/`b` are date-only or full ISO strings;
 * either way they are read through the same Manila formatter as
 * everything else here rather than a second ad-hoc parse.
 */
export function fmtWeekRange(a: string, b: string): string {
  const pa = manilaParts(a);
  const pb = manilaParts(b);
  if (pa.year === pb.year && pa.month === pb.month) {
    return `${pa.day}–${pb.day} ${pb.month} ${pb.year}`;
  }
  if (pa.year === pb.year) {
    return `${pa.day} ${pa.month}–${pb.day} ${pb.month} ${pb.year}`;
  }
  return `${pa.day} ${pa.month} ${pa.year}–${pb.day} ${pb.month} ${pb.year}`;
}

/**
 * The activity heatmap's day keys (DESIGN.md §19) already ARE the
 * Manila calendar day — `apps/api/src/routes/scoreboard.ts` computes
 * them server-side with `manilaDayStart`, so unlike everything else in
 * this file there is no instant to re-derive Manila fields from; a bare
 * `YYYY-MM-DD` is parsed as a calendar date via `Date.UTC`, the exact
 * technique `weekLabel` above already uses, never through
 * `toLocaleDateString` (still banned outside this file).
 */
function calendarDateParts(dateKey: string): { weekday: number; day: number; month: number; year: number } {
  const [year, month, day] = dateKey.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { weekday, day, month, year };
}

/** `Mon 15 Sep 2026` — the heatmap cell tooltip's date line (§19.6). */
export function fmtCalendarDate(dateKey: string): string {
  const { weekday, day, month, year } = calendarDateParts(dateKey);
  return `${WEEKDAYS[weekday]} ${day} ${MONTHS[month - 1]} ${year}`;
}

/** `Monday 15 September 2026` — the heatmap cell's `aria-label` (§19.6). */
export function fmtCalendarDateLong(dateKey: string): string {
  const { weekday, day, month, year } = calendarDateParts(dateKey);
  return `${WEEKDAYS_LONG[weekday]} ${day} ${MONTHS_LONG[month - 1]} ${year}`;
}

/**
 * `W38 · 2026` — the ISO-8601-ish week number Chan's briefing already
 * computes locally (`routes/briefing.tsx:536`'s `weekNumber`), moved
 * here per §22.2 so it reads Manila calendar fields instead of the
 * browser's own zone. `briefing.tsx` itself is out of this change's
 * lane and still carries its own copy — see the coder's report for why.
 */
export function weekLabel(iso: string): string {
  const { year, monthNum, day } = manilaParts(iso);
  const d = new Date(Date.UTC(year, monthNum - 1, day));
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86_400_000 + jan1.getUTCDay() + 1) / 7);
  return `W${weekNum} · ${year}`;
}
