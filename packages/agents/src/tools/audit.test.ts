import { DEFAULT_ORG_ID, insertChangeEvents, saveAnomalies, upsertAdAccounts, upsertConversionActions } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../context';
import { runGetAnomalies, runGetChangesAround, runGetTrackingHealth } from './audit';

describe('audit tools', () => {
  const t = useTestDatabase();
  const now = () => new Date('2026-10-07T04:00:00Z');

  it('reports tracking health, anomalies and nearby changes within scope', async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    await upsertConversionActions(t.db, [
      { orgId: DEFAULT_ORG_ID, accountId: acc!.id, externalId: '501', name: 'Purchase', status: 'ENABLED', category: 'PURCHASE', primary: true, lastConversionAt: new Date('2026-10-05T00:00:00Z'), conversions30d: 90, ecDiagnostics: null },
    ]);
    await saveAnomalies(t.db, acc!.id, null, [{ date: '2026-10-06', metric: 'clicks', value: 1500, baseline: 500, z: 8, direction: 'up' }]);
    await insertChangeEvents(t.db, [{ orgId: DEFAULT_ORG_ID, accountId: acc!.id, externalId: 'customers/1/changeEvents/7', changedAt: new Date('2026-10-05T13:00:00Z'), userEmail: 'pat@example.com', resourceType: 'CAMPAIGN_BUDGET', resourceName: 'customers/1/campaigns/111', changedFields: ['amount_micros'] }]);
    const ctx: AgentContext = { db: t.db, allowedAccountIds: null, now };

    expect(await runGetTrackingHealth(ctx, { account: 'Arlo TW' })).toMatchObject({
      status: 'critical',
      actions: [{ name: 'Purchase', status: 'critical', hoursSinceLast: 52 }],
      ga4: { note: '帳戶未連結 GA4 property' },
    });
    expect((await runGetAnomalies(ctx, { account: 'Arlo TW', days: null })).anomalies).toEqual([expect.objectContaining({ metric: 'clicks', direction: 'up', z: 8 })]);
    expect((await runGetChangesAround(ctx, { account: 'Arlo TW', date: '2026-10-06', hours: null })).changes).toEqual([
      expect.objectContaining({ id: 'ce:7', who: 'pat@example.com', targets: ['111'] }),
    ]);
    await expect(runGetTrackingHealth({ ...ctx, allowedAccountIds: [] }, { account: 'Arlo TW' })).rejects.toThrow('找不到');
    await expect(runGetChangesAround(ctx, { account: 'Arlo TW', date: '10/06', hours: null })).rejects.toThrow('YYYY-MM-DD');
  });
});
