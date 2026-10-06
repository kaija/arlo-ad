import { FakePlatformAdapter, type MetricRow } from '@arlo/adapters/platform';
import { createLogger } from '@arlo/config/logger';
import { listActiveAccounts, schema, type AdAccount } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { Jobs } from '@arlo/queue';
import { count, eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { syncJobs } from '../handlers/sync';
import { cleanupHourlyMetrics, syncAccounts, syncDaily, syncHourly, syncSnapshots, type SyncDeps } from './sync';

const logger = createLogger({ component: 'test', level: 'silent' });
const ACC = '1234567890';
const zero = { costMicros: 0, impressions: 0, clicks: 0, conversions: 0, convValue: 0 };
const metric = (level: MetricRow['level'], externalId: string, date: string, extra: Partial<MetricRow> = {}): MetricRow => ({
  ...zero,
  level,
  externalId,
  date,
  ...extra,
});

function seed(fake = new FakePlatformAdapter()) {
  return fake.addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }).addEntities(ACC, [
    { kind: 'account', externalId: ACC, name: 'Arlo TW', status: 'ENABLED', attrs: {} },
    {
      kind: 'campaign',
      externalId: '111',
      name: 'Brand',
      status: 'ENABLED',
      attrs: {},
      state: { budgetMicros: 3_000_000_000, bidStrategy: 'TARGET_CPA', bidTarget: 250_000_000 },
    },
    { kind: 'ad_group', externalId: '221', parent: { kind: 'campaign', externalId: '111' }, name: 'AG', status: 'ENABLED', attrs: {} },
    { kind: 'keyword', externalId: '221~3001', parent: { kind: 'ad_group', externalId: '221' }, name: 'arlo', status: 'ENABLED', attrs: {} },
  ]);
}

