import { describe, expect, it } from 'vitest';
import { addDays, dateInTimeZone, dateTimeInTimeZone, daysBetween, daysInMonth, isIsoDate, zonedToInstant } from './time';

describe('time helpers', () => {
  const instant = new Date('2026-03-01T16:30:05Z');

  it('formats an instant in an account timezone', () => {
    expect(dateInTimeZone(instant, 'Asia/Taipei')).toBe('2026-03-02');
    expect(dateTimeInTimeZone(instant, 'Asia/Taipei')).toBe('2026-03-02 00:30:05');
    expect(dateTimeInTimeZone(instant, 'America/Los_Angeles')).toBe('2026-03-01 08:30:05');
  });

  it('parses wall-clock times back to instants, including fractions and DST', () => {
    expect(zonedToInstant('2026-03-02 00:30:05', 'Asia/Taipei').toISOString()).toBe('2026-03-01T16:30:05.000Z');
    expect(zonedToInstant('2026-03-02 00:30:05.123456', 'Asia/Taipei').toISOString()).toBe('2026-03-01T16:30:05.123Z');
    expect(zonedToInstant('2026-03-08 03:30:00', 'America/Los_Angeles').toISOString()).toBe('2026-03-08T10:30:00.000Z');
    expect(zonedToInstant('2026-11-01 12:00:00', 'America/Los_Angeles').toISOString()).toBe('2026-11-01T20:00:00.000Z');
    expect(zonedToInstant('2026-07-01', 'UTC').toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(() => zonedToInstant('yesterday', 'UTC')).toThrow();
  });

  it('does calendar arithmetic', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-02-27', '2026-03-02')).toBe(3);
    expect(daysInMonth('2028-02-10')).toBe(29);
    expect(isIsoDate('2026-01-01')).toBe(true);
    expect(isIsoDate('2026-1-1')).toBe(false);
  });
});
