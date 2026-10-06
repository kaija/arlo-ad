import { and, asc, count, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adAccounts,
  changeEvents,
  DEFAULT_ORG_ID,
  entities,
  entitySnapshots,
  ga4Daily,
  gAudienceMetrics,
  gConversionActions,
  gSearchTerms,
  metricsDaily,
  metricsHourly,
} from '../schema';
import { useTestDatabase } from '../testing';
import {
  insertChangeEvents,
  insertEntitySnapshots,
  upsertAdAccounts,
  upsertAudienceMetrics,
  upsertConversionActions,
  upsertEntities,
  upsertGa4Daily,
  upsertMetricsDaily,
  upsertMetricsHourly,
  upsertSearchTerms,
} from './platform';

const orgId = DEFAULT_ORG_ID;

// Drizzle wraps driver errors; the SQLSTATE lives on the pg error in `cause`.
async function sqlState(query: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await query;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

describe('platform repositories', () => {
  const t = useTestDatabase();
  let accountId: string;
  let otherAccountId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const accounts = await upsertAdAccounts(t.db, [
      { orgId, platform: 'google_ads', externalId: '1234567890', name: 'Main', currency: 'TWD', timezone: 'Asia/Taipei' },
      { orgId, platform: 'google_ads', externalId: '1112223333', name: 'Other', currency: 'USD', timezone: 'UTC' },
    ]);
    accountId = accounts.find((a) => a.externalId === '1234567890')!.id;
    otherAccountId = accounts.find((a) => a.externalId === '1112223333')!.id;

    const [account] = await upsertEntities(t.db, [{ orgId, accountId, kind: 'account', externalId: '1234567890' }]);
    const [campaign] = await upsertEntities(t.db, [
      { orgId, accountId, kind: 'campaign', externalId: '111', parentId: account!.id, name: 'Brand', status: 'ENABLED' },
    ]);
    const [adGroup] = await upsertEntities(t.db, [
      { orgId, accountId, kind: 'ad_group', externalId: '222', parentId: campaign!.id, name: 'Brand AG' },
    ]);
    const [keyword] = await upsertEntities(t.db, [
      { orgId, accountId, kind: 'keyword', externalId: '222~333', parentId: adGroup!.id, name: 'arlo camera' },
    ]);
    Object.assign(ids, { account: account!.id, campaign: campaign!.id, adGroup: adGroup!.id, keyword: keyword!.id });
  });

  describe('ad_accounts / entities', () => {
    it('updates in place on re-sync and keeps ids stable', async () => {
      const [again] = await upsertAdAccounts(t.db, [
        { orgId, platform: 'google_ads', externalId: '1234567890', name: 'Main (renamed)', currency: 'TWD', timezone: 'Asia/Taipei' },
      ]);
      expect(again!.id).toBe(accountId);
      const [row] = await t.db.select().from(adAccounts).where(eq(adAccounts.id, accountId));
      expect(row!.name).toBe('Main (renamed)');

      const [campaign] = await upsertEntities(t.db, [
        { orgId, accountId, kind: 'campaign', externalId: '111', parentId: ids.account, name: 'Brand', status: 'PAUSED' },
      ]);
      expect(campaign!.id).toBe(ids.campaign);
      const [entity] = await t.db.select().from(entities).where(eq(entities.id, ids.campaign!));
      expect(entity!.status).toBe('PAUSED');
    });

    it('keys external ids per account and kind', async () => {
      // Same external id as the campaign, different kind and account: distinct entities.
      const rows = await upsertEntities(t.db, [
        { orgId, accountId, kind: 'campaign_budget', externalId: '111' },
        { orgId, accountId: otherAccountId, kind: 'campaign', externalId: '111' },
      ]);
      expect(new Set([...rows.map((r) => r.id), ids.campaign]).size).toBe(3);
    });

    it('rejects a non-ISO currency', async () => {
      expect(
        await sqlState(
          upsertAdAccounts(t.db, [
            { orgId, platform: 'google_ads', externalId: '9999999999', name: 'x', currency: 'usd', timezone: 'UTC' },
          ]),
        ),
      ).toBe('23514');
    });
  });

  describe('metrics_daily', () => {
    const row = (date: string, clicks: number) => ({
      orgId,
      accountId,
      entityId: ids.campaign!,
      level: 'campaign' as const,
      date,
      costMicros: clicks * 1_500_000,
      impressions: clicks * 20,
      clicks,
      conversions: clicks / 10,
      convValue: clicks * 12.5,
      searchIs: 0.8125,
      lostIsBudget: 0.1,
      lostIsRank: 0.0875,
    });

    it('is idempotent and overwrites on backfill', async () => {
      const days = [row('2026-10-01', 100), row('2026-10-02', 120)];
      await upsertMetricsDaily(t.db, days);
      await upsertMetricsDaily(t.db, days);
      expect((await t.db.select({ n: count() }).from(metricsDaily))[0]!.n).toBe(2);

      // D-3..D-1 re-pull with late conversions replaces the earlier numbers.
      await upsertMetricsDaily(t.db, [{ ...row('2026-10-01', 100), conversions: 14.25, convValue: 2000 }]);
      const stored = await t.db.select().from(metricsDaily).orderBy(asc(metricsDaily.date));
      expect(stored.map((r) => [r.date, r.clicks, r.conversions, r.convValue])).toEqual([
        ['2026-10-01', 100, 14.25, 2000],
        ['2026-10-02', 120, 12, 1500],
      ]);
      expect(stored[0]).toMatchObject({ costMicros: 150_000_000, searchIs: 0.8125, lostIsRank: 0.0875 });
    });

    it('rejects a row whose account or level disagrees with its entity', async () => {
      expect(await sqlState(upsertMetricsDaily(t.db, [{ ...row('2026-10-03', 1), level: 'ad_group' }]))).toBe('23503');
      expect(await sqlState(upsertMetricsDaily(t.db, [{ ...row('2026-10-03', 1), accountId: otherAccountId }]))).toBe(
        '23503',
      );
    });

    it('writes large syncs in batches under the parameter limit', async () => {
      const dates = Array.from({ length: 7000 }, (_, i) => new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10));
      const rows = dates.map((d, i) => ({ ...row(d, i), entityId: ids.keyword!, level: 'keyword' as const }));
      expect(await upsertMetricsDaily(t.db, rows)).toBe(7000);
      expect(await upsertMetricsDaily(t.db, rows)).toBe(7000);
      const [{ n }] = (await t.db.select({ n: count() }).from(metricsDaily).where(eq(metricsDaily.entityId, ids.keyword!))) as [
        { n: number },
      ];
      expect(n).toBe(7000);
    });
  });

  describe('metrics_hourly', () => {
    it('is idempotent per hour and validates the hour', async () => {
      const base = { orgId, accountId, entityId: ids.account!, level: 'account' as const, date: '2026-10-06' };
      await upsertMetricsHourly(t.db, [{ ...base, hour: 9, clicks: 5 }, { ...base, hour: 10, clicks: 7 }]);
      await upsertMetricsHourly(t.db, [{ ...base, hour: 10, clicks: 9 }]);
      const rows = await t.db.select().from(metricsHourly).orderBy(asc(metricsHourly.hour));
      expect(rows.map((r) => [r.hour, r.clicks])).toEqual([
        [9, 5],
        [10, 9],
      ]);
      expect(await sqlState(upsertMetricsHourly(t.db, [{ ...base, hour: 24 }]))).toBe('23514');
    });
  });

  describe('entity_snapshots', () => {
    it('inserts each capture once', async () => {
      const snap = {
        orgId,
        entityId: ids.campaign!,
        capturedAt: new Date('2026-10-06T01:15:00Z'),
        budgetMicros: 5_000_000_000,
        status: 'ENABLED',
        bidStrategy: 'TARGET_CPA',
        bidTarget: 250_000_000,
        raw: { resourceName: 'customers/1234567890/campaigns/111' },
      };
      expect(await insertEntitySnapshots(t.db, [snap])).toBe(1);
      expect(await insertEntitySnapshots(t.db, [snap, { ...snap, capturedAt: new Date('2026-10-06T01:30:00Z') }])).toBe(1);
      const rows = await t.db.select().from(entitySnapshots);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ budgetMicros: 5_000_000_000, bidTarget: 250_000_000 });
    });
  });

  describe('change_events', () => {
    it('never rewrites a stored event', async () => {
      const event = {
        orgId,
        accountId,
        externalId: 'customers/1234567890/changeEvents/1759712400000000~1~0',
        changedAt: new Date('2026-10-06T00:00:00Z'),
        userEmail: 'pat@example.com',
        clientType: 'GOOGLE_ADS_WEB_CLIENT',
        resourceType: 'CAMPAIGN_BUDGET',
        resourceName: 'customers/1234567890/campaignBudgets/444',
        changedFields: ['amount_micros'],
        old: { amountMicros: '5000000000' },
        new: { amountMicros: '6000000000' },
      };
      expect(await insertChangeEvents(t.db, [event])).toBe(1);
      expect(await insertChangeEvents(t.db, [{ ...event, userEmail: 'tampered@example.com' }])).toBe(0);
      const rows = await t.db.select().from(changeEvents);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userEmail: 'pat@example.com', changedFields: ['amount_micros'] });
    });
  });

  describe('Google extension tables', () => {
    it('upserts search terms by ad group, term and date', async () => {
      const term = {
        orgId,
        accountId,
        campaignId: ids.campaign!,
        adGroupId: ids.adGroup!,
        term: 'arlo camera price',
        date: '2026-10-05',
        clicks: 3,
        costMicros: 4_500_000,
      };
      await upsertSearchTerms(t.db, [term]);
      await upsertSearchTerms(t.db, [{ ...term, clicks: 4, conversions: 1 }]);
      const rows = await t.db.select().from(gSearchTerms);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ clicks: 4, conversions: 1, costMicros: 4_500_000 });
    });

    it('updates conversion actions in place', async () => {
      const action = { orgId, accountId, externalId: '555', name: 'Purchase', status: 'ENABLED', primary: true };
      const [first] = await upsertConversionActions(t.db, [action]);
      const lastConversionAt = new Date('2026-10-05T12:00:00Z');
      const [second] = await upsertConversionActions(t.db, [{ ...action, status: 'HIDDEN', lastConversionAt }]);
      expect(second!.id).toBe(first!.id);
      const [row] = await t.db.select().from(gConversionActions).where(eq(gConversionActions.id, first!.id));
      expect(row).toMatchObject({ status: 'HIDDEN', primary: true, lastConversionAt });
    });

    it('upserts audience metrics by campaign, user list and date', async () => {
      const audience = {
        orgId,
        accountId,
        campaignId: ids.campaign!,
        userListId: '777',
        userListName: 'Past buyers',
        targetingMode: 'OBSERVATION',
        date: '2026-10-05',
        clicks: 10,
      };
      await upsertAudienceMetrics(t.db, [audience]);
      await upsertAudienceMetrics(t.db, [{ ...audience, clicks: 11 }]);
      const rows = await t.db.select().from(gAudienceMetrics);
      expect(rows.map((r) => r.clicks)).toEqual([11]);
    });

    it('upserts GA4 daily rows by property, date and source/medium', async () => {
      const ga = { orgId, propertyId: '987654', date: '2026-10-05', sourceMedium: 'google / cpc', sessions: 100, conversions: 4 };
      await upsertGa4Daily(t.db, [ga, { ...ga, sourceMedium: '(direct) / (none)', sessions: 40 }]);
      await upsertGa4Daily(t.db, [{ ...ga, sessions: 105 }]);
      const rows = await t.db
        .select({ sm: ga4Daily.sourceMedium, sessions: ga4Daily.sessions })
        .from(ga4Daily)
        .orderBy(asc(ga4Daily.sourceMedium));
      expect(rows).toEqual([
        { sm: '(direct) / (none)', sessions: 40 },
        { sm: 'google / cpc', sessions: 105 },
      ]);
    });
  });

  it('refreshes updated_at on upsert but keeps created_at', async () => {
    const [before] = await t.db.select().from(adAccounts).where(eq(adAccounts.id, accountId));
    await t.db.execute(sql`select pg_sleep(0.01)`);
    await upsertAdAccounts(t.db, [
      { orgId, platform: 'google_ads', externalId: '1234567890', name: 'Main', currency: 'TWD', timezone: 'Asia/Taipei' },
    ]);
    const [after] = await t.db
      .select()
      .from(adAccounts)
      .where(and(eq(adAccounts.id, accountId), eq(adAccounts.orgId, orgId)));
    expect(after!.createdAt).toEqual(before!.createdAt);
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });
});
