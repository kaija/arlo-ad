import { DEFAULT_ORG_ID, insertChangeEvents, insertEntitySnapshots, upsertAdAccounts, upsertEntities, upsertMetricsDaily } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { RunContext } from '@openai/agents';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentContext } from '../context';
import { queryMetricsTool, runGetChangeHistory, runGetPacing, runListCampaigns, runQueryMetrics } from './read';

const orgId = DEFAULT_ORG_ID;
const M = 1_000_000;
// 2026-10-06 12:00 in Taipei.
const now = () => new Date('2026-10-06T04:00:00Z');

describe('analyst read tools', () => {
  const t = useTestDatabase();
  let tw: string;
  let us: string;
  let brand: string;
  let generic: string;
  const ctx = (allowed: string[] | null = null): AgentContext => ({ db: t.db, allowedAccountIds: allowed, now });

  beforeAll(async () => {
    const accounts = await upsertAdAccounts(t.db, [
      { orgId, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' },
      { orgId, platform: 'google_ads', externalId: '2234567890', name: 'Arlo US', currency: 'USD', timezone: 'America/Los_Angeles' },
    ]);
    tw = accounts.find((a) => a.externalId === '1234567890')!.id;
    us = accounts.find((a) => a.externalId === '2234567890')!.id;
    const [twAccount] = await upsertEntities(t.db, [{ orgId, accountId: tw, kind: 'account', externalId: '1234567890' }]);
    const campaigns = await upsertEntities(t.db, [
      { orgId, accountId: tw, kind: 'campaign', externalId: '111', parentId: twAccount!.id, name: 'Brand', status: 'ENABLED' },
      { orgId, accountId: tw, kind: 'campaign', externalId: '112', parentId: twAccount!.id, name: 'Generic', status: 'PAUSED' },
      { orgId, accountId: tw, kind: 'campaign', externalId: '113', parentId: twAccount!.id, name: 'Old', status: 'REMOVED' },
    ]);
    brand = campaigns.find((c) => c.externalId === '111')!.id;
    generic = campaigns.find((c) => c.externalId === '112')!.id;
    await insertEntitySnapshots(t.db, [
      { orgId, entityId: brand, capturedAt: new Date('2026-10-06T03:45:00Z'), budgetMicros: 900 * M, status: 'ENABLED', bidStrategy: 'TARGET_CPA', bidTarget: 250 * M },
      { orgId, entityId: brand, capturedAt: new Date('2026-10-06T03:30:00Z'), budgetMicros: 800 * M, status: 'ENABLED', bidStrategy: 'TARGET_CPA', bidTarget: 250 * M },
      { orgId, entityId: generic, capturedAt: new Date('2026-10-06T03:45:00Z'), budgetMicros: 500 * M, status: 'PAUSED', bidStrategy: 'TARGET_ROAS', bidTarget: 4.5 },
    ]);

    const days = Array.from({ length: 35 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)); // 09-01..10-05
    const metric = (entityId: string, level: 'account' | 'campaign', date: string, cost: number, conv: number) => ({
      orgId,
      accountId: tw,
      entityId,
      level,
      date,
      costMicros: cost * M,
      impressions: 1000,
      clicks: 50,
      conversions: conv,
      convValue: conv * 3000,
      searchIs: 0.8,
      lostIsBudget: 0.05,
      lostIsRank: 0.15,
    });
    await upsertMetricsDaily(t.db, [
      ...days.map((d) => metric(twAccount!.id, 'account', d, 1000, 4)),
      ...days.map((d) => metric(brand, 'campaign', d, 600, 3)),
      ...days.map((d) => metric(generic, 'campaign', d, 400, 1)),
    ]);
    await insertChangeEvents(t.db, [
      {
        orgId,
        accountId: tw,
        externalId: 'ce-1',
        changedAt: new Date('2026-10-04T02:00:00Z'),
        userEmail: 'pat@example.com',
        clientType: 'GOOGLE_ADS_WEB_CLIENT',
        resourceType: 'CAMPAIGN_BUDGET',
        resourceName: 'customers/1234567890/campaignBudgets/901',
        changedFields: ['amount_micros'],
        old: { amount_micros: 800 * M },
        new: { amount_micros: 900 * M },
      },
    ]);
  });

  it('query_metrics: totals for the default last 7 days with derived ratios', async () => {
    const r = await runQueryMetrics(ctx(), { account: 'Arlo TW', level: 'account', from: null, to: null, groupBy: 'total', campaigns: null, limit: null });
    expect(r.accounts).toEqual([
      {
        account: 'Arlo TW',
        customerId: '1234567890',
        currency: 'TWD',
        from: '2026-09-29',
        to: '2026-10-05',
        rows: [
          {
            cost: 7000,
            impressions: 7000,
            clicks: 350,
            conversions: 28,
            convValue: 84000,
            ctr: 0.05,
            cpc: 20,
            cpa: 250,
            roas: 12,
            searchImpressionShare: 0.8,
            lostIsBudget: 0.05,
            lostIsRank: 0.15,
          },
        ],
      },
    ]);
  });

  it('query_metrics: per campaign, filtered by campaign id, and per day', async () => {
    const byEntity = await runQueryMetrics(ctx(), { account: '123-456-7890', level: 'campaign', from: '2026-10-01', to: '2026-10-05', groupBy: 'entity', campaigns: null, limit: null });
    expect(byEntity.accounts[0]!.rows.map((r) => [r.name, r.cost])).toEqual([
      ['Brand', 3000],
      ['Generic', 2000],
    ]);
    const filtered = await runQueryMetrics(ctx(), { account: null, level: 'campaign', from: '2026-10-05', to: '2026-10-05', groupBy: 'day', campaigns: ['112'], limit: null });
    expect(filtered.accounts).toHaveLength(1);
    expect(filtered.accounts[0]!.rows).toEqual([expect.objectContaining({ date: '2026-10-05', cost: 400 })]);
  });

  it('query_metrics: rejects bad input with a message for the model', async () => {
    await expect(runQueryMetrics(ctx(), { account: null, level: 'account', from: '2026-10-05', to: '2026-10-01', groupBy: 'total', campaigns: null, limit: null })).rejects.toThrow('from ≤ to');
    await expect(runQueryMetrics(ctx(), { account: null, level: 'keyword', from: null, to: null, groupBy: 'total', campaigns: ['111'], limit: null })).rejects.toThrow('level=campaign');
  });

  it('scopes every tool to the accounts the user may read', async () => {
    await expect(runListCampaigns(ctx([us]), { account: 'Arlo TW', includePaused: null })).rejects.toThrow('找不到你有權限的帳戶');
    const all = await runListCampaigns(ctx([us]), { account: null, includePaused: null });
    expect(all.campaigns).toEqual([]);
    const metrics = await runQueryMetrics(ctx([us]), { account: null, level: 'account', from: null, to: null, groupBy: 'total', campaigns: null, limit: null });
    expect(metrics.accounts.map((a) => a.account)).toEqual(['Arlo US']);
  });

  it('list_campaigns: latest snapshot state, removed campaigns hidden', async () => {
    const r = await runListCampaigns(ctx(), { account: 'Arlo TW', includePaused: null });
    expect(r.campaigns).toEqual([
      expect.objectContaining({ name: 'Brand', status: 'ENABLED', dailyBudget: 900, bidStrategy: 'TARGET_CPA', target: { cpa: 250 } }),
      expect.objectContaining({ name: 'Generic', status: 'PAUSED', dailyBudget: 500, target: { roas: 4.5 } }),
    ]);
    const enabledOnly = await runListCampaigns(ctx(), { account: 'Arlo TW', includePaused: false });
    expect(enabledOnly.campaigns.map((c) => c.name)).toEqual(['Brand']);
  });

  it('get_pacing: month to date and forecast in the account timezone', async () => {
    const r = await runGetPacing(ctx(), { account: 'Arlo TW' });
    expect(r.accounts[0]).toMatchObject({
      today: '2026-10-06',
      monthToDate: 5000,
      projectedMonthTotal: 31000,
      dailyRunRate: 1000,
      enabledDailyBudgets: 900,
      daysElapsed: 5,
      daysInMonth: 31,
    });
  });

  it('get_change_history: events with who and what', async () => {
    const r = await runGetChangeHistory(ctx(), { account: 'Arlo TW', from: '2026-10-01', to: '2026-10-05', resource: '901', limit: null });
    expect(r.events).toEqual([
      expect.objectContaining({ account: 'Arlo TW', user: 'pat@example.com', fields: ['amount_micros'], new: { amount_micros: 900 * M } }),
    ]);
    const none = await runGetChangeHistory(ctx(), { account: 'Arlo TW', from: '2026-10-05', to: '2026-10-05', resource: null, limit: null });
    expect(none.events).toEqual([]);
  });

  it('tool wrappers parse JSON arguments and read the run context', async () => {
    const out = await queryMetricsTool.invoke(
      new RunContext<AgentContext>(ctx()),
      JSON.stringify({ account: 'Arlo TW', level: 'account', from: '2026-10-05', to: '2026-10-05', groupBy: 'total', campaigns: null, limit: null }),
    );
    expect(JSON.stringify(out)).toContain('"cost":1000');
  });
});
