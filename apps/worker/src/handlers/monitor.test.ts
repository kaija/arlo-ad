import { FakeChatAdapter } from '@arlo/adapters/chat';
import { FakePlatformAdapter } from '@arlo/adapters/platform';
import { createLogger } from '@arlo/config/logger';
import { DEFAULT_ORG_ID, getChangeSet, insertChangeSet, loadEntityIds, saveMonitorRule, setAutomationMode, upsertMetricsDaily, upsertMetricsHourly, type AdAccount } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { syncAccounts, syncSnapshots } from '../sync/sync';
import { createExecutor } from './executor';
import { hourSlots, runMonitor, type MonitorDeps } from './monitor';

const logger = createLogger({ component: 'test', level: 'silent' });
const ACC = '1234567890';
const NOW = new Date('2026-10-07T04:00:00Z'); // 12:00 in Taipei: half the day elapsed
const M = 1_000_000;

function platform() {
  return new FakePlatformAdapter()
    .addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' })
    .addEntities(ACC, [
      { kind: 'campaign', externalId: '111', name: 'Brand', status: 'ENABLED', attrs: {}, state: { budgetMicros: 1000 * M, bidStrategy: 'TARGET_CPA', bidTarget: 200 * M } },
      { kind: 'campaign', externalId: '112', name: 'Generic', status: 'ENABLED', attrs: {}, state: { budgetMicros: 2000 * M, bidStrategy: 'TARGET_ROAS', bidTarget: 4 } },
    ])
    .setClock(() => NOW);
}

describe('hourSlots', () => {
  it('walks back local hours across midnight', () => {
    expect(hourSlots(new Date('2026-10-06T17:30:00Z'), 'Asia/Taipei', 3)).toEqual([
      { date: '2026-10-07', hour: 1 },
      { date: '2026-10-07', hour: 0 },
      { date: '2026-10-06', hour: 23 },
    ]);
  });
});

