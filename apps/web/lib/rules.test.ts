import { DEFAULT_TIER_THRESHOLDS } from '@arlo/core';
import { clearTierThresholds, DEFAULT_ORG_ID, deleteRule, getRule, listAudit, loadRules, loadTierThresholds, saveRule, setTierThresholds, upsertAdAccounts } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { describe, expect, it } from 'vitest';
import { describeRule, parseRuleForm, parseThresholdForm, ruleFormValues, ruleToFormValues, thresholdsToForm, type RuleFormValues } from './rules';

const ACC = '0199b0c2-8f1e-7a3b-9c4d-123456789abc';
const CMP = '0199b0c2-8f1e-7a3b-9c4d-000000000001';
const form = (v: Record<string, string>) => {
  const f = new FormData();
  for (const [k, val] of Object.entries(v)) f.set(k, val);
  return f;
};
const values = (over: Partial<RuleFormValues>): RuleFormValues => ({ type: 'DailyBudgetCap', scopeKind: 'org', accountId: '', campaignEntityId: '', severity: 'HARD_BLOCK', enabled: true, fields: {}, ...over });

describe('rule forms', () => {
  it('reads only the fields of the chosen type', () => {
    expect(ruleFormValues(form({ type: 'MaxChangePct', scopeKind: 'account', accountId: ACC, severity: 'WARN', enabled: 'on', f_pct: '30', f_windowHours: '24', f_max: 'ignored' }))).toEqual(
      values({ type: 'MaxChangePct', scopeKind: 'account', accountId: ACC, severity: 'WARN', fields: { pct: '30', windowHours: '24' } }),
    );
  });

  it.each([
    [values({ fields: { max: '8,000' } }), { type: 'DailyBudgetCap', maxMicros: 8_000_000_000 }],
    [values({ type: 'MonthlySpendCap', fields: { max: '250000.5' } }), { type: 'MonthlySpendCap', maxMicros: 250_000_500_000 }],
    [values({ type: 'MaxChangePct', fields: { pct: '30', windowHours: '24' } }), { type: 'MaxChangePct', pct: 0.3, windowHours: 24 }],
    [values({ type: 'BidTargetRange', fields: { metric: 'tcpa', min: '100', max: '400' } }), { type: 'BidTargetRange', metric: 'tcpa', min: 100_000_000, max: 400_000_000 }],
    [values({ type: 'BidTargetRange', fields: { metric: 'troas', min: '200', max: '800' } }), { type: 'BidTargetRange', metric: 'troas', min: 2, max: 8 }],
    [values({ type: 'MaxMutationsPerDay', fields: { n: '20' } }), { type: 'MaxMutationsPerDay', n: 20 }],
  ])('parses %# and round-trips', (v, spec) => {
    const parsed = parseRuleForm(v);
    expect(parsed).toMatchObject({ ok: true, value: { spec, scopeKind: 'org', accountId: null, campaignEntityId: null } });
    if (parsed.ok) expect(parseRuleForm(ruleToFormValues(parsed.value))).toEqual(parsed);
  });

  it.each([
    [values({ fields: { max: '' } }), 'f_max'],
    [values({ fields: { max: '-5' } }), 'f_max'],
    [values({ type: 'MaxChangePct', fields: { pct: '30', windowHours: '1.5' } }), 'f_windowHours'],
    [values({ type: 'BidTargetRange', fields: { metric: 'tcpa', min: '500', max: '100' } }), 'f_min'],
    [values({ scopeKind: 'account', fields: { max: '1' } }), 'accountId'],
    [values({ scopeKind: 'campaign', accountId: ACC, fields: { max: '1' } }), 'campaignEntityId'],
  ])('reports errors %#', (v, key) => {
    const parsed = parseRuleForm(v);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors[key]).toBeTruthy();
  });

  it('keeps scope ids only for their scope', () => {
    expect(parseRuleForm(values({ scopeKind: 'campaign', accountId: ACC, campaignEntityId: CMP, fields: { max: '1' } }))).toMatchObject({ ok: true, value: { accountId: ACC, campaignEntityId: CMP } });
    expect(parseRuleForm(values({ scopeKind: 'account', accountId: ACC, campaignEntityId: CMP, fields: { max: '1' } }))).toMatchObject({ ok: true, value: { accountId: ACC, campaignEntityId: null } });
  });

  it('describes rules', () => {
    expect(describeRule({ type: 'DailyBudgetCap', maxMicros: 8_000_000_000 }, 'TWD')).toEqual({ key: 'DailyBudgetCap', values: { amount: 'TWD 8,000' } });
    expect(describeRule({ type: 'BidTargetRange', metric: 'troas', min: 2, max: 8 })).toEqual({ key: 'BidTargetRangeTroas', values: { min: 200, max: 800 } });
  });
});

