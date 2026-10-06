import { describe, expect, it } from 'vitest';
import { addDays } from '../time';
import { ga4Gap, type GapDay } from './ga4-gap';

const series = (baseline: [number, number], recent: [number, number], baselineDays = 14): GapDay[] => [
  ...Array.from({ length: baselineDays }, (_, i) => ({ date: addDays('2026-09-20', i), adsConversions: baseline[0], ga4Conversions: baseline[1] })),
  ...Array.from({ length: 3 }, (_, i) => ({ date: addDays('2026-10-04', i), adsConversions: recent[0], ga4Conversions: recent[1] })),
];

describe('ga4Gap (Requirement 16.3)', () => {
  it.each<[string, GapDay[], boolean, number | null]>([
    ['stable ratio', series([10, 8], [10, 8]), false, 0],
    ['GA4 drops (tag broken on site)', series([10, 8], [10, 2]), true, -0.75],
    ['Ads drops while GA4 holds (Ads tag broken)', series([10, 8], [4, 8]), true, 1.5],
    ['within threshold', series([10, 8], [10, 7]), false, -0.125],
    ['too few baseline conversions', series([0.5, 0.5], [0, 5]), false, null],
    ['short baseline', series([10, 8], [10, 2], 5), false, null],
  ])('%s', (_, s, alert, shift) => {
    const r = ga4Gap(s);
    expect(r.alert).toBe(alert);
    if (shift === null) expect(r.shift).toBeNull();
    else expect(r.shift).toBeCloseTo(shift);
  });

  it('alerts when Ads goes silent but GA4 keeps converting', () => {
    expect(ga4Gap(series([10, 8], [0, 6]))).toMatchObject({ alert: true, shift: null, reason: 'Ads 近期沒有轉換，但 GA4 有 18 次' });
  });

  it('ignores order and explains the shift', () => {
    expect(ga4Gap([...series([10, 8], [10, 2])].reverse()).reason).toBe('GA4/Ads 轉換比由 80% 變為 20%（偏移 -75%）');
  });
});
