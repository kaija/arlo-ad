import { computeTier, DEFAULT_TIER_THRESHOLDS } from '@arlo/core';
import { DEFAULT_ORG_ID, getChangeSet, insertChangeSet, insertEntitySnapshots, upsertAdAccounts, upsertAudienceMetrics, upsertEntities, upsertMetricsDaily, upsertUserOnSignIn } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentContext } from '../context';
import { runGetAudienceMetrics, runProposeAudienceExclusion, runProposeAudienceModifier } from './audience';

const M = 1_000_000;
const NOW = new Date('2026-10-07T04:00:00Z');

describe('audience tools (Requirement 17)', () => {
  const t = useTestDatabase();
  let ctx: AgentContext;

  beforeAll(async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    const campaigns = await upsertEntities(t.db, [
      { orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'campaign', externalId: '111', name: 'Manual', status: 'ENABLED' },
      { orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'campaign', externalId: '112', name: 'Smart', status: 'ENABLED' },
    ]);
    const [manual, smart] = campaigns;
    await insertEntitySnapshots(t.db, [
      { orgId: DEFAULT_ORG_ID, entityId: manual!.id, capturedAt: new Date('2026-10-07T03:45:00Z'), budgetMicros: 1000 * M, status: 'ENABLED', bidStrategy: 'MANUAL_CPC', bidTarget: null },
      { orgId: DEFAULT_ORG_ID, entityId: smart!.id, capturedAt: new Date('2026-10-07T03:45:00Z'), budgetMicros: 1000 * M, status: 'ENABLED', bidStrategy: 'TARGET_CPA', bidTarget: 300 * M },
    ]);
    // Both campaigns: 30,000 for 100 conversions (CPA 300).
    await upsertMetricsDaily(
      t.db,
      campaigns.map((c) => ({ orgId: DEFAULT_ORG_ID, accountId: acc!.id, entityId: c.id, level: 'campaign' as const, date: '2026-10-01', costMicros: 30_000 * M, impressions: 30_000, clicks: 3_000, conversions: 100, convValue: 0 })),
    );
    const seg = (campaignId: string, userListId: string, name: string, costMicros: number, clicks: number, conversions: number, bidModifier: number | null = null) => ({
      orgId: DEFAULT_ORG_ID,
      accountId: acc!.id,
      campaignId,
      userListId,
      userListName: name,
      targetingMode: 'OBSERVATION',
      bidModifier,
      date: '2026-10-01',
      costMicros,
      impressions: clicks * 10,
      clicks,
      conversions,
      convValue: 0,
    });
    await upsertAudienceMetrics(t.db, [
      seg(manual!.id, '501', 'Past buyers', 4_000 * M, 400, 20), // CPA 200: raise
      seg(manual!.id, '502', 'Cart abandoners', 6_200 * M, 600, 20, 1.1), // close to average
      seg(manual!.id, '503', 'Job seekers', 1_200 * M, 80, 0), // spends without converting
      seg(smart!.id, '501', 'Past buyers', 4_000 * M, 400, 20),
    ]);
    ctx = { db: t.db, allowedAccountIds: null, now: () => NOW, propose: async (input) => ({ id: (await insertChangeSet(t.db, input)).id }) };
  });

  it('lists segments with deterministic suggestions', async () => {
    const out = await runGetAudienceMetrics(ctx, { account: 'Arlo TW', campaign: null, optimizeFor: null });
    const byKey = new Map(out.segments.map((s) => [`${s.campaignId}:${s.userListId}`, s]));
    expect(byKey.get('111:501')).toMatchObject({ audience: 'Past buyers', cpa: 200, suggestion: { action: 'modifier', before: 1, after: 1.2 } });
    expect(byKey.get('111:502')?.suggestion).toMatchObject({ action: 'skip', reason: '表現接近 campaign 平均' });
    expect(byKey.get('111:503')?.suggestion).toMatchObject({ action: 'exclude' });
    expect(byKey.get('112:501')?.suggestion).toMatchObject({ action: 'skip', reason: '智慧出價不套用受眾出價調整' });
    expect((await runGetAudienceMetrics(ctx, { account: 'Arlo TW', campaign: 'Smart', optimizeFor: null })).segments).toHaveLength(1);
    await expect(runGetAudienceMetrics({ ...ctx, allowedAccountIds: [] }, { account: 'Arlo TW', campaign: null, optimizeFor: null })).rejects.toThrow('找不到');
  });

  it('proposes suggested or user-specified modifiers as Tier 2', async () => {
    const out = await runProposeAudienceModifier(ctx, {
      account: 'Arlo TW',
      campaign: '111',
      changes: [
        { userListId: '501', bidModifier: null },
        { userListId: '502', bidModifier: 0.9 },
      ],
      optimizeFor: null,
      reason: '依 30 天成效',
    });
    const cs = await getChangeSet(t.db, out.changesetId);
    const target = { platform: 'google_ads', accountId: '1234567890', kind: 'campaign', id: '111' };
    expect(cs?.ops).toEqual([
      { kind: 'google.set_audience_bid_modifier', target, before: { userListId: '501', bidModifier: 1 }, after: { userListId: '501', bidModifier: 1.2 }, meta: { minTier: 2 } },
      { kind: 'google.set_audience_bid_modifier', target, before: { userListId: '502', bidModifier: 1.1 }, after: { userListId: '502', bidModifier: 0.9 }, meta: { minTier: 2 } },
    ]);
    expect(computeTier(cs!, DEFAULT_TIER_THRESHOLDS)).toBe(2);
    expect(cs?.rationale).toContain('Cart abandoners：使用者指定');
  });

  it.each([
    ['no suggestion and no value', { userListId: '502', bidModifier: null }, '沒有出價調整建議'],
    ['out of range', { userListId: '501', bidModifier: 11 }, '介於'],
    ['unknown audience', { userListId: '999', bidModifier: 1.2 }, '沒有受眾 999'],
  ])('refuses modifiers: %s', async (_, change, message) => {
    await expect(runProposeAudienceModifier(ctx, { account: 'Arlo TW', campaign: 'Manual', changes: [change], optimizeFor: null, reason: null })).rejects.toThrow(message);
  });

  it('proposes exclusions of synced audiences as Tier 2 and checks propose rights', async () => {
    const out = await runProposeAudienceExclusion(ctx, { account: 'Arlo TW', campaign: 'Manual', userListIds: ['503', '503'], reason: null });
    const cs = await getChangeSet(t.db, out.changesetId);
    expect(cs?.ops).toEqual([
      { kind: 'google.exclude_audience', target: { platform: 'google_ads', accountId: '1234567890', kind: 'campaign', id: '111' }, before: null, after: { userListId: '503' }, meta: { minTier: 2 } },
    ]);
    expect(computeTier(cs!, DEFAULT_TIER_THRESHOLDS)).toBe(2);
    expect(cs?.rationale).toContain('Job seekers：80 次點擊');

    const viewer = { id: (await upsertUserOnSignIn(t.db, { email: 'viewer@example.com' })).id };
    await expect(runProposeAudienceExclusion({ ...ctx, user: viewer }, { account: 'Arlo TW', campaign: 'Manual', userListIds: ['503'], reason: null })).rejects.toThrow('operator');
    await expect(runProposeAudienceExclusion({ ...ctx, propose: undefined }, { account: 'Arlo TW', campaign: 'Manual', userListIds: ['503'], reason: null })).rejects.toThrow('不允許');
  });
});
