import { describe, expect, it } from 'vitest';
import { classifyOp } from '../changeset/classify';
import { evaluateMonitor, inCooldown, monitorActionOps, MonitorActionSchema, MonitorRuleSpecSchema, type MonitoredCampaign, type MonitorRuleSpec, type MonitorWindow } from './monitor';

const M = 1_000_000;

describe('evaluateMonitor', () => {
  const pacing: MonitorRuleSpec = { type: 'SpendPacing', pct: 1.5, minSpendMicros: 100 * M };
  const nearCap: MonitorRuleSpec = { type: 'SpendNearCap', pct: 0.9 };
  const cpa: MonitorRuleSpec = { type: 'CpaSpike', hours: 6, multiplier: 2, minConv: 3 };
  const roas: MonitorRuleSpec = { type: 'RoasDrop', hours: 6, ratio: 0.5, minConv: 3 };

  it.each<[string, MonitorRuleSpec, MonitorWindow, boolean, string?]>([
    ['pacing: 2× pace at noon', pacing, { todaySpendMicros: 1000 * M, dailyBudgetMicros: 1000 * M, dayElapsed: 0.5 }, true],
    ['pacing: exactly at threshold does not fire', pacing, { todaySpendMicros: 750 * M, dailyBudgetMicros: 1000 * M, dayElapsed: 0.5 }, false],
    ['pacing: tiny spend early in the day is ignored', pacing, { todaySpendMicros: 50 * M, dailyBudgetMicros: 1000 * M, dayElapsed: 0.01 }, false],
    ['pacing: no budget', pacing, { todaySpendMicros: 50 * M, dailyBudgetMicros: null, dayElapsed: 0.5 }, false, 'no budget or day not started'],
    ['near cap: 92% of cap', nearCap, { mtdSpendMicros: 92_000 * M, monthlyCapMicros: 100_000 * M }, true],
    ['near cap: 80% of cap', nearCap, { mtdSpendMicros: 80_000 * M, monthlyCapMicros: 100_000 * M }, false],
    ['near cap: no cap rule', nearCap, { mtdSpendMicros: 80_000 * M, monthlyCapMicros: null }, false, 'no MonthlySpendCap'],
    ['CPA: 3× target with enough conversions', cpa, { windowCostMicros: 1800 * M, windowConversions: 3, targetCpaMicros: 200 * M }, true],
    ['CPA: 3× target but too few conversions', cpa, { windowCostMicros: 1200 * M, windowConversions: 2, targetCpaMicros: 200 * M }, false],
    ['CPA: within 2×', cpa, { windowCostMicros: 1200 * M, windowConversions: 4, targetCpaMicros: 200 * M }, false],
    ['CPA: no target', cpa, { windowCostMicros: 1200 * M, windowConversions: 4, targetCpaMicros: null }, false, 'no target CPA'],
    ['ROAS: 1.5 vs target 4', roas, { windowCostMicros: 1000 * M, windowConvValue: 1500, windowConversions: 5, targetRoas: 4 }, true],
    ['ROAS: 3 vs target 4', roas, { windowCostMicros: 1000 * M, windowConvValue: 3000, windowConversions: 5, targetRoas: 4 }, false],
    ['ROAS: too few conversions', roas, { windowCostMicros: 1000 * M, windowConvValue: 100, windowConversions: 1, targetRoas: 4 }, false],
  ])('%s', (_, rule, window, triggered, skipped) => {
    const r = evaluateMonitor(rule, window);
    expect(r.triggered).toBe(triggered);
    if (skipped) expect(r.skipped).toBe(skipped);
  });

  it('reports the evidence behind a decision', () => {
    expect(evaluateMonitor(cpa, { windowCostMicros: 1800 * M, windowConversions: 3, targetCpaMicros: 200 * M }).evidence).toEqual({
      cpaMicros: 600 * M,
      targetCpaMicros: 200 * M,
      ratio: 3,
      threshold: 2,
      conversions: 3,
      costMicros: 1800 * M,
      hours: 6,
    });
  });
});

describe('inCooldown', () => {
  const now = new Date('2026-10-07T06:00:00Z');
  it.each([
    [null, false],
    [new Date('2026-10-07T01:00:00Z'), true],
    [new Date('2026-10-07T00:00:00Z'), false],
  ])('last fired %s → %s', (last, expected) => {
    expect(inCooldown(last, 360, now)).toBe(expected);
  });
});

describe('monitorActionOps', () => {
  const ref = { platform: 'google_ads' as const, accountId: '1', kind: 'campaign' as const, id: '111' };
  const c = (over: Partial<MonitoredCampaign> = {}): MonitoredCampaign => ({ ref, status: 'ENABLED', budgetMicros: 1_234_567_890, bidStrategy: 'TARGET_CPA', bidTarget: 200 * M, ...over });

  it.each<[string, Parameters<typeof monitorActionOps>[0], MonitoredCampaign, unknown[]]>([
    ['pause', { kind: 'pause' }, c(), [{ kind: 'set_status', field: 'status', before: 'ENABLED', after: 'PAUSED' }]],
    ['pause an already paused campaign', { kind: 'pause' }, c({ status: 'PAUSED' }), []],
    ['reduce budget, rounded to cents', { kind: 'reduce_budget', pct: 0.3 }, c(), [{ kind: 'set_budget', before: 1_234_567_890, after: 864_190_000 }]],
    ['reduce tCPA', { kind: 'reduce_target', pct: 0.2 }, c(), [{ kind: 'set_bid_target', field: 'target_cpa_micros', before: 200 * M, after: 160 * M }]],
    ['raise tROAS', { kind: 'reduce_target', pct: 0.2 }, c({ bidStrategy: 'TARGET_ROAS', bidTarget: 4 }), [{ kind: 'set_bid_target', field: 'target_roas', before: 4, after: 4.8 }]],
    ['no target on manual CPC', { kind: 'reduce_target', pct: 0.2 }, c({ bidStrategy: 'MANUAL_CPC', bidTarget: null }), []],
  ])('%s', (_, action, campaign, expected) => {
    const ops = monitorActionOps(action, campaign);
    expect(ops).toMatchObject(expected);
    for (const op of ops) expect(classifyOp(op)).toBe('protective');
  });

  it('validates rule and action specs', () => {
    expect(MonitorRuleSpecSchema.safeParse({ type: 'SpendPacing', pct: 0.8 }).success).toBe(false);
    expect(MonitorRuleSpecSchema.parse({ type: 'SpendPacing', pct: 1.5 })).toEqual({ type: 'SpendPacing', pct: 1.5, minSpendMicros: 0 });
    expect(MonitorActionSchema.safeParse({ kind: 'reduce_budget', pct: 1 }).success).toBe(false);
  });
});
