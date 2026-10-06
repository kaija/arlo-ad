import { addDays, type Op } from '@arlo/core';
import { applyTransition, DEFAULT_ORG_ID, insertChangeEvents, insertChangeSet, insertEntitySnapshots, resolveAccounts, upsertAdAccounts, upsertEntities, upsertMetricsDaily } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { accountOverviews, campaignTable, trend } from './dashboard';

const orgId = DEFAULT_ORG_ID;
const M = 1_000_000;
const now = new Date('2026-10-06T04:00:00Z'); // 12:00 Taipei

describe('dashboard query layer', () => {
  const t = useTestDatabase();
  let accountId: string;
  let brand: string;

  beforeAll(async () => {
    accountId = (await upsertAdAccounts(t.db, [
      { orgId, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' },
    ]))[0]!.id;
    const [acc] = await upsertEntities(t.db, [{ orgId, accountId, kind: 'account', externalId: '1234567890' }]);
    const campaigns = await upsertEntities(t.db, [
      { orgId, accountId, kind: 'campaign', externalId: '111', parentId: acc!.id, name: 'Brand', status: 'ENABLED' },
      { orgId, accountId, kind: 'campaign', externalId: '112', parentId: acc!.id, name: 'Idle', status: 'PAUSED' },
    ]);
    brand = campaigns.find((c) => c.externalId === '111')!.id;
    const idle = campaigns.find((c) => c.externalId === '112')!.id;
    await insertEntitySnapshots(t.db, [
      { orgId, entityId: brand, capturedAt: now, budgetMicros: 1000 * M, status: 'ENABLED', bidStrategy: 'TARGET_CPA', bidTarget: 200 * M },
      { orgId, entityId: idle, capturedAt: now, budgetMicros: 300 * M, status: 'PAUSED' },
    ]);
    const rows = [];
    for (let d = '2026-09-01'; d <= '2026-10-06'; d = addDays(d, 1)) {
      const today = d === '2026-10-06';
      rows.push({ orgId, accountId, entityId: acc!.id, level: 'account' as const, date: d, costMicros: (today ? 400 : 1000) * M, impressions: 1000, clicks: 100, conversions: 5 });
      rows.push({
        orgId,
        accountId,
        entityId: brand,
        level: 'campaign' as const,
        date: d,
        costMicros: (today ? 400 : 1000) * M,
        impressions: 1000,
        clicks: 100,
        conversions: 5,
        convValue: 10_000,
        searchIs: 0.7,
        lostIsBudget: 0.1,
        lostIsRank: 0.2,
      });
    }
    await upsertMetricsDaily(t.db, rows);
    await insertChangeEvents(t.db, [
      {
        orgId,
        accountId,
        externalId: 'ce-1',
        changedAt: new Date('2026-10-02T17:00:00Z'), // 10-03 01:00 Taipei
        userEmail: 'pat@example.com',
        resourceType: 'CAMPAIGN_BUDGET',
        resourceName: 'customers/1234567890/campaigns/111',
        changedFields: ['amount_micros'],
      },
      { orgId, accountId, externalId: 'ce-2', changedAt: new Date('2026-09-01T00:00:00Z'), resourceName: 'customers/1234567890/campaigns/111', changedFields: ['status'] },
    ]);
  });

  it('overview: MTD, forecast and budget pace per account', async () => {
    const [o] = await accountOverviews(t.db, { allowed: null, now });
    expect(o).toMatchObject({
      today: '2026-10-06',
      monthStart: '2026-10-01',
      mtdMicros: 5400 * M,
      projectedMicros: 31_000 * M,
      linearProjectedMicros: 31_000 * M,
      enabledBudgetMicros: 1000 * M,
      daysElapsed: 5,
      daysInMonth: 31,
      monthlyCapMicros: null,
    });
    expect(o!.budgetPace).toBeCloseTo(5400 / 6000);
    expect(await accountOverviews(t.db, { allowed: [], now })).toEqual([]);
  });

  it('campaign table: every campaign with metrics, IS and lost IS, sorted by spend', async () => {
    const rows = await campaignTable(t.db, { accountId, from: '2026-10-01', to: '2026-10-05' });
    expect(rows.map((r) => r.name)).toEqual(['Brand', 'Idle']);
    expect(rows[0]).toMatchObject({
      costMicros: 5000 * M,
      clicks: 500,
      conversions: 25,
      ctr: 0.1,
      cpcMicros: 10 * M,
      cpaMicros: 200 * M,
      roas: 10,
      searchIs: 0.7,
      lostIsBudget: 0.1,
      lostIsRank: 0.2,
      budgetMicros: 1000 * M,
      bidStrategy: 'TARGET_CPA',
    });
    expect(rows[1]).toMatchObject({ costMicros: 0, cpaMicros: null, status: 'PAUSED' });
  });

  it('trend: a point per day with change markers on account-local dates', async () => {
    const [account] = await resolveAccounts(t.db, { allowed: null });
    const { points, markers } = await trend(t.db, { account: account!, from: '2026-10-01', to: '2026-10-06' });
    expect(points.map((p) => [p.date, p.costMicros / M])).toEqual([
      ['2026-10-01', 1000],
      ['2026-10-02', 1000],
      ['2026-10-03', 1000],
      ['2026-10-04', 1000],
      ['2026-10-05', 1000],
      ['2026-10-06', 400],
    ]);
    expect(markers).toEqual([{ date: '2026-10-03', at: '2026-10-02T17:00:00.000Z', kind: 'change_event', label: 'CAMPAIGN_BUDGET amount_micros', actor: 'pat@example.com' }]);

    const campaign = await trend(t.db, { account: account!, from: '2026-10-05', to: '2026-10-05', campaignId: brand, externalCampaignId: '111' });
    expect(campaign.points).toHaveLength(1);
    expect(campaign.points[0]).toMatchObject({ cpaMicros: 200 * M });
  });

  it('trend: executed ChangeSets are markers too, filtered by campaign', async () => {
    const [account] = await resolveAccounts(t.db, { allowed: null });
    const op = (id: string): Op => ({ kind: 'set_status', target: { platform: 'google_ads', accountId: '1234567890', kind: 'campaign', id }, field: 'status', before: 'ENABLED', after: 'PAUSED' });
    for (const [id, summary] of [['111', 'pause Brand'], ['112', 'pause Idle']] as const) {
      const cs = await insertChangeSet(t.db, { accountId: account!.id, source: { kind: 'monitor' }, ops: [op(id)], summary, requestedBy: { kind: 'system' } });
      const running = await applyTransition(t.db, cs, { type: 'auto_execute', tier: 1 }, { kind: 'system' });
      if (running.ok) await applyTransition(t.db, running.changeset, { type: 'executed', at: new Date('2026-10-04T02:00:00Z') }, { kind: 'system' });
    }
    const all = await trend(t.db, { account: account!, from: '2026-10-01', to: '2026-10-06' });
    expect(all.markers.filter((m) => m.kind === 'changeset').map((m) => [m.date, m.label])).toEqual([
      ['2026-10-04', 'ChangeSet：pause Brand'],
      ['2026-10-04', 'ChangeSet：pause Idle'],
    ]);
    const brandOnly = await trend(t.db, { account: account!, from: '2026-10-01', to: '2026-10-06', campaignId: brand, externalCampaignId: '111' });
    expect(brandOnly.markers.filter((m) => m.kind === 'changeset').map((m) => m.label)).toEqual(['ChangeSet：pause Brand']);
  });
});
