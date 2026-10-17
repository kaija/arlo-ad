import { FakePlatformAdapter, type MetricRow } from '@arlo/adapters/platform';
import { createLogger } from '@arlo/config/logger';
import { schema, type AdAccount } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { count, eq } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { backfillMetrics, syncAccounts, syncSnapshots, type SyncDeps } from './sync';

const logger = createLogger({ component: 'test', level: 'silent' });
const ACC = '1234567890';
const zero = { costMicros: 0, impressions: 0, clicks: 0, conversions: 0, convValue: 0 };
const metric = (level: MetricRow['level'], externalId: string, date: string, extra: Partial<MetricRow> = {}): MetricRow => ({ ...zero, level, externalId, date, ...extra });

/** Ranges fetchMetrics was asked for, in call order. */
class RecordingPlatform extends FakePlatformAdapter {
  readonly ranges: string[] = [];
  override async fetchMetrics(q: Parameters<FakePlatformAdapter['fetchMetrics']>[0]) {
    if (q.level === 'campaign') this.ranges.push(`${q.range.from}..${q.range.to}`);
    return super.fetchMetrics(q);
  }
}

describe('backfillMetrics', () => {
  const t = useTestDatabase();
  const now = new Date('2026-10-17T04:00:00Z'); // 12:00 in Taipei
  let fake: RecordingPlatform;
  let deps: SyncDeps;
  let account: AdAccount;

  const rows = async (table: PgTable) => (await t.db.select({ n: count() }).from(table))[0]!.n;

  beforeAll(async () => {
    fake = new RecordingPlatform();
    fake.addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }).addEntities(ACC, [
      { kind: 'account', externalId: ACC, name: 'Arlo TW', status: 'ENABLED', attrs: {} },
      { kind: 'campaign', externalId: '111', name: 'Brand', status: 'ENABLED', attrs: {} },
      { kind: 'ad_group', externalId: '221', parent: { kind: 'campaign', externalId: '111' }, name: 'AG', status: 'ENABLED', attrs: {} },
      { kind: 'keyword', externalId: '221~3001', parent: { kind: 'ad_group', externalId: '221' }, name: 'arlo', status: 'ENABLED', attrs: {} },
    ]);
    deps = { db: t.db, platform: fake, logger, now: () => now };
    account = (await syncAccounts(deps))[0]!;
    await syncSnapshots(deps, account);

    const metrics: MetricRow[] = [];
    // One row per level per day for D-20..D-1 (2026-09-27..2026-10-16), plus today and older history.
    for (let day = 27; day <= 46; day++) {
      const date = day <= 30 ? `2026-09-${day}` : `2026-10-${String(day - 30).padStart(2, '0')}`;
      metrics.push(metric('account', ACC, date, { costMicros: 10 }), metric('campaign', '111', date, { clicks: 2 }), metric('ad_group', '221', date), metric('keyword', '221~3001', date));
    }
    metrics.push(
      metric('campaign', '111', '2026-10-17', { clicks: 99 }), // today: the hourly sync's job
      metric('campaign', '111', '2026-09-26'), // D-21: outside --days 20
      metric('campaign', 'removed-before-onboarding', '2026-10-01'),
      metric('keyword', '221~9999', '2026-10-02'),
    );
    fake.addMetrics(ACC, metrics);
    fake.setSearchTerms(ACC, [
      { campaignExternalId: '111', adGroupExternalId: '221', term: 'arlo cam', date: '2026-09-28', ...zero, clicks: 1 },
      { campaignExternalId: '999', adGroupExternalId: '998', term: 'gone', date: '2026-09-28', ...zero },
    ]);
  });

  it('pulls D-days..D-1 newest chunk first and skips unknown entities', async () => {
    const result = await backfillMetrics(deps, account, { days: 20, chunkDays: 7 });
    expect(fake.ranges).toEqual(['2026-10-10..2026-10-16', '2026-10-03..2026-10-09', '2026-09-27..2026-10-02']);
    expect(result).toEqual({ range: { from: '2026-09-27', to: '2026-10-16' }, chunks: 3, metrics: 80, searchTerms: 1, skipped: 3 });

    const campaign = await t.db.select().from(schema.metricsDaily).where(eq(schema.metricsDaily.level, 'campaign'));
    expect(campaign).toHaveLength(20);
    expect(campaign.map((r) => r.date).sort().at(0)).toBe('2026-09-27');
    expect(campaign.some((r) => r.date === '2026-10-17')).toBe(false);
  });

  it('is idempotent and overwrites with the platform values on a rerun', async () => {
    expect(await backfillMetrics(deps, account, { days: 20, chunkDays: 7 })).toMatchObject({ metrics: 80, searchTerms: 1 });
    expect(await rows(schema.metricsDaily)).toBe(80);
    expect(await rows(schema.gSearchTerms)).toBe(1);

    fake.replaceMetrics(ACC, [metric('campaign', '111', '2026-10-05', { clicks: 5 })]);
    const again = await backfillMetrics(deps, account, { days: 20, chunkDays: 7, searchTerms: false });
    expect(again).toMatchObject({ chunks: 3, metrics: 80, searchTerms: 0, skipped: 2 });
    expect(await rows(schema.metricsDaily)).toBe(80);
    expect(await rows(schema.gSearchTerms)).toBe(1);
    const [row] = await t.db.select().from(schema.metricsDaily).where(eq(schema.metricsDaily.date, '2026-10-05')).then((r) => r.filter((m) => m.level === 'campaign'));
    expect(row?.clicks).toBe(5);
  });

  it('handles a range shorter than one chunk and rejects a bad day count', async () => {
    fake.ranges.length = 0;
    await backfillMetrics(deps, account, { days: 3 });
    expect(fake.ranges).toEqual(['2026-10-14..2026-10-16']);
    await expect(backfillMetrics(deps, account, { days: 0 })).rejects.toThrow('positive integer');
  });
});
