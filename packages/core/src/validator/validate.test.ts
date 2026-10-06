import { describe, expect, it } from 'vitest';
import { entityKey, type EntityRef, type Op } from '../platform/types';
import { resolveRules, RuleSpecSchema, type RuleInstance, type RuleScope, type RuleSpec } from './rules';
import { hasHardBlock, validate, type CampaignContext, type ValidationContext } from './validate';

const M = 1_000_000;
const ACC = 'acc-1';
const ref = (id: string): EntityRef => ({ platform: 'google_ads', accountId: '1234567890', kind: 'campaign', id });
const brand = ref('111');
const generic = ref('112');

let n = 0;
const rule = (spec: RuleSpec, scope: RuleScope = { kind: 'account', accountId: ACC }, severity: 'HARD_BLOCK' | 'WARN' = 'HARD_BLOCK', enabled = true): RuleInstance => ({
  id: `r${++n}`,
  scope,
  spec,
  severity,
  enabled,
});

const campaigns = new Map<string, CampaignContext>([
  [entityKey(brand), { entityId: 'e-brand', status: 'ENABLED', budgetMicros: 1000 * M, mtdSpendMicros: 5000 * M }],
  [entityKey(generic), { entityId: 'e-generic', status: 'ENABLED', budgetMicros: 2000 * M, mtdSpendMicros: 10_000 * M }],
]);
// 2026-10-06: 26 days left including today.
const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  accountId: ACC,
  currency: 'TWD',
  today: '2026-10-06',
  mtdSpendMicros: 15_000 * M,
  campaigns,
  mutationsToday: 3,
  ...over,
});

const budget = (target: EntityRef, before: number, after: number): Op => ({ kind: 'set_budget', target, field: 'budget_micros', before: before * M, after: after * M });
const tcpa = (before: number, after: number): Op => ({ kind: 'set_bid_target', target: brand, field: 'target_cpa_micros', before: before * M, after: after * M });
const troas = (before: number, after: number): Op => ({ kind: 'set_bid_target', target: brand, field: 'target_roas', before, after });
const status = (target: EntityRef, before: string, after: string): Op => ({ kind: 'set_status', target, field: 'status', before, after });

const run = (ops: Op[], rules: RuleInstance[], c = ctx()) => validate({ accountId: ACC, ops }, c, rules).map((v) => `${v.ruleType}:${v.severity}${v.opIndex === undefined ? '' : `@${v.opIndex}`}`);

