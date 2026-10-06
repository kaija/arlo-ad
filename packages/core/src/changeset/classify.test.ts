import { describe, expect, it } from 'vitest';
import { entityKey, type EntityRef, type Op } from '../platform/types';
import { budgetDeltaMicros, changeRatio, classifyOp, diffCurrent, type OpClass } from './classify';

const campaign: EntityRef = { platform: 'google_ads', accountId: '1234567890', kind: 'campaign', id: '111' };
const op = (o: Partial<Op> & Pick<Op, 'kind'>): Op => ({ target: campaign, before: null, after: null, ...o });

describe('classifyOp', () => {
  it.each<[string, Op, OpClass]>([
    ['budget down', op({ kind: 'set_budget', field: 'budget_micros', before: 1000, after: 800 }), 'protective'],
    ['budget up', op({ kind: 'set_budget', field: 'budget_micros', before: 1000, after: 1200 }), 'expansive'],
    ['budget same', op({ kind: 'set_budget', field: 'budget_micros', before: 1000, after: 1000 }), 'neutral'],
    ['budget unknown before', op({ kind: 'set_budget', field: 'budget_micros', before: null, after: 1 }), 'expansive'],
    ['pause', op({ kind: 'set_status', field: 'status', before: 'ENABLED', after: 'PAUSED' }), 'protective'],
    ['enable', op({ kind: 'set_status', field: 'status', before: 'PAUSED', after: 'ENABLED' }), 'expansive'],
    ['pause already paused', op({ kind: 'set_status', field: 'status', before: 'PAUSED', after: 'PAUSED' }), 'neutral'],
    ['enable already enabled', op({ kind: 'set_status', field: 'status', before: 'ENABLED', after: 'ENABLED' }), 'neutral'],
    ['remove', op({ kind: 'set_status', field: 'status', before: 'ENABLED', after: 'REMOVED' }), 'expansive'],
    ['tCPA down', op({ kind: 'set_bid_target', field: 'target_cpa_micros', before: 200, after: 180 }), 'protective'],
    ['tCPA up', op({ kind: 'set_bid_target', field: 'target_cpa_micros', before: 200, after: 220 }), 'expansive'],
    ['tROAS up', op({ kind: 'set_bid_target', field: 'target_roas', before: 4, after: 4.5 }), 'protective'],
    ['tROAS down', op({ kind: 'set_bid_target', field: 'target_roas', before: 4, after: 3.5 }), 'expansive'],
    ['tCPA unknown', op({ kind: 'set_bid_target', field: 'target_cpa_micros', before: null, after: 100 }), 'expansive'],
    ['tCPA same', op({ kind: 'set_bid_target', field: 'target_cpa_micros', before: 100, after: 100 }), 'neutral'],
    ['exact negative', op({ kind: 'google.add_negative_keyword', after: { text: 'free', matchType: 'EXACT' } }), 'protective'],
    ['phrase negative', op({ kind: 'google.add_negative_keyword', after: { text: 'free', matchType: 'PHRASE' } }), 'neutral'],
    ['broad negative', op({ kind: 'google.add_negative_keyword', after: { text: 'free', matchType: 'BROAD' } }), 'neutral'],
    ['add keyword', op({ kind: 'google.add_keyword', after: { text: 'arlo', matchType: 'EXACT' } }), 'expansive'],
    ['audience modifier up', op({ kind: 'google.set_audience_bid_modifier', before: { bidModifier: 1 }, after: { userListId: 'u', bidModifier: 1.2 } }), 'expansive'],
    ['audience modifier down', op({ kind: 'google.set_audience_bid_modifier', before: { bidModifier: 1.2 }, after: { userListId: 'u', bidModifier: 0.9 } }), 'neutral'],
    ['audience modifier new above 1', op({ kind: 'google.set_audience_bid_modifier', before: null, after: { userListId: 'u', bidModifier: 1.1 } }), 'expansive'],
    ['exclude audience', op({ kind: 'google.exclude_audience', after: { userListId: 'u' } }), 'neutral'],
    ['create campaign', op({ kind: 'google.create_campaign_bundle', after: {} }), 'expansive'],
  ])('%s → %s', (_, o, expected) => {
    expect(classifyOp(o)).toBe(expected);
  });
});

describe('change size', () => {
  it('computes relative change and budget delta', () => {
    expect(changeRatio(op({ kind: 'set_budget', before: 1000, after: 800 }))).toBeCloseTo(0.2);
    expect(changeRatio(op({ kind: 'set_budget', before: 0, after: 800 }))).toBe(Infinity);
    expect(changeRatio(op({ kind: 'set_budget', before: 0, after: 0 }))).toBe(0);
    expect(changeRatio(op({ kind: 'set_status', before: 'ENABLED', after: 'PAUSED' }))).toBeNull();
    expect(budgetDeltaMicros(op({ kind: 'set_budget', before: 1000, after: 1500 }))).toBe(500);
    expect(budgetDeltaMicros(op({ kind: 'set_bid_target', before: 1000, after: 1500 }))).toBe(0);
  });
});

describe('diffCurrent', () => {
  const key = entityKey(campaign);
  const ops: Op[] = [
    op({ kind: 'set_budget', field: 'budget_micros', before: 1_000_000_000, after: 800_000_000 }),
    op({ kind: 'set_status', field: 'status', before: 'ENABLED', after: 'PAUSED' }),
    op({ kind: 'set_bid_target', field: 'target_roas', before: 4.5, after: 5 }),
    op({ kind: 'google.add_negative_keyword', target: { ...campaign, kind: 'shared_set', id: '9' }, after: { text: 'x', matchType: 'EXACT' } }),
  ];

  it('reports nothing when live values equal the proposal', () => {
    const current = new Map([[key, { budget_micros: 1_000_000_000, status: 'ENABLED', target_roas: 4.5 + 1e-12 }]]);
    expect(diffCurrent(ops, current, (o) => entityKey(o.target))).toEqual([]);
  });

  it('reports changed fields and missing entities', () => {
    const changed = new Map([[key, { budget_micros: 1_200_000_000, status: 'ENABLED', target_roas: 4 }]]);
    expect(diffCurrent(ops, changed, (o) => entityKey(o.target))).toEqual([
      { opIndex: 0, field: 'budget_micros', expected: 1_000_000_000, actual: 1_200_000_000, reason: 'changed' },
      { opIndex: 2, field: 'target_roas', expected: 4.5, actual: 4, reason: 'changed' },
    ]);
    expect(diffCurrent(ops.slice(0, 1), new Map(), (o) => entityKey(o.target))).toEqual([
      { opIndex: 0, field: 'budget_micros', expected: 1_000_000_000, actual: undefined, reason: 'missing' },
    ]);
  });
});
