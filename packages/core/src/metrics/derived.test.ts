import { describe, expect, it } from 'vitest';
import { deriveMetrics, microsToUnits } from './derived';

describe('deriveMetrics', () => {
  it('computes ratios', () => {
    expect(deriveMetrics({ costMicros: 1_000_000_000, impressions: 10_000, clicks: 200, conversions: 4, convValue: 5000 })).toEqual({
      ctr: 0.02,
      cpcMicros: 5_000_000,
      cpaMicros: 250_000_000,
      roas: 5,
      convRate: 0.02,
    });
  });

  it('returns null instead of dividing by zero', () => {
    expect(deriveMetrics({ costMicros: 0, impressions: 0, clicks: 0, conversions: 0, convValue: 0 })).toEqual({
      ctr: null,
      cpcMicros: null,
      cpaMicros: null,
      roas: null,
      convRate: null,
    });
    expect(microsToUnits(null)).toBeNull();
    expect(microsToUnits(2_500_000)).toBe(2.5);
  });
});
