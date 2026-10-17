// Regression: accounts with more keywords than Postgres has bind parameters (65535) per statement.
import { FakePlatformAdapter, type EntityRecord } from '@arlo/adapters/platform';
import { createLogger } from '@arlo/config/logger';
import { schema } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { and, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { syncAccounts, syncSnapshots, type SyncDeps } from './sync';

const logger = createLogger({ component: 'test', level: 'silent' });
const ACC = '1234567890';
const KEYWORDS = 70_000;

function platform(keywords: number) {
  const records: EntityRecord[] = [
    { kind: 'account', externalId: ACC, name: 'Large', status: 'ENABLED', attrs: {} },
    { kind: 'campaign', externalId: '111', name: 'Brand', status: 'ENABLED', attrs: {}, state: { budgetMicros: 1_000_000, bidStrategy: 'MANUAL_CPC', bidTarget: null } },
    { kind: 'ad_group', externalId: '221', parent: { kind: 'campaign', externalId: '111' }, name: 'AG', status: 'ENABLED', attrs: {} },
  ];
  for (let i = 0; i < keywords; i++) {
    records.push({ kind: 'keyword', externalId: `221~${i}`, parent: { kind: 'ad_group', externalId: '221' }, name: `kw ${i}`, status: 'ENABLED', attrs: {} });
  }
  return new FakePlatformAdapter().addAccount({ externalId: ACC, name: 'Large', currency: 'USD', timezone: 'UTC' }).addEntities(ACC, records);
}

describe('syncSnapshots on a large account', () => {
  const t = useTestDatabase();

  it('stores and marks removed more keywords than one statement has bind parameters', { timeout: 120_000 }, async () => {
    const now = new Date('2026-10-06T04:07:00Z');
    const deps: SyncDeps = { db: t.db, platform: platform(KEYWORDS), logger, now: () => now };
    const account = (await syncAccounts(deps))[0]!;

    const first = await syncSnapshots(deps, account);
    expect(first).toMatchObject({ entities: KEYWORDS + 3, removed: 0, snapshots: 1 });

    // The platform stops returning the last keyword; the kept list still exceeds 65535 ids.
    const second = await syncSnapshots({ ...deps, platform: platform(KEYWORDS - 1) }, account);
    expect(second).toMatchObject({ entities: KEYWORDS + 2, removed: 1 });

    const keywords = and(eq(schema.entities.accountId, account.id), eq(schema.entities.kind, 'keyword'));
    const [removed] = await t.db.select({ n: count() }).from(schema.entities).where(and(keywords, eq(schema.entities.status, 'REMOVED')));
    expect(removed!.n).toBe(1);
    const [gone] = await t.db.select().from(schema.entities).where(and(keywords, eq(schema.entities.externalId, `221~${KEYWORDS - 1}`)));
    expect(gone?.status).toBe('REMOVED');
  });
});