describe('threshold forms', () => {
  it('round-trips and validates', () => {
    expect(parseThresholdForm(thresholdsToForm(DEFAULT_TIER_THRESHOLDS))).toEqual({ ok: true, value: DEFAULT_TIER_THRESHOLDS });
    expect(parseThresholdForm({ tier3Pct: '50', tier3Amount: '10000', tier1MaxReducePct: '30' })).toEqual({ ok: true, value: { tier3Pct: 0.5, tier3AmountMicros: 10_000_000_000, tier1MaxReducePct: 0.3 } });
    expect(parseThresholdForm({ tier3Pct: '0', tier3Amount: '-1', tier1MaxReducePct: '120' })).toEqual({
      ok: false,
      errors: { tier3Pct: 'between0And1000Pct', tier3Amount: 'positiveOrEmpty', tier1MaxReducePct: 'between0And100Pct' },
    });
  });
});

describe('rule and threshold persistence', () => {
  const t = useTestDatabase();
  const admin = { kind: 'user' as const, id: null };

  it('saves, updates and deletes rules with an audit trail', async () => {
    const [account] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    const rule = await saveRule(t.db, { scopeKind: 'account', accountId: account!.id, campaignEntityId: null, spec: { type: 'DailyBudgetCap', maxMicros: 1 }, severity: 'WARN', enabled: true }, admin);
    await saveRule(t.db, { id: rule.id, scopeKind: 'account', accountId: account!.id, campaignEntityId: null, spec: { type: 'DailyBudgetCap', maxMicros: 2 }, severity: 'HARD_BLOCK', enabled: false }, admin);
    expect(await getRule(t.db, rule.id)).toMatchObject({ spec: { maxMicros: 2 }, severity: 'HARD_BLOCK', enabled: false });
    expect(await loadRules(t.db, account!.id)).toHaveLength(1);
    await expect(saveRule(t.db, { scopeKind: 'org', accountId: null, campaignEntityId: null, spec: { type: 'DailyBudgetCap', maxMicros: -1 }, severity: 'WARN', enabled: true }, admin)).rejects.toThrow();
    expect(await deleteRule(t.db, rule.id, admin)).toBe(true);
    expect((await listAudit(t.db, 'rule', rule.id)).map((a) => a.action)).toEqual(['create', 'update', 'delete']);
  });

  it('sets the org default and account overrides', async () => {
    const [account] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '2234567890', name: 'US', currency: 'USD', timezone: 'UTC' }]);
    const org = { tier3Pct: 0.4, tier3AmountMicros: null, tier1MaxReducePct: 0.2 };
    const own = { tier3Pct: 0.25, tier3AmountMicros: 500_000_000, tier1MaxReducePct: 0.1 };
    await setTierThresholds(t.db, null, org, admin);
    await setTierThresholds(t.db, null, org, admin);
    expect(await loadTierThresholds(t.db, account!.id)).toEqual(org);
    await setTierThresholds(t.db, account!.id, own, admin);
    expect(await loadTierThresholds(t.db, account!.id)).toEqual(own);
    await clearTierThresholds(t.db, account!.id, admin);
    expect(await loadTierThresholds(t.db, account!.id)).toEqual(org);
  });
});
