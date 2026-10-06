import { describe, expect, it } from 'vitest';
import { addDays } from '../time';
import { forecastMonthSpend, weekday, weekdayFactors, type DailySpend } from './pacing';

const M = 1_000_000;
function series(from: string, days: number, spend: (date: string) => number): DailySpend[] {
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(from, i);
    return { date, costMicros: spend(date) };
  });
}

describe('pacing forecast', () => {
  it('projects a flat spender to budget × days', () => {
    const history = series('2026-09-08', 28, () => 1000 * M); // through 2026-10-05
    const r = forecastMonthSpend({ today: '2026-10-06', history, todaySoFarMicros: 0, dailyBudgetMicros: 1000 * M });
    expect(r.daysElapsed).toBe(5);
    expect(r.mtdMicros).toBe(5000 * M);
    expect(r.linearProjectedMicros).toBe(31_000 * M);
    expect(r.projectedMicros).toBe(31_000 * M);
    expect(r.dailyRateMicros).toBe(1000 * M);
    expect(r.weekdayFactors.every((f) => Math.abs(f - 1) < 1e-9)).toBe(true);
    expect(r.budgetPace).toBeCloseTo(5000 / 6000);
  });

  it('applies weekday seasonality to the remaining days', () => {
    // Weekends spend half of weekdays.
    const spend = (d: string) => ([0, 6].includes(weekday(d)) ? 500 : 1000) * M;
    const history = series('2026-09-01', 35, spend); // through 2026-10-05
    const r = forecastMonthSpend({ today: '2026-10-06', history, todaySoFarMicros: 200 * M });
    const factors = weekdayFactors(history, '2026-10-06');
    expect(factors[0]).toBeLessThan(factors[1]!);
    // Exact expectation: remaining October days spend their weekday's amount.
    let expected = 0;
    for (let d = '2026-10-01'; d <= '2026-10-31'; d = addDays(d, 1)) expected += spend(d);
    expect(r.projectedMicros / M).toBeCloseTo(expected / M, 0);
    // The linear projection ignores the weekend dip in the remaining days.
    expect(r.linearProjectedMicros).not.toBe(r.projectedMicros);
  });

  it('keeps today’s actual spend when it already exceeds the expectation', () => {
    const history = series('2026-09-08', 28, () => 100 * M);
    const r = forecastMonthSpend({ today: '2026-10-06', history, todaySoFarMicros: 900 * M });
    expect(r.mtdMicros).toBe(1400 * M);
    expect(r.projectedMicros).toBe((500 + 900 + 25 * 100) * M);
  });

  it('falls back to flat factors with little history, and handles the first of the month', () => {
    const r = forecastMonthSpend({ today: '2026-11-01', history: [{ date: '2026-10-31', costMicros: 300 * M }], todaySoFarMicros: 50 * M });
    expect(r.weekdayFactors).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(r.daysElapsed).toBe(0);
    expect(r.mtdMicros).toBe(50 * M);
    expect(r.projectedMicros).toBe(300 * 30 * M);
    expect(r.linearProjectedMicros).toBe(50 * 30 * M);
    expect(r.budgetPace).toBeNull();
  });

  it('handles no history at all', () => {
    const r = forecastMonthSpend({ today: '2026-10-06', history: [] });
    expect(r).toMatchObject({ mtdMicros: 0, projectedMicros: 0, dailyRateMicros: 0 });
  });
});
