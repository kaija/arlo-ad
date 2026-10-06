import { describe, expect, it } from 'vitest';
import { DEFAULT_ORG_ID } from '../schema';
import { useTestDatabase } from '../testing';
import { listAnomalies, saveAnomalies, setAnomalyExplanation } from './anomalies';
import { upsertAdAccounts, upsertEntities } from './platform';

describe('anomalies repository', () => {
  const t = useTestDatabase();

  it('upserts by (account, entity, day, metric, segment) and lists unexplained ones', async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    const [campaign] = await upsertEntities(t.db, [{ orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'campaign', externalId: '1' }]);
    const a = { date: '2026-10-06', metric: 'clicks' as const, value: 1500, baseline: 500, z: 8, direction: 'up' as const };
    await saveAnomalies(t.db, acc!.id, null, [a]);
    await saveAnomalies(t.db, acc!.id, null, [{ ...a, value: 1600, z: 9 }]);
    await saveAnomalies(t.db, acc!.id, campaign!.id, [a, { ...a, metric: 'clicks', details: { segment: 'VN' } }]);
    const rows = await listAnomalies(t.db, { accountIds: [acc!.id] });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.entityId === null)).toMatchObject({ value: 1600, z: 9 });

    await setAnomalyExplanation(t.db, rows[0]!.id, '原因', new Date());
    expect(await listAnomalies(t.db, { unexplainedOnly: true })).toHaveLength(2);
    expect(await listAnomalies(t.db, { accountIds: [] })).toEqual([]);
  });
});