describe('Monitor job', () => {
  const t = useTestDatabase();
  let fake: FakePlatformAdapter;
  let account: AdAccount;
  let ids: Map<string, string>;

  beforeEach(async () => {
    fake = platform();
    if (account) return;
    const sync = { db: t.db, platform: fake, logger, now: () => NOW };
    account = (await syncAccounts(sync))[0]!;
    await syncSnapshots(sync, account);
    ids = await loadEntityIds(t.db, account.id, ['campaign']);
    const metric = (ext: string, cost: number) => ({ orgId: DEFAULT_ORG_ID, accountId: account.id, entityId: ids.get(`campaign:${ext}`)!, level: 'campaign' as const, date: '2026-10-07', costMicros: cost * M, impressions: 100, clicks: 10, conversions: 5, convValue: 0 });
    // Brand: 1500 spent by noon on a 1000 budget (pacing 3.0). Generic: 800 (0.8).
    await upsertMetricsDaily(t.db, [metric('111', 1500), metric('112', 800)]);
    // Generic's last 6 hours: ROAS 1.5 against a 4.0 target, 5 conversions.
    await upsertMetricsHourly(t.db, [8, 9, 10, 11].map((hour) => ({ ...metric('112', 250), hour, conversions: 1.25, convValue: 375 })));
    await saveMonitorRule(t.db, { accountId: account.id, campaignEntityId: null, spec: { type: 'SpendPacing', pct: 1.5, minSpendMicros: 0 }, action: { kind: 'pause' }, cooldownMinutes: 360, enabled: true }, { kind: 'system' });
    await saveMonitorRule(t.db, { accountId: account.id, campaignEntityId: null, spec: { type: 'RoasDrop', hours: 6, ratio: 0.5, minConv: 3 }, action: { kind: 'reduce_target', pct: 0.2 }, cooldownMinutes: 360, enabled: true }, { kind: 'system' });
  });

  const run = async (now: Date) => {
    const proposed: string[] = [];
    const deps: MonitorDeps = {
      db: t.db,
      logger,
      now: () => now,
      enqueue: async () => 'id',
      propose: async (input) => {
        const cs = await insertChangeSet(t.db, input);
        proposed.push(cs.id);
        return { id: cs.id };
      },
    };
    const firings = await runMonitor(deps, account);
    const executor = createExecutor({ db: t.db, platform: fake, chat: new FakeChatAdapter(), logger, now: () => now, writeAllowedCustomerIds: [ACC], approvalChannel: { platform: 'slack', channelId: 'CAPPROVAL' } });
    for (const id of proposed) await executor.process(id);
    return { firings, changesets: await Promise.all(proposed.map((id) => getChangeSet(t.db, id))) };
  };

  it('fires Tier 1 ChangeSets that run in shadow by default, then respects the cooldown', async () => {
    const { firings, changesets } = await run(NOW);
    expect(firings.map((f) => f.evidence)).toEqual([expect.objectContaining({ pacing: 3 }), expect.objectContaining({ roas: 1.5, targetRoas: 4 })]);
    expect(changesets).toMatchObject([
      { feature: 'circuit_breaker', status: 'SIMULATED', tier: 1, source: { kind: 'monitor' }, ops: [{ kind: 'set_status', after: 'PAUSED', target: { id: '111' } }], summary: expect.stringContaining('今日花費達進度的 300%') },
      { feature: 'bid_auto_reduce', status: 'SIMULATED', tier: 1, ops: [{ kind: 'set_bid_target', field: 'target_roas', before: 4, after: 4.8 }] },
    ]);
    expect(fake.applied).toEqual([]);

    expect((await run(new Date(NOW.getTime() + 30 * 60_000))).firings).toEqual([]);
  });

  it('executes live once the cooldown has passed', async () => {
    await setAutomationMode(t.db, account.id, 'circuit_breaker', 'live', { kind: 'system' });
    await setAutomationMode(t.db, account.id, 'bid_auto_reduce', 'off', { kind: 'system' });
    // 18:30 Taipei: Brand still at 1500 of an expected ~771 (pacing 1.9); Generic's window has moved on.
    const later = new Date(NOW.getTime() + 6.5 * 3_600_000);
    const { firings, changesets } = await run(later);
    expect(firings).toHaveLength(1);
    expect(changesets).toMatchObject([{ status: 'EXECUTED', feature: 'circuit_breaker' }]);
    expect(fake.entity({ platform: 'google_ads', accountId: ACC, kind: 'campaign', id: '111' })?.status).toBe('PAUSED');
  });

  it('proposes nothing while the automation is off', async () => {
    const rule = await saveMonitorRule(t.db, { accountId: account.id, campaignEntityId: ids.get('campaign:112')!, spec: { type: 'SpendPacing', pct: 1.2, minSpendMicros: 0 }, action: { kind: 'reduce_budget', pct: 0.3 }, cooldownMinutes: 60, enabled: true }, { kind: 'system' });
    await setAutomationMode(t.db, account.id, 'circuit_breaker', 'off', { kind: 'system' });
    // 05:00 Taipei: Generic's 800 is well past 1.2× of the expected ~417.
    const early = new Date('2026-10-06T21:00:00Z');
    expect((await run(early)).firings).toEqual([]);
    await setAutomationMode(t.db, account.id, 'circuit_breaker', 'shadow', { kind: 'system' });
    const { firings, changesets } = await run(early);
    // The pause rule also fires for Generic (its first time); Brand is still in that rule's cooldown.
    expect(firings.map((f) => f.ruleId)).toContain(rule.id);
    expect(firings.filter((f) => f.entityId === ids.get('campaign:111'))).toEqual([]);
    expect(changesets.find((c) => c?.ops[0]?.kind === 'set_budget')).toMatchObject({ status: 'SIMULATED', ops: [{ before: 2000 * M, after: 1400 * M }] });
  });
});