describe('sync', () => {
  const t = useTestDatabase();
  let now = new Date('2026-10-06T04:07:00Z'); // 12:07 in Taipei
  let fake: FakePlatformAdapter;
  let deps: SyncDeps;
  let account: AdAccount;

  const rows = async (table: PgTable) => (await t.db.select({ n: count() }).from(table))[0]!.n;

  beforeAll(async () => {
    fake = seed();
    fake.setClock(() => now);
    deps = { db: t.db, platform: fake, logger, now: () => now };
    account = (await syncAccounts(deps))[0]!;
  });

  it('refreshes accounts and deactivates ones no longer accessible', async () => {
    expect(account).toMatchObject({ externalId: ACC, currency: 'TWD', timezone: 'Asia/Taipei', active: true });
    await t.db.insert(schema.adAccounts).values({
      orgId: account.orgId,
      platform: 'google_ads',
      externalId: '9999999999',
      name: 'Gone',
      currency: 'USD',
      timezone: 'UTC',
    });
    const active = await syncAccounts(deps);
    expect(active.map((a) => a.externalId)).toEqual([ACC]);
    expect((await listActiveAccounts(t.db, 'google_ads')).length).toBe(1);
  });

  describe('snapshots', () => {
    it('stores entities with parents, a slot snapshot and change events; a rerun changes nothing', async () => {
      fake.drift({ platform: 'google_ads', accountId: ACC, kind: 'campaign', id: '111' }, { budgetMicros: 3_500_000_000 });
      const first = await syncSnapshots(deps, account);
      expect(first).toMatchObject({ entities: 4, snapshots: 1, changeEvents: 1 });

      const entities = await t.db.select().from(schema.entities).where(eq(schema.entities.accountId, account.id));
      const byExt = new Map(entities.map((e) => [`${e.kind}:${e.externalId}`, e]));
      expect(byExt.get('campaign:111')?.parentId).toBe(byExt.get(`account:${ACC}`)?.id);
      expect(byExt.get('keyword:221~3001')?.parentId).toBe(byExt.get('ad_group:221')?.id);

      const [snapshot] = await t.db.select().from(schema.entitySnapshots);
      expect(snapshot).toMatchObject({ budgetMicros: 3_500_000_000, bidStrategy: 'TARGET_CPA', bidTarget: 250_000_000, status: 'ENABLED' });
      expect(snapshot!.capturedAt.toISOString()).toBe('2026-10-06T04:00:00.000Z');

      const again = await syncSnapshots(deps, account);
      expect(again).toMatchObject({ snapshots: 0, changeEvents: 0 });
      expect(await rows(schema.entities)).toBe(4);
      expect(await rows(schema.changeEvents)).toBe(1);
    });

    it('takes a new snapshot in the next slot and marks removed entities', async () => {
      now = new Date('2026-10-06T04:16:00Z');
      // The platform stops returning the keyword (removed there).
      const kept = (await fake.fetchEntities(ACC, ['account', 'campaign', 'ad_group', 'keyword'])).filter((r) => r.kind !== 'keyword');
      const fresh = new FakePlatformAdapter()
        .addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' })
        .addEntities(ACC, kept);
      const result = await syncSnapshots({ ...deps, platform: fresh }, account);
      expect(result).toMatchObject({ snapshots: 1, removed: 1 });
      const [kw] = await t.db.select().from(schema.entities).where(eq(schema.entities.externalId, '221~3001'));
      expect(kw?.status).toBe('REMOVED');
      expect(await rows(schema.entitySnapshots)).toBe(2);
    });
  });

  describe('metrics', () => {
    it('hourly sync writes today in the account timezone; rerun is idempotent', async () => {
      // 04:16Z is 2026-10-06 in Taipei.
      fake.addMetrics(ACC, [
        metric('campaign', '111', '2026-10-06', { hour: 9, clicks: 3 }),
        metric('campaign', '111', '2026-10-06', { hour: 10, clicks: 4 }),
        metric('campaign', '111', '2026-10-06', { clicks: 7 }),
        metric('keyword', '221~3001', '2026-10-06', { hour: 9, clicks: 1 }),
        metric('campaign', 'unknown', '2026-10-06', { hour: 9 }),
      ]);
      const first = await syncHourly(deps, account);
      expect(first).toEqual({ date: '2026-10-06', hourly: 3, daily: 1, skipped: 1 });
      await syncHourly(deps, account);
      expect(await rows(schema.metricsHourly)).toBe(3);
      expect(await rows(schema.metricsDaily)).toBe(1);
    });

    it('daily sync re-pulls D-3..D-1 and overwrites backfilled conversions', async () => {
      fake.addMetrics(ACC, [
        metric('campaign', '111', '2026-10-02', { conversions: 9 }), // D-4: outside the window
        metric('campaign', '111', '2026-10-03', { conversions: 1 }),
        metric('campaign', '111', '2026-10-05', { conversions: 2 }),
        metric('account', ACC, '2026-10-05', { conversions: 2 }),
      ]);
      fake.setSearchTerms(ACC, [
        { campaignExternalId: '111', adGroupExternalId: '221', term: 'arlo free', date: '2026-10-05', ...zero, costMicros: 5 },
      ]);
      fake.setConversionActions(ACC, [
        { externalId: '501', name: 'Purchase', status: 'ENABLED', category: 'PURCHASE', primary: true, lastConversionAt: null, ecDiagnostics: null },
      ]);
      const first = await syncDaily(deps, account);
      expect(first).toMatchObject({ range: { from: '2026-10-03', to: '2026-10-05' }, metrics: 3, searchTerms: 1, conversionActions: 1 });

      fake.replaceMetrics(ACC, [metric('campaign', '111', '2026-10-05', { conversions: 5 })]);
      await syncDaily(deps, account);
      const daily = await t.db.select().from(schema.metricsDaily).where(eq(schema.metricsDaily.date, '2026-10-05'));
      expect(daily.map((d) => [d.level, d.conversions]).sort()).toEqual([
        ['account', 2],
        ['campaign', 5],
      ]);
      expect(await rows(schema.gSearchTerms)).toBe(1);
      expect(await rows(schema.gConversionActions)).toBe(1);
    });

    it('drops hourly metrics older than 14 days', async () => {
      const [entity] = await t.db.select().from(schema.entities).where(eq(schema.entities.externalId, '111'));
      await t.db.insert(schema.metricsHourly).values({
        orgId: account.orgId,
        accountId: account.id,
        entityId: entity!.id,
        level: 'campaign',
        date: '2026-09-20',
        hour: 1,
      });
      expect(await cleanupHourlyMetrics(deps)).toBe(1);
      expect(await rows(schema.metricsHourly)).toBe(3);
    });
  });

  describe('jobs', () => {
    it('fans out one job per active account, then syncs and records each account', async () => {
      const sent: { name: string; data: unknown }[] = [];
      const defs = syncJobs({ ...deps, enqueue: async (spec, data) => (sent.push({ name: spec.name, data }), 'id') });
      const hourly = defs.find((d) => d.name === Jobs.syncHourly.name)!;
      const ctx = { id: 'j', retryCount: 0, logger, signal: new AbortController().signal };

      expect(await hourly.handler({}, ctx)).toMatchObject({ accounts: 1 });
      expect(sent).toEqual([{ name: 'sync.hourly', data: { accountId: account.id } }]);

      await hourly.handler({ accountId: account.id }, ctx);
      const [state] = await t.db.select().from(schema.syncState);
      expect(state).toMatchObject({ job: 'sync.hourly', consecutiveFailures: 0, lastSuccessAt: now });
    });

    it('records failures and rethrows so pg-boss retries', async () => {
      const defs = syncJobs({ ...deps, enqueue: async () => 'id' });
      const daily = defs.find((d) => d.name === Jobs.syncDaily.name)!;
      fake.failNext('fetchMetrics', Object.assign(new Error('quota'), { code: 'RESOURCE_EXHAUSTED' }));
      await expect(daily.handler({ accountId: account.id }, { id: 'j', retryCount: 0, logger, signal: new AbortController().signal })).rejects.toThrow('quota');
      const state = (await t.db.select().from(schema.syncState)).find((s) => s.job === 'sync.daily');
      expect(state).toMatchObject({ consecutiveFailures: 1, lastError: 'RESOURCE_EXHAUSTED', lastSuccessAt: null });
    });
  });
});
