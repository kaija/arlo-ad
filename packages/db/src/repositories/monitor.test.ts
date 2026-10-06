import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../testing';
import { DEFAULT_ORG_ID } from '../schema';
import { listAudit } from './changesets';
import { deleteMonitorRule, firingCounts, lastFiring, listMonitorRules, recordFiring, saveMonitorRule } from './monitor';
import { upsertAdAccounts, upsertEntities } from './platform';

describe('monitor repository', () => {
  const t = useTestDatabase();
  const actor = { kind: 'system' as const };

  it('saves validated rules, records firings and finds the last one per entity', async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    const [c1, c2] = await upsertEntities(t.db, [
      { orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'campaign', externalId: '1' },
      { orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'campaign', externalId: '2' },
    ]);
    const rule = await saveMonitorRule(t.db, { accountId: acc!.id, campaignEntityId: null, spec: { type: 'SpendPacing', pct: 1.5, minSpendMicros: 0 }, action: { kind: 'pause' }, cooldownMinutes: 360, enabled: true }, actor);
    await expect(saveMonitorRule(t.db, { accountId: acc!.id, campaignEntityId: null, spec: { type: 'SpendPacing', pct: 0.5 } as never, action: { kind: 'pause' }, cooldownMinutes: 360, enabled: true }, actor)).rejects.toThrow();
    await saveMonitorRule(t.db, { ...rule, enabled: false, cooldownMinutes: 60 }, actor);
    expect(await listMonitorRules(t.db, { enabledOnly: true })).toEqual([]);
    expect(await listMonitorRules(t.db, { accountId: acc!.id })).toMatchObject([{ id: rule.id, enabled: false, cooldownMinutes: 60 }]);

    await recordFiring(t.db, { ruleId: rule.id, entityId: c1!.id, firedAt: new Date('2026-10-07T01:00:00Z'), changesetId: null, evidence: { pacing: 2 } });
    await recordFiring(t.db, { ruleId: rule.id, entityId: c1!.id, firedAt: new Date('2026-10-07T03:00:00Z'), changesetId: null, evidence: {} });
    expect(await lastFiring(t.db, rule.id, c1!.id)).toEqual(new Date('2026-10-07T03:00:00Z'));
    expect(await lastFiring(t.db, rule.id, c2!.id)).toBeNull();
    expect((await firingCounts(t.db, new Date('2026-10-07T02:00:00Z'))).get(rule.id)).toBe(1);

    expect(await deleteMonitorRule(t.db, rule.id, actor)).toBe(true);
    expect((await listAudit(t.db, 'monitor_rule', rule.id)).map((a) => a.action)).toEqual(['create', 'update', 'delete']);
  });
});
