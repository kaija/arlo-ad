import { createBiddingAgent } from '@arlo/agents';
import { callTool, say, ScriptedModel, toolResultText } from '@arlo/agents/testing';
import { createLogger } from '@arlo/config/logger';
import { addDays, type ChatMessage } from '@arlo/core';
import { createScheduledJob, DEFAULT_ORG_ID, getChangeSet, insertChangeSet, insertEntitySnapshots, resolveAccounts, setAutomationMode, startJobRun, upsertAdAccounts, upsertEntities, upsertMetricsDaily } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { setTracingDisabled } from '@openai/agents';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TemplateContext } from '../types';
import { budgetRebalance } from './budget-rebalance';

setTracingDisabled(true);
const logger = createLogger({ component: 'test', level: 'silent' });
const M = 1_000_000;
const NOW = new Date('2026-10-07T04:00:00Z');

describe('budget_rebalance template', () => {
  const t = useTestDatabase();

  beforeAll(async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    const campaigns = await upsertEntities(t.db, ['111', '112'].map((id) => ({ orgId: DEFAULT_ORG_ID, accountId: acc!.id, kind: 'campaign' as const, externalId: id, name: `C${id}`, status: 'ENABLED', attrs: {} })));
    await insertEntitySnapshots(t.db, campaigns.map((c) => ({ orgId: DEFAULT_ORG_ID, entityId: c.id, capturedAt: new Date('2026-10-07T03:45:00Z'), budgetMicros: 1000 * M, status: 'ENABLED', bidStrategy: null, bidTarget: null })));
    const rows = [];
    for (let i = 1; i <= 14; i++) {
      for (const [c, rate] of [[campaigns[0]!, 20], [campaigns[1]!, 4]] as const) {
        const cost = 1000 * (0.8 + (i % 5) * 0.1);
        rows.push({ orgId: DEFAULT_ORG_ID, accountId: acc!.id, entityId: c.id, level: 'campaign' as const, date: addDays('2026-10-07', -i), costMicros: Math.round(cost * M), impressions: 1000, clicks: 100, conversions: rate * Math.sqrt(cost / 1000), convValue: 0, lostIsBudget: 0.2 });
      }
    }
    await upsertMetricsDaily(t.db, rows);
  });

  async function ctx(): Promise<{ ctx: TemplateContext; ids: string[] }> {
    const job = await createScheduledJob(t.db, { name: 'rebalance', template: 'budget_rebalance', cron: '0 9 * * 1', tz: 'Asia/Taipei', accountIds: null, target: { platform: 'slack', channelId: 'C1' }, extraInstructions: null, enabled: true });
    const run = await startJobRun(t.db, { scheduledJobId: job.id, template: 'budget_rebalance', trigger: 'manual' });
    // Scripted agent: run the optimizer, propose its result, summarize.
    const model = new ScriptedModel((_req, { lastItem }) => {
      const result = toolResultText(lastItem);
      if (!result) return [callTool('run_budget_optimizer', { account: '1234567890', optimizeFor: null })];
      const parsed = JSON.parse(result) as { resultId?: string; changesetId?: string };
      if (parsed.resultId && !parsed.changesetId) return [callTool('propose_budget_reallocation', { resultId: parsed.resultId, excludeCampaigns: [], explanation: 'C111 邊際轉換較高' })];
      return [say('• 已送審：C111 +30%、C112 −30%')];
    });
    const ids: string[] = [];
    return {
      ids,
      ctx: {
        db: t.db,
        logger,
        now: () => NOW,
        job,
        run,
        accounts: await resolveAccounts(t.db, { allowed: null }),
        agents: { analyst: () => { throw new Error('unused'); }, orchestrator: () => { throw new Error('unused'); }, bidding: () => createBiddingAgent({ model }) },
        propose: async (input) => {
          const cs = await insertChangeSet(t.db, input);
          ids.push(cs.id);
          return { id: cs.id };
        },
      },
    };
  }

  it('proposes the optimizer result through the bidding agent', async () => {
    const { ctx: c, ids } = await ctx();
    const result = await budgetRebalance.run(c);
    expect(result.changesetIds).toEqual(ids);
    expect(ids).toHaveLength(1);
    expect(await getChangeSet(t.db, ids[0]!)).toMatchObject({ feature: 'budget_rebalance', source: { kind: 'schedule', jobRunId: c.run.id }, rationale: 'C111 邊際轉換較高' });
    expect(JSON.stringify((result.messages[0] as Extract<ChatMessage, { type: 'report' }>).sections)).toContain('已送審');
  });

  it('skips accounts where the automation is off', async () => {
    const [acc] = await resolveAccounts(t.db, { allowed: null });
    await setAutomationMode(t.db, acc!.id, 'budget_rebalance', 'off', { kind: 'system' });
    const { ctx: c, ids } = await ctx();
    const result = await budgetRebalance.run(c);
    expect(ids).toEqual([]);
    expect(JSON.stringify(result.messages)).toContain('關閉');
  });
});
