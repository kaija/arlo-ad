import { FakePlatformAdapter } from '@arlo/adapters/platform';
import { createCauseRanker } from '@arlo/agents';
import { say, ScriptedModel } from '@arlo/agents/testing';
import { createLogger } from '@arlo/config/logger';
import { addDays, type ChatMessage } from '@arlo/core';
import {
  createScheduledJob,
  DEFAULT_ORG_ID,
  insertChangeEvents,
  listAnomalies,
  loadEntityIds,
  resolveAccounts,
  setGa4Property,
  startJobRun,
  upsertConversionActions,
  upsertGa4Daily,
  upsertMetricsDaily,
  type AdAccount,
} from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { setTracingDisabled } from '@openai/agents';
import { beforeAll, describe, expect, it } from 'vitest';
import { syncAccounts, syncSnapshots } from '../../sync/sync';
import type { TemplateContext } from '../types';
import { anomalyWatch, proximityRanking } from './anomaly-watch';
import { trackingAudit } from './tracking-audit';

setTracingDisabled(true);
const logger = createLogger({ component: 'test', level: 'silent' });
const ACC = '1234567890';
const NOW = new Date('2026-10-07T04:00:00Z'); // yesterday = 2026-10-06 in Taipei
const M = 1_000_000;

describe('audit templates', () => {
  const t = useTestDatabase();
  let account: AdAccount;
  let ids: Map<string, string>;

  const ctx = async (template: 'tracking_audit' | 'anomaly_watch', agents: Partial<TemplateContext['agents']> = {}): Promise<TemplateContext> => {
    const job = await createScheduledJob(t.db, { name: template, template, cron: '0 8 * * *', tz: 'Asia/Taipei', accountIds: null, target: { platform: 'slack', channelId: 'C1' }, extraInstructions: null, enabled: true });
    const run = await startJobRun(t.db, { scheduledJobId: job.id, template, trigger: 'manual' });
    // Re-read so the GA4 property linked in a test is visible.
    const [acc] = await resolveAccounts(t.db, { allowed: null });
    return { db: t.db, logger, now: () => NOW, job, run, accounts: [acc!], agents: { analyst: () => { throw new Error('unused'); }, orchestrator: () => { throw new Error('unused'); }, ...agents } };
  };

  beforeAll(async () => {
    const fake = new FakePlatformAdapter()
      .addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' })
      .addEntities(ACC, [
        { kind: 'account', externalId: ACC, name: 'Arlo TW', status: 'ENABLED', attrs: {} },
        { kind: 'campaign', externalId: '111', name: 'Brand', status: 'ENABLED', attrs: {}, state: { budgetMicros: 1000 * M, bidStrategy: null, bidTarget: null } },
      ])
      .setClock(() => NOW);
    const sync = { db: t.db, platform: fake, logger, now: () => NOW };
    account = (await syncAccounts(sync))[0]!;
    await syncSnapshots(sync, account);
    ids = await loadEntityIds(t.db, account.id, ['account', 'campaign']);

    // 28 quiet days, then clicks triple on 10-06 after a budget change the evening before.
    const rows = [];
    for (let i = 0; i <= 28; i++) {
      const date = addDays('2026-09-08', i);
      const spike = date === '2026-10-06';
      for (const [kind, ext] of [['account', ACC], ['campaign', '111']] as const) {
        rows.push({ orgId: DEFAULT_ORG_ID, accountId: account.id, entityId: ids.get(`${kind}:${ext}`)!, level: kind, date, impressions: 10_000 + (i % 5) * 100, clicks: spike ? 1500 : 500 + (i % 7) * 5, costMicros: (spike ? 15_000 : 5000 + (i % 3) * 50) * M, conversions: spike ? 75 : 25 + (i % 4), convValue: 0 });
      }
    }
    await upsertMetricsDaily(t.db, rows);
    await insertChangeEvents(t.db, [
      { orgId: DEFAULT_ORG_ID, accountId: account.id, externalId: 'customers/1/changeEvents/budget', changedAt: new Date('2026-10-05T13:00:00Z'), userEmail: 'pat@example.com', resourceType: 'CAMPAIGN_BUDGET', resourceName: `customers/${ACC}/campaigns/111`, changedFields: ['amount_micros'], old: { amount_micros: 1000 }, new: { amount_micros: 3000 } },
      { orgId: DEFAULT_ORG_ID, accountId: account.id, externalId: 'customers/1/changeEvents/other', changedAt: new Date('2026-10-04T02:00:00Z'), userEmail: 'kai@example.com', resourceType: 'AD', resourceName: `customers/${ACC}/ads/9`, changedFields: ['status'] },
    ]);
    await upsertConversionActions(t.db, [
      { orgId: DEFAULT_ORG_ID, accountId: account.id, externalId: '501', name: 'Purchase', status: 'ENABLED', category: 'PURCHASE', primary: true, lastConversionAt: new Date('2026-10-05T10:00:00Z'), conversions30d: 90, ecDiagnostics: null },
      { orgId: DEFAULT_ORG_ID, accountId: account.id, externalId: '502', name: 'Signup', status: 'ENABLED', category: 'SIGNUP', primary: false, lastConversionAt: null, conversions30d: 0, ecDiagnostics: null },
    ]);
  });

  it('tracking_audit flags a silent primary action and the GA4 gap', async () => {
    await setGa4Property(t.db, account.id, '123456', { kind: 'system' });
    await upsertGa4Daily(
      t.db,
      Array.from({ length: 17 }, (_, i) => ({ orgId: DEFAULT_ORG_ID, propertyId: '123456', date: addDays('2026-09-20', i), sourceMedium: 'google / cpc', sessions: 450, conversions: i >= 14 ? 2 : 20 })),
    );
    const { messages } = await trackingAudit.run(await ctx('tracking_audit'));
    expect(messages[0]).toMatchObject({ type: 'notice', level: 'error' });
    const report = messages[1] as Extract<ChatMessage, { type: 'report' }>;
    const text = JSON.stringify(report.sections);
    expect(text).toContain('Purchase：已 42 小時沒有轉換');
    expect(text).toContain('GA4：GA4/Ads 轉換比');
    expect(trackingAudit.critical).toBe(true);
  });

  it('anomaly_watch detects, stores and ranks causes with the model', async () => {
    const model = new ScriptedModel(() => [say(JSON.stringify({ causes: [{ id: 'ce:budget', likelihood: 0.9, reason: '預算提高 3 倍' }, { id: 'ce:nope', likelihood: 0.5, reason: 'x' }], summary: '點擊上升與前一晚預算提高一致。' }))]);
    const { messages } = await anomalyWatch.run(await ctx('anomaly_watch', { causeRanker: () => createCauseRanker({ model }) }));
    const anomalies = await listAnomalies(t.db, { accountIds: [account.id] });
    expect(anomalies.map((a) => [a.entityId === null ? 'account' : 'campaign', a.metric])).toEqual(expect.arrayContaining([['account', 'clicks'], ['campaign', 'clicks']]));
    expect(anomalies.every((a) => a.explanation?.startsWith('點擊上升與前一晚預算提高一致。'))).toBe(true);
    const text = JSON.stringify((messages[0] as Extract<ChatMessage, { type: 'report' }>).sections);
    expect(text).toContain('pat@example.com');
    expect(text).not.toContain('ce:nope');
  });

  it('ranks by proximity without a model, entity matches first', () => {
    const c = (id: string, at: string, targets: string[]) => ({ id, at: new Date(at), kind: 'change_event' as const, who: null, summary: id, targets });
    const ranked = proximityRanking('2026-10-06', '111', [c('far-same', '2026-10-04T12:00:00Z', ['111']), c('near-other', '2026-10-06T10:00:00Z', ['9']), c('after', '2026-10-08T12:00:00Z', ['111'])]);
    expect(ranked.map((r) => r.id)).toEqual(['far-same', 'near-other']);
  });
});
