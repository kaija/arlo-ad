/** Short local date-time for tables, e.g. "10/06 09:00". */
export function formatAt(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

export const RUN_TONE = { succeeded: 'ok', failed: 'bad', skipped: 'warn', running: 'info' } as const;
