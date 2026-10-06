import { describe, expect, it } from 'vitest';
import type { Violation } from '../changeset/types';
import type { EntityRef, Op } from '../platform/types';
import { computeTier, computeTierDetailed, DEFAULT_TIER_THRESHOLDS, type TierThresholds } from './tier';

const M = 1_000_000;
const c: EntityRef = { platform: 'google_ads', accountId: '1234567890', kind: 'campaign', id: '111' };
const t: TierThresholds = { tier3Pct: 0.5, tier3AmountMicros: 5000 * M, tier1MaxReducePct: 0.3 };

const budget = (before: number, after: number): Op => ({ kind: 'set_budget', target: c, field: 'budget_micros', before: before * M, after: after * M });
const status = (before: string, after: string): Op => ({ kind: 'set_status', target: c, field: 'status', before, after });
const tcpa = (before: number, after: number): Op => ({ kind: 'set_bid_target', target: c, field: 'target_cpa_micros', before: before * M, after: after * M });
const troas = (before: number, after: number): Op => ({ kind: 'set_bid_target', target: c, field: 'target_roas', before, after });
const negative = (matchType: string): Op => ({ kind: 'google.add_negative_keyword', target: { ...c, kind: 'shared_set', id: '9' }, before: null, after: { text: 'free', matchType } });
const warn: Violation = { ruleId: 'r', ruleType: 'MaxChangePct', severity: 'WARN', message: '' };

describe('computeTier', () => {
  it.each<[string, Op[], number]>([
    // Protective within thresholds → 1 (Requirement 4.2)
    ['pause', [status('ENABLED', 'PAUSED')], 1],
    ['budget -20%', [budget(1000, 800)], 1],
    ['budget -30% (at the auto limit)', [budget(1000, 700)], 1],
    ['tCPA -10%', [tcpa(200, 180)], 1],
    ['tROAS +10%', [troas(4, 4.4)], 1],
    ['EXACT negative', [negative('EXACT')], 1],
    // Protective beyond the auto limit → 2
    ['budget -40%', [budget(1000, 600)], 2],
    // Expansive → at least 2 (Requirement 4.3)
    ['enable', [status('PAUSED', 'ENABLED')], 2],
    ['budget +10%', [budget(1000, 1100)], 2],
    ['tCPA +10%', [tcpa(200, 220)], 2],
    ['add keyword', [{ kind: 'google.add_keyword', target: { ...c, kind: 'ad_group' }, before: null, after: { text: 'x', matchType: 'EXACT' } }], 2],
    // Neutral → 2
    ['PHRASE negative', [negative('PHRASE')], 2],
    // Over X% or $Y → 3 (Requirement 4.4)
    ['budget +60%', [budget(1000, 1600)], 3],
    ['budget -60% (big cut is still big)', [budget(1000, 400)], 3],
    ['budget +6,000 (amount)', [budget(20_000, 26_000)], 3],
    ['tROAS -60%', [troas(5, 2)], 3],
    ['budget from 0', [budget(0, 100)], 3],
    ['campaign with a large budget', [{ kind: 'google.create_campaign_bundle', target: { ...c, kind: 'account' }, before: null, after: { budgetMicros: 6000 * M } }], 3],
    ['campaign with a small budget', [{ kind: 'google.create_campaign_bundle', target: { ...c, kind: 'account' }, before: null, after: { budgetMicros: 500 * M } }], 2],
    // Max over ops (Requirement 4.5)
    ['pause + enable', [status('ENABLED', 'PAUSED'), status('PAUSED', 'ENABLED')], 2],
    ['two small raises summing over $Y', [budget(20_000, 23_000), { ...budget(20_000, 23_000), target: { ...c, id: '112' } }], 3],
    ['no ops', [], 0],
  ])('%s → Tier %i', (_, ops, expected) => {
    expect(computeTier({ ops }, t)).toBe(expected);
  });

  it('raises protective changes to Tier 2 when the validator warns (Requirement 5.4)', () => {
    expect(computeTier({ ops: [status('ENABLED', 'PAUSED')] }, t, [warn])).toBe(2);
    expect(computeTier({ ops: [budget(1000, 1600)] }, t, [warn])).toBe(3);
    expect(computeTier({ ops: [status('ENABLED', 'PAUSED')] }, t, [{ ...warn, ruleType: 'MISSING_CONTEXT' }])).toBe(2);
  });

  it('ignores the amount threshold when it is off', () => {
    expect(computeTier({ ops: [budget(20_000, 26_000)] }, DEFAULT_TIER_THRESHOLDS)).toBe(2);
  });

  it('explains the tier', () => {
    expect(computeTierDetailed([budget(1000, 800), budget(1000, 1600)], t)).toMatchObject({
      tier: 3,
      ops: [
        { opIndex: 0, tier: 1 },
        { opIndex: 1, tier: 3 },
      ],
      reasons: ['變動 60% 超過 Tier 3 門檻'],
    });
  });
});

describe('op minTier', () => {
  it('raises a protective op to the tier it asks for', () => {
    const neg = (minTier?: number): Op => ({ kind: 'google.add_negative_keyword', target: { platform: 'google_ads', accountId: '1', kind: 'shared_set', id: '9' }, before: null, after: { text: 'x', matchType: 'EXACT' }, ...(minTier ? { meta: { minTier } } : {}) });
    expect(computeTier({ ops: [neg()] }, DEFAULT_TIER_THRESHOLDS)).toBe(1);
    expect(computeTier({ ops: [neg(2)] }, DEFAULT_TIER_THRESHOLDS)).toBe(2);
    expect(computeTier({ ops: [neg(), neg(2)] }, DEFAULT_TIER_THRESHOLDS)).toBe(2);
  });
});
