import { addDays, computeTier, DEFAULT_TIER_THRESHOLDS } from '@arlo/core';
import { DEFAULT_ORG_ID, getChangeSet, getOptimizerRun, insertChangeSet, insertEntitySnapshots, upsertAdAccounts, upsertEntities, upsertMetricsDaily, type NewChangeSet } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentContext } from '../context';
import { ProposeBudgetReallocationParams, runBudgetOptimizer, runProposeBudgetReallocation } from './optimizer';

const M = 1_000_000;
const NOW = new Date('2026-10-07T04:00:00Z');

describe('budget optimizer tools', () => {
  const t = useTestDatabase();
  const proposed: NewChangeSet[] = [];
  let ctx: AgentContext;

  beforeAll(async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    const campaigns = await upsertEntities(t.db, ['111', '112', '113'].map((id) => ({ orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'campaign' as const, externalId: id, name: `C${id}`, status: 'ENABLED', attrs: {} })));
    const id = (ext: string) => campaigns.find((c) => c.externalId === ext)!.id;
    await insertEntitySnapshots(t.db, ['111', '112', '113'].map((ext) => ({ orgId: DEFAULT_ORG_ID, entityId: id(ext), capturedAt: new Date('2026-10-07T03:45:00Z'), budgetMicros: 1000 * M, status: 'ENABLED', bidStrategy: null, bidTarget: null })));
    // 111 converts five times better than 112; 113 is comparable to 112.
    const rows = [];
    for (let i = 1; i <= 14; i++) {
      for (const [ext, rate] of [['111', 20], ['112', 4], ['113', 5]] as const) {
        const cost = 1000 * (0.8 + (i % 5) * 0.1);
        rows.push({ orgId: DEFAULT_ORG_ID, accountId: acc!.id, entityId: id(ext), level: 'campaign' as const, date: addDays('2026-10-07', -i), costMicros: Math.round(cost * M), impressions: 1000, clicks: 100, conversions: rate * Math.sqrt(cost / 1000), convValue: 0, lostIsBudget: 0.2 });
      }
    }
    await upsertMetricsDaily(t.db, rows);
    ctx = { db: t.db, allowedAccountIds: null, now: () => NOW, propose: async (input) => (proposed.push(input), { id: (await insertChangeSet(t.db, input)).id }) };
  });

  it('computes and stores a plan the agent can only reference', async () => {
    const out = await runBudgetOptimizer(ctx, { account: 'Arlo TW', optimizeFor: null });
    expect(out.empty).toBe(false);
    expect(out.campaigns.find((c) => c.campaignId === '111')!.after ?? 0).toBeGreaterThan(1000);
    expect(out.campaigns.reduce((s, c) => s + (c.after ?? 0), 0)).toBe(3000);
    // The proposal schema has no way to pass numbers.
    expect(Object.keys(ProposeBudgetReallocationParams.shape)).toEqual(['resultId', 'excludeCampaigns', 'explanation']);
    expect(ProposeBudgetReallocationParams.shape.excludeCampaigns).toBeInstanceOf(z.ZodArray);
  });

  it('proposes the stored plan as Tier 2, recomputed with exclusions, once', async () => {
    const { resultId } = await runBudgetOptimizer(ctx, { account: 'Arlo TW', optimizeFor: null });
    const out = await runProposeBudgetReallocation(ctx, { resultId, excludeCampaigns: ['113'], explanation: '111 的邊際轉換最高；113 為季節活動保留' });
    const cs = await getChangeSet(t.db, out.changesetId);
    expect(cs).toMatchObject({ feature: 'budget_rebalance', rationale: expect.stringContaining('季節活動') });
    expect(cs!.ops.map((o) => o.target.id).sort()).toEqual(['111', '112']);
    expect(cs!.ops.reduce((s, o) => s + Number(o.after) - Number(o.before), 0)).toBe(0);
    expect(computeTier(cs!, DEFAULT_TIER_THRESHOLDS)).toBeGreaterThanOrEqual(2);
    expect((await getOptimizerRun(t.db, resultId))?.changesetId).toBe(out.changesetId);
    await expect(runProposeBudgetReallocation(ctx, { resultId, excludeCampaigns: [], explanation: 'again' })).rejects.toThrow('已經送審');
  });

  it('refuses unknown campaigns, stale runs and exclusions that leave nothing to move', async () => {
    const { resultId } = await runBudgetOptimizer(ctx, { account: 'Arlo TW', optimizeFor: null });
    await expect(runProposeBudgetReallocation(ctx, { resultId, excludeCampaigns: ['999'], explanation: 'x' })).rejects.toThrow('不在這次');
    await expect(runProposeBudgetReallocation(ctx, { resultId, excludeCampaigns: ['111', '112'], explanation: 'x' })).rejects.toThrow('沒有可調整');
    await expect(runProposeBudgetReallocation({ ...ctx, now: () => new Date(NOW.getTime() + 25 * 3_600_000) }, { resultId, excludeCampaigns: [], explanation: 'x' })).rejects.toThrow('24 小時');
    await expect(runProposeBudgetReallocation({ ...ctx, allowedAccountIds: [] }, { resultId, excludeCampaigns: [], explanation: 'x' })).rejects.toThrow('找不到');
  });
});