describe('validate', () => {
  describe('DailyBudgetCap', () => {
    const cap = rule({ type: 'DailyBudgetCap', maxMicros: 1500 * M });
    it.each([
      ['raise within cap', [budget(brand, 1000, 1400)], []],
      ['raise above cap', [budget(brand, 1000, 1600)], ['DailyBudgetCap:HARD_BLOCK@0']],
      ['lower but still above cap', [budget(generic, 2000, 1800)], []],
      ['raise an already-over budget', [budget(generic, 2000, 2100)], ['DailyBudgetCap:HARD_BLOCK@0']],
      ['status change is not a budget', [status(brand, 'ENABLED', 'PAUSED')], []],
    ])('%s', (_, ops, expected) => expect(run(ops, [cap])).toEqual(expected));
  });

  describe('MonthlySpendCap (MTD + remaining days × new daily budget)', () => {
    // MTD 15,000 + 26 × 3,000 = 93,000 today.
    it.each([
      ['raise stays under', 100_000, [budget(brand, 1000, 1200)], []], // 15,000 + 26 × 3,200 = 98,200
      ['raise goes over', 95_000, [budget(brand, 1000, 1200)], ['MonthlySpendCap:HARD_BLOCK']],
      ['enabling an already-enabled campaign changes nothing', 95_000, [status(brand, 'PAUSED', 'ENABLED')], []],
      ['cutting while already over is allowed', 50_000, [budget(generic, 2000, 1500)], []],
      ['pausing while over is allowed', 50_000, [status(generic, 'ENABLED', 'PAUSED')], []],
    ])('%s', (_, max, ops, expected) => expect(run(ops, [rule({ type: 'MonthlySpendCap', maxMicros: max * M })])).toEqual(expected));

    it('counts a paused campaign being enabled', () => {
      const paused = new Map(campaigns);
      paused.set(entityKey(brand), { ...campaigns.get(entityKey(brand))!, status: 'PAUSED' });
      // Before: 15,000 + 26 × 2,000 = 67,000; after enabling Brand: 93,000.
      expect(run([status(brand, 'PAUSED', 'ENABLED')], [rule({ type: 'MonthlySpendCap', maxMicros: 80_000 * M })], ctx({ campaigns: paused }))).toEqual([
        'MonthlySpendCap:HARD_BLOCK',
      ]);
    });

    it('reports the estimate in details', () => {
      const [v] = validate({ accountId: ACC, ops: [budget(brand, 1000, 1200)] }, ctx(), [rule({ type: 'MonthlySpendCap', maxMicros: 95_000 * M })]);
      expect(v!.details).toEqual({ estimateMicros: 98_200 * M, maxMicros: 95_000 * M, mtdMicros: 15_000 * M, remainingDays: 26 });
    });

    it('applies a campaign-scoped cap to that campaign', () => {
      const own = rule({ type: 'MonthlySpendCap', maxMicros: 30_000 * M }, { kind: 'campaign', accountId: ACC, campaignEntityId: 'e-brand' });
      // Brand: 5,000 + 26 × 1,200 = 36,200 > 30,000.
      expect(run([budget(brand, 1000, 1200)], [own])).toEqual(['MonthlySpendCap:HARD_BLOCK@0']);
      expect(run([budget(generic, 2000, 2400)], [own])).toEqual([]);
    });

    it('warns instead of guessing when MTD spend is not synced', () => {
      expect(run([budget(brand, 1000, 1200)], [rule({ type: 'MonthlySpendCap', maxMicros: 1 })], ctx({ mtdSpendMicros: null }))).toEqual(['MISSING_CONTEXT:WARN']);
    });
  });

  describe('MaxChangePct', () => {
    const maxPct = rule({ type: 'MaxChangePct', pct: 0.2, windowHours: 24 }, { kind: 'account', accountId: ACC }, 'WARN');
    it.each([
      ['+20% exactly is allowed', [budget(brand, 1000, 1200)], undefined, []],
      ['+25% warns', [budget(brand, 1000, 1250)], undefined, ['MaxChangePct:WARN@0']],
      ['-25% warns too', [budget(brand, 1000, 750)], undefined, ['MaxChangePct:WARN@0']],
      ['cumulative from the window baseline', [budget(brand, 1100, 1250)], 1000, ['MaxChangePct:WARN@0']],
      ['bid target change', [tcpa(200, 260)], undefined, ['MaxChangePct:WARN@0']],
    ])('%s', (_, ops, baseline, expected) => {
      const c = ctx({ valueAt: baseline === undefined ? undefined : () => baseline * M });
      expect(run(ops, [maxPct], c)).toEqual(expected);
    });
  });

  describe('BidTargetRange', () => {
    const rules = [rule({ type: 'BidTargetRange', metric: 'tcpa', min: 100 * M, max: 300 * M }), rule({ type: 'BidTargetRange', metric: 'troas', min: 2, max: 8 })];
    it.each([
      ['tCPA inside', [tcpa(200, 250)], []],
      ['tCPA above max', [tcpa(200, 350)], ['BidTargetRange:HARD_BLOCK@0']],
      ['tCPA below min', [tcpa(200, 90)], ['BidTargetRange:HARD_BLOCK@0']],
      ['tROAS inside', [troas(4, 5)], []],
      ['tROAS above max', [troas(4, 9)], ['BidTargetRange:HARD_BLOCK@0']],
    ])('%s', (_, ops, expected) => expect(run(ops, rules)).toEqual(expected));
  });

  describe('MaxMutationsPerDay', () => {
    it.each([
      [3, 2, []],
      [4, 2, ['MaxMutationsPerDay:HARD_BLOCK']],
    ])('%i done today + %i ops vs max 5', (today, count, expected) => {
      const ops = Array.from({ length: count }, () => budget(brand, 1000, 900));
      expect(run(ops, [rule({ type: 'MaxMutationsPerDay', n: 5 })], ctx({ mutationsToday: today }))).toEqual(expected);
    });

    it('counts per campaign for a campaign-scoped rule', () => {
      const r = rule({ type: 'MaxMutationsPerDay', n: 2 }, { kind: 'campaign', accountId: ACC, campaignEntityId: 'e-brand' });
      const byCampaign = new Map([['e-brand', 2]]);
      expect(run([budget(brand, 1000, 900)], [r], ctx({ mutationsTodayByCampaign: byCampaign }))).toEqual(['MaxMutationsPerDay:HARD_BLOCK']);
      expect(run([budget(generic, 2000, 1900)], [r], ctx({ mutationsTodayByCampaign: byCampaign }))).toEqual([]);
    });
  });

  describe('scope override (Requirement 5.2)', () => {
    const org = rule({ type: 'DailyBudgetCap', maxMicros: 5000 * M }, { kind: 'org' });
    const account = rule({ type: 'DailyBudgetCap', maxMicros: 1500 * M });
    const campaign = rule({ type: 'DailyBudgetCap', maxMicros: 3000 * M }, { kind: 'campaign', accountId: ACC, campaignEntityId: 'e-brand' }, 'WARN');

    it('campaign beats account beats org', () => {
      expect(run([budget(brand, 1000, 2500)], [org, account, campaign])).toEqual([]);
      expect(run([budget(brand, 1000, 3500)], [org, account, campaign])).toEqual(['DailyBudgetCap:WARN@0']);
      expect(run([budget(generic, 2000, 2500)], [org, account, campaign])).toEqual(['DailyBudgetCap:HARD_BLOCK@0']);
      expect(run([budget(generic, 2000, 2500)], [org])).toEqual([]);
    });

    it('ignores disabled rules and rules of other accounts', () => {
      const other = rule({ type: 'DailyBudgetCap', maxMicros: 1 }, { kind: 'account', accountId: 'acc-2' });
      const disabled = rule({ type: 'DailyBudgetCap', maxMicros: 1 }, { kind: 'account', accountId: ACC }, 'HARD_BLOCK', false);
      expect(run([budget(brand, 1000, 2500)], [other, disabled])).toEqual([]);
    });

    it('keeps rules with different keys side by side', () => {
      const resolved = resolveRules(
        [
          rule({ type: 'MaxChangePct', pct: 0.2, windowHours: 24 }),
          rule({ type: 'MaxChangePct', pct: 0.5, windowHours: 168 }),
          rule({ type: 'BidTargetRange', metric: 'tcpa', min: 1, max: 2 }),
          rule({ type: 'BidTargetRange', metric: 'troas', min: 1, max: 2 }),
        ],
        { accountId: ACC },
      );
      expect(resolved).toHaveLength(4);
    });
  });

  it('separates HARD_BLOCK from WARN', () => {
    expect(hasHardBlock([{ ruleId: 'x', ruleType: 'y', severity: 'WARN', message: '' }])).toBe(false);
    expect(hasHardBlock([{ ruleId: 'x', ruleType: 'y', severity: 'HARD_BLOCK', message: '' }])).toBe(true);
  });

  it('validates rule specs', () => {
    expect(RuleSpecSchema.safeParse({ type: 'BidTargetRange', metric: 'tcpa', min: 5, max: 1 }).success).toBe(false);
    expect(RuleSpecSchema.safeParse({ type: 'MaxChangePct', pct: 0.3, windowHours: 24 }).success).toBe(true);
    expect(RuleSpecSchema.safeParse({ type: 'Unknown' }).success).toBe(false);
  });
});
