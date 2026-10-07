import { describe, expect, it } from 'vitest';
import { suggestBidTarget, type BidTargetInput } from './bid-target';

const M = 1_000_000;
const cpa = (over: Partial<BidTargetInput> = {}): BidTargetInput => ({ bidStrategy: 'TARGET_CPA', currentTarget: 200 * M, costMicros: 10_000 * M, conversions: 40, convValue: 0, learning: false, ...over });

describe('suggestBidTarget (Requirement 13.5)', () => {
  it.each<[string, BidTargetInput, unknown]>([
    ['actual CPA 250 vs 200: +15% cap', cpa(), { action: 'adjust', field: 'target_cpa_micros', after: 230 * M, actual: 250 * M }],
    ['actual CPA 195 vs 200: within deadband', cpa({ conversions: 10_000 / 195 }), { action: 'skip', reason: '實際表現接近目標' }],
    ['actual CPA 160 vs 200: −15% cap', cpa({ conversions: 62.5 }), { action: 'adjust', after: 170 * M }],
    ['actual CPA 180 vs 200: moves all the way', cpa({ conversions: 10_000 / 180 }), { action: 'adjust', after: 180 * M }],
    ['learning', cpa({ learning: true }), { action: 'skip', reason: '學習中' }],
    ['thin data', cpa({ conversions: 10 }), { action: 'skip' }],
    ['manual CPC', cpa({ bidStrategy: 'MANUAL_CPC' }), { action: 'skip', reason: '出價策略沒有目標' }],
    ['ROAS 3 vs 4: −15%', { bidStrategy: 'TARGET_ROAS', currentTarget: 4, costMicros: 10_000 * M, conversions: 50, convValue: 30_000, learning: false }, { action: 'adjust', field: 'target_roas', after: 3.4, actual: 3 }],
  ])('%s', (_, input, expected) => {
    expect(suggestBidTarget(input)).toMatchObject(expected as object);
  });

  it('honours a configured step', () => {
    expect(suggestBidTarget(cpa(), { maxStepPct: 0.1 })).toMatchObject({ after: 220 * M });
  });
});
