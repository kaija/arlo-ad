import { describe, expect, it } from 'vitest';
import { suggestAudienceAction, type AudienceSegmentInput } from './audience';

const M = 1_000_000;
// Campaign: 30,000 spent for 100 conversions → CPA 300, ROAS 2.
const campaign = { costMicros: 30_000 * M, clicks: 3_000, conversions: 100, convValue: 60_000 };
const seg = (over: Partial<AudienceSegmentInput['segment']> = {}, rest: Partial<AudienceSegmentInput> = {}): AudienceSegmentInput => ({
  bidStrategy: 'MANUAL_CPC',
  currentModifier: null,
  campaign,
  segment: { costMicros: 4_000 * M, clicks: 400, conversions: 20, convValue: 8_000, ...over },
  ...rest,
});

describe('suggestAudienceAction (Requirement 17.2)', () => {
  it.each<[string, AudienceSegmentInput, unknown]>([
    ['CPA 200 vs 300: +20% cap', seg(), { action: 'modifier', before: 1, after: 1.2 }],
    ['CPA 360 vs 300: moves to 0.85', seg({ costMicros: 7_200 * M }), { action: 'modifier', before: 1, after: 0.85 }],
    ['CPA 400 vs 300: −20% cap', seg({ costMicros: 8_000 * M }), { action: 'modifier', after: 0.8 }],
    ['CPA 310 vs 300: within deadband', seg({ costMicros: 6_200 * M }), { action: 'skip', reason: '表現接近 campaign 平均' }],
    ['steps from the current modifier', seg({}, { currentModifier: 1.5 }), { action: 'modifier', before: 1.5, after: 1.8 }],
    ['clamped to the platform maximum', seg({}, { currentModifier: 9.5 }), { action: 'modifier', after: 10 }],
    ['thin data', seg({ conversions: 4, costMicros: 800 * M }), { action: 'skip', reason: '轉換 4 次，資料不足' }],
    ['smart bidding ignores modifiers', seg({}, { bidStrategy: 'TARGET_CPA' }), { action: 'skip', reason: '智慧出價不套用受眾出價調整' }],
    ['campaign without conversions', seg({}, { campaign: { ...campaign, conversions: 0 } }), { action: 'skip' }],
    ['ROAS 1.5 vs 2: −20% cap', seg({ convValue: 6_000 }, { valueBased: true }), { action: 'modifier', after: 0.8 }],
  ])('%s', (_, input, expected) => {
    expect(suggestAudienceAction(input)).toMatchObject(expected as object);
  });

  it('suggests excluding segments that spend several CPAs without converting, under any strategy', () => {
    const waste = seg({ costMicros: 1_200 * M, clicks: 80, conversions: 0, convValue: 0 }, { bidStrategy: 'MAXIMIZE_CONVERSIONS' });
    expect(suggestAudienceAction(waste)).toEqual({ action: 'exclude', reason: '80 次點擊、花費約 campaign CPA 的 4 倍，沒有轉換' });
    // Too few clicks, or spend under the multiple: not yet.
    expect(suggestAudienceAction({ ...waste, segment: { ...waste.segment, clicks: 30 } })).toMatchObject({ action: 'skip' });
    expect(suggestAudienceAction({ ...waste, segment: { ...waste.segment, costMicros: 600 * M } })).toMatchObject({ action: 'skip' });
  });

  it('honours a configured step', () => {
    expect(suggestAudienceAction(seg(), { maxStepPct: 0.1 })).toMatchObject({ after: 1.1 });
  });
});
