import { entityKey, type EntityRef, type Op } from '@arlo/core';
import { describe, expect, it } from 'vitest';
import { FakePlatformAdapter } from './fake';

const ACC = '1234567890';
const campaign: EntityRef = { platform: 'google_ads', accountId: ACC, kind: 'campaign', id: '111' };

function seeded() {
  return new FakePlatformAdapter()
    .addAccount({ externalId: ACC, name: 'Test', currency: 'TWD', timezone: 'Asia/Taipei' })
    .addEntities(ACC, [
      {
        kind: 'campaign',
        externalId: '111',
        name: 'Brand',
        status: 'ENABLED',
        attrs: {},
        state: { budgetMicros: 1_000_000_000, bidStrategy: 'TARGET_CPA', bidTarget: 200_000_000 },
      },
      { kind: 'ad_group', externalId: '222', parent: { kind: 'campaign', externalId: '111' }, name: 'AG', status: 'ENABLED', attrs: {} },
      { kind: 'shared_set', externalId: '333', name: 'arlo-auto-negatives', status: 'ENABLED', attrs: {} },
    ]);
}

describe('FakePlatformAdapter', () => {
  it('reports current state in fetchCurrent shape', async () => {
    const current = await seeded().fetchCurrent([campaign, { ...campaign, id: 'missing' }]);
    expect([...current.keys()]).toEqual([entityKey(campaign)]);
    expect(current.get(entityKey(campaign))).toEqual({
      status: 'ENABLED',
      budget_micros: 1_000_000_000,
      bid_strategy: 'TARGET_CPA',
      target_cpa_micros: 200_000_000,
      target_roas: null,
    });
  });

  it('applies core and Google ops, reflecting them in reads and change history', async () => {
    const fake = seeded();
    const ops: Op[] = [
      { kind: 'set_budget', target: campaign, field: 'budget_micros', before: 1_000_000_000, after: 800_000_000 },
      { kind: 'set_status', target: campaign, field: 'status', before: 'ENABLED', after: 'PAUSED' },
      { kind: 'set_bid_target', target: campaign, field: 'target_cpa_micros', before: 200_000_000, after: 180_000_000 },
      {
        kind: 'google.add_negative_keyword',
        target: { ...campaign, kind: 'shared_set', id: '333' },
        before: null,
        after: { text: 'free', matchType: 'EXACT' },
      },
      { kind: 'google.add_keyword', target: { ...campaign, kind: 'ad_group', id: '222' }, before: null, after: { text: 'shoes', matchType: 'PHRASE' } },
      { kind: 'google.set_audience_bid_modifier', target: campaign, before: null, after: { userListId: 'UL1', bidModifier: 1.2 } },
    ];
    const results = await fake.applyOps(ACC, ops);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await fake.fetchCurrent([campaign])).get(entityKey(campaign))).toMatchObject({
      status: 'PAUSED',
      budget_micros: 800_000_000,
      target_cpa_micros: 180_000_000,
    });
    expect(fake.negativesOf(ACC, '333')).toEqual([{ text: 'free', matchType: 'EXACT' }]);
    expect((await fake.fetchEntities(ACC, ['keyword'])).map((k) => k.name)).toEqual(['shoes']);
    expect(fake.audienceModifierOf(ACC, '111', 'UL1')).toBe(1.2);
    const history = await fake.fetchChangeHistory(ACC, new Date(0));
    expect(history.map((h) => h.clientType)).toEqual(['GOOGLE_ADS_API', 'GOOGLE_ADS_API', 'GOOGLE_ADS_API']);
    expect(fake.applied).toHaveLength(1);
  });

  it('creates campaign bundles paused', async () => {
    const fake = seeded();
    const [result] = await fake.applyOps(ACC, [
      { kind: 'google.create_campaign_bundle', target: { ...campaign, kind: 'account', id: ACC }, before: null, after: { name: 'New' } },
    ]);
    expect(result).toMatchObject({ ok: true, resourceName: expect.stringMatching(/^customers\/1234567890\/campaigns\//) });
    expect((await fake.fetchEntities(ACC, ['campaign'])).find((c) => c.name === 'New')?.status).toBe('PAUSED');
  });

  it('injects drift as an external change with the modifier', async () => {
    const fake = seeded().drift(campaign, { budgetMicros: 1_500_000_000 }, 'pat@example.com');
    expect((await fake.fetchCurrent([campaign])).get(entityKey(campaign))?.budget_micros).toBe(1_500_000_000);
    const [event] = await fake.fetchChangeHistory(ACC, new Date(0));
    expect(event).toMatchObject({ userEmail: 'pat@example.com', changedFields: ['budget_micros'] });
  });

  it('injects call errors and per-op failures', async () => {
    const fake = seeded().failNext('fetchMetrics', new Error('QUOTA'));
    const q = { accountId: ACC, level: 'campaign' as const, range: { from: '2026-01-01', to: '2026-01-02' } };
    await expect(fake.fetchMetrics(q)).rejects.toThrow('QUOTA');
    await expect(fake.fetchMetrics(q)).resolves.toEqual([]);

    fake.failOps((_op, index) => (index === 1 ? 'POLICY_VIOLATION' : undefined));
    const results = await fake.applyOps(ACC, [
      { kind: 'set_budget', target: campaign, field: 'budget_micros', before: 1_000_000_000, after: 900_000_000 },
      { kind: 'set_status', target: campaign, field: 'status', before: 'ENABLED', after: 'PAUSED' },
      { kind: 'set_status', target: { ...campaign, id: 'gone' }, field: 'status', before: 'ENABLED', after: 'PAUSED' },
    ]);
    expect(results).toEqual([
      { index: 0, ok: true, resourceName: 'customers/1234567890/campaigns/111' },
      { index: 1, ok: false, error: 'POLICY_VIOLATION' },
      { index: 2, ok: false, error: expect.stringContaining('RESOURCE_NOT_FOUND') },
    ]);
  });

  it('filters metrics by level, range and hourly segmentation', async () => {
    const base = { costMicros: 1, impressions: 1, clicks: 1, conversions: 0, convValue: 0 };
    const fake = seeded()
      .addMetrics(ACC, [
        { ...base, level: 'campaign', externalId: '111', date: '2026-01-01' },
        { ...base, level: 'campaign', externalId: '111', date: '2026-01-05' },
        { ...base, level: 'campaign', externalId: '111', date: '2026-01-01', hour: 3 },
        { ...base, level: 'account', externalId: ACC, date: '2026-01-01' },
      ])
      .replaceMetrics(ACC, [{ ...base, level: 'campaign', externalId: '111', date: '2026-01-01', conversions: 2 }]);
    const range = { from: '2026-01-01', to: '2026-01-02' };
    expect(await fake.fetchMetrics({ accountId: ACC, level: 'campaign', range })).toEqual([
      { ...base, level: 'campaign', externalId: '111', date: '2026-01-01', conversions: 2 },
    ]);
    expect(await fake.fetchMetrics({ accountId: ACC, level: 'campaign', range, hourly: true })).toHaveLength(1);
  });
});
