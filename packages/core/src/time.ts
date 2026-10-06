// Account-timezone calendar helpers. Google Ads reports dates and change times in the
// account's timezone; Postgres stores instants (timestamptz) and calendar dates.

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function wallTime(instant: Date, timeZone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** YYYY-MM-DD of the instant in the timezone. */
export function dateInTimeZone(instant: Date, timeZone: string): string {
  const w = wallTime(instant, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** YYYY-MM-DD HH:mm:ss of the instant in the timezone (GAQL datetime literal). */
export function dateTimeInTimeZone(instant: Date, timeZone: string): string {
  const w = wallTime(instant, timeZone);
  return `${dateInTimeZone(instant, timeZone)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

function offsetMs(instant: number, timeZone: string): number {
  const w = wallTime(new Date(instant), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000;
}

/** Parses "YYYY-MM-DD[ HH:mm:ss[.ffffff]]" as wall-clock time in the timezone. */
export function zonedToInstant(value: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/.exec(value.trim());
  if (!m) throw new Error(`invalid date-time: ${value}`);
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = ''] = m;
  const guess = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +s);
  let result = guess - offsetMs(guess, timeZone);
  // Around DST transitions the offset at the guess and at the result can differ.
  const second = offsetMs(result, timeZone);
  if (second !== guess - result) result = guess - second;
  return new Date(result + Math.floor(Number(`0.${frac || '0'}`) * 1000));
}

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from a to b (b - a) for YYYY-MM-DD dates. */
export function daysBetween(a: string, b: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function daysInMonth(date: string): number {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

export const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
