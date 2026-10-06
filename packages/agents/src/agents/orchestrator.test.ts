import { DEFAULT_ORG_ID, upsertAdAccounts, upsertEntities, upsertMetricsDaily } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { run, setTracingDisabled } from '@openai/agents';
import { beforeAll, describe, expect, it } from 'vitest';
import routing from '../../../../evals/cases/orchestrator-routing.json';
import type { AgentContext } from '../context';
import { callTool, say, ScriptedModel, toolResultText } from '../testing';
import { createAnalystAgent } from './analyst';
import { createOrchestrator, ORCHESTRATOR_INSTRUCTIONS } from './orchestrator';
import { UNTRUSTED_CONTENT_POLICY } from './prompts';

setTracingDisabled(true);

describe('orchestrator', () => {
  const t = useTestDatabase();
  const context = (): AgentContext => ({ db: t.db, allowedAccountIds: null, now: () => new Date('2026-10-06T04:00:00Z') });

  beforeAll(async () => {
    const [account] = await upsertAdAccounts(t.db, [
      { orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' },
    ]);
    const [entity] = await upsertEntities(t.db, [{ orgId: DEFAULT_ORG_ID, accountId: account!.id, kind: 'account', externalId: '1234567890' }]);
    await upsertMetricsDaily(t.db, [
      { orgId: DEFAULT_ORG_ID, accountId: account!.id, entityId: entity!.id, level: 'account', date: '2026-10-05', costMicros: 12_345_000_000, clicks: 10 },
    ]);
  });

  it('exposes specialists as tools and carries the routing and safety instructions', () => {
    const orchestrator = createOrchestrator({ model: 'test', specialists: { analyst: createAnalystAgent({ model: 'test' }) } });
    expect(orchestrator.tools.map((tool) => tool.name)).toEqual(['analyst', 'get_changeset_status']);
    expect(ORCHESTRATOR_INSTRUCTIONS).toContain(UNTRUSTED_CONTENT_POLICY);
  });

  it('routes a data question through the analyst to query_metrics and back', async () => {
    const analystModel = new ScriptedModel((_req, { toolNames, lastItem }) => {
      expect(toolNames).toEqual(['query_metrics', 'list_campaigns', 'get_pacing', 'get_change_history']);
      const result = toolResultText(lastItem);
      if (!result) {
        return [callTool('query_metrics', { account: 'Arlo TW', level: 'account', from: '2026-10-05', to: '2026-10-05', groupBy: 'total', campaigns: null, limit: null })];
      }
      return [say(`昨天花費 ${JSON.parse(result).accounts[0].rows[0].cost} TWD`)];
    });
    const orchestratorModel = new ScriptedModel((_req, { lastItem }) => {
      const result = toolResultText(lastItem);
      return result ? [say(`分析師回報：${result}`)] : [callTool('analyst', { input: '昨天 Arlo TW 花了多少？（2026-10-05）' })];
    });
    const orchestrator = createOrchestrator({ model: orchestratorModel, specialists: { analyst: createAnalystAgent({ model: analystModel }) } });

    const result = await run(orchestrator, '昨天花多少？', { context: context() });
    expect(result.finalOutput).toBe('分析師回報：昨天花費 12345 TWD');
    expect(analystModel.requests).toHaveLength(2);
  });

  it('ships a routing eval suite that targets the analyst', () => {
    expect(routing.cases.length).toBeGreaterThanOrEqual(10);
    expect(routing.cases.filter((c) => c.expect.tools?.includes('analyst')).length).toBeGreaterThanOrEqual(8);
  });
});
