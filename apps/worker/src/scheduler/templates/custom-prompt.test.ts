import { FakePlatformAdapter } from '@arlo/adapters/platform';
import { createAnalystAgent, createBiddingAgent, createOrchestrator } from '@arlo/agents';
import { callTool, say, ScriptedModel, toolResultText } from '@arlo/agents/testing';
import { createLogger } from '@arlo/config/logger';
import { createScheduledJob, getChangeSet, insertChangeSet, startJobRun, type AdAccount, type JobRun, type ScheduledJob } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { setTracingDisabled, type Agent } from '@openai/agents';
import { beforeAll, describe, expect, it } from 'vitest';
import { syncAccounts, syncSnapshots } from '../../sync/sync';
import type { TemplateContext } from '../types';
import { customPrompt, CustomReportSchema } from './custom-prompt';

setTracingDisabled(true);
const logger = createLogger({ component: 'test', level: 'silent' });
const NOW = new Date('2026-10-07T04:00:00Z');
const ACC = '1234567890';

const READ_AND_PROPOSE = new Set([
  'analyst',
  'bidding',
  'get_changeset_status',
  'query_metrics',
  'list_campaigns',
  'get_pacing',
  'get_change_history',
  'propose_budget',
  'propose_status',
  'propose_bid_target',
  'run_budget_optimizer',
  'propose_budget_reallocation',
]);

describe('custom_prompt template', () => {
  const t = useTestDatabase();
  const platform = new FakePlatformAdapter()
    .addAccount({ externalId: ACC, name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' })
    .addEntities(ACC, [{ kind: 'campaign', externalId: '111', name: 'Brand', status: 'ENABLED', attrs: { budgetShared: false }, state: { budgetMicros: 1_000_000_000, bidStrategy: null, bidTarget: null } }])
    .setClock(() => NOW);
  let account: AdAccount;
  let job: ScheduledJob;
  let run: JobRun;

  beforeAll(async () => {
    const sync = { db: t.db, platform, logger, now: () => NOW };
    account = (await syncAccounts(sync))[0]!;
    await syncSnapshots(sync, account);
    job = await createScheduledJob(t.db, {
      name: '週一檢查',
      template: 'custom_prompt',
      cron: '0 9 * * 1',
      tz: 'Asia/Taipei',
      accountIds: null,
      target: { platform: 'slack', channelId: 'CREPORTS' },
      extraInstructions: '檢查預算受限的 campaign，必要時提出加預算',
      enabled: true,
    });
    run = await startJobRun(t.db, { scheduledJobId: job.id, template: 'custom_prompt', trigger: 'manual' });
  });

  const report = { title: '週一檢查', summary: '• Brand 預算受限', sections: [{ heading: null, text: '建議加預算 10%' }] };

  function ctx(orchestratorScript: ConstructorParameters<typeof ScriptedModel>[0], proposals: string[] = []): TemplateContext {
    const orchestratorModel = new ScriptedModel(orchestratorScript);
    const biddingModel = new ScriptedModel((_req, { lastItem }) =>
      toolResultText(lastItem) ? [say('已提出')] : [callTool('propose_budget', { account: 'Arlo TW', campaign: 'Brand', dailyBudget: 1100, reason: '預算受限' })],
    );
    return {
      db: t.db,
      logger,
      now: () => NOW,
      job,
      run,
      accounts: [account],
      traceId: 'trace_job',
      agents: {
        analyst: () => createAnalystAgent({ model: orchestratorModel }),
        orchestrator: () => createOrchestrator({ model: orchestratorModel, specialists: { analyst: createAnalystAgent({ model: orchestratorModel }), bidding: createBiddingAgent({ model: biddingModel }) } }),
      },
      propose: async (input) => {
        const cs = await insertChangeSet(t.db, input);
        proposals.push(cs.id);
        return { id: cs.id };
      },
    };
  }

  it('returns a schema-checked report and the ChangeSets proposed through the tools', async () => {
    const proposals: string[] = [];
    const result = await customPrompt.run(
      ctx((_req, { lastItem }) => (toolResultText(lastItem) ? [say(JSON.stringify(report))] : [callTool('bidding', { input: '檢查 Brand 並視需要加預算' })]), proposals),
    );

    expect(result.changesetIds).toEqual(proposals);
    expect(result.changesetIds).toHaveLength(1);
    expect(result.messages).toEqual([
      {
        type: 'report',
        title: '週一檢查',
        sections: [
          { kind: 'text', text: '• Brand 預算受限' },
          { kind: 'text', text: '建議加預算 10%' },
          { kind: 'text', heading: '已送審的變更', text: `• ChangeSet \`${proposals[0]}\`` },
        ],
      },
    ]);
    expect(await getChangeSet(t.db, proposals[0]!)).toMatchObject({
      status: 'PENDING_VALIDATION',
      source: { kind: 'schedule', jobRunId: run.id },
      requestedBy: { kind: 'agent' },
      traceId: 'trace_job',
      ops: [{ kind: 'set_budget', before: 1_000_000_000, after: 1_100_000_000 }],
    });
    expect(platform.applied).toEqual([]);
  });

  it('rejects output that does not match the report schema', async () => {
    await expect(customPrompt.run(ctx(() => [say(JSON.stringify({ title: 'x', sections: [] }))]))).rejects.toThrow();
    expect(CustomReportSchema.safeParse({ title: 'x', summary: 'y', sections: [] }).success).toBe(true);
  });

  it('refuses to run without instructions', async () => {
    const result = await customPrompt.run({ ...ctx(() => [say('{}')]), job: { ...job, extraInstructions: '  ' } });
    expect(result).toEqual({ messages: [{ type: 'notice', level: 'warn', text: expect.stringContaining('沒有設定指示') }], changesetIds: [] });
  });

  it('only exposes read and propose tools, at every level', () => {
    const model = new ScriptedModel(() => [say('')]);
    const specialists = { analyst: createAnalystAgent({ model }), bidding: createBiddingAgent({ model }) };
    const agents: Agent<never>[] = [createOrchestrator({ model, specialists }), ...Object.values(specialists)] as unknown as Agent<never>[];
    const names = agents.flatMap((a) => a.tools.map((tool) => tool.name));
    for (const name of names) expect(READ_AND_PROPOSE.has(name), name).toBe(true);
    expect(names.filter((n) => /apply|mutate|execute|approve|^set_/i.test(n))).toEqual([]);
  });
});
