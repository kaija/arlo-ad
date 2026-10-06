import { DEFAULT_ORG_ID, schema, setSetting } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { run, setTracingDisabled } from '@openai/agents';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAnalystAgent } from '../agents/analyst';
import { createOrchestrator } from '../agents/orchestrator';
import { AGENT_MODEL_TIER, modelNameFor } from '../config/models';
import type { AgentContext } from '../context';
import { callTool, say, ScriptedModel, toolResultText } from '../testing';
import { runGuard } from './budget';
import { summarizeUsage } from './ledger';
import { MeteredModel } from './metered-model';
import { trackedRun } from './tracked-run';

setTracingDisabled(true);

describe('model config', () => {
  it('maps agents to tiers and tiers to env model names', () => {
    const env = { MODEL_FLAGSHIP: 'gpt-5', MODEL_SMALL: 'gpt-5-mini' };
    expect(modelNameFor('orchestrator', env)).toBe('gpt-5');
    expect(modelNameFor('search_term_classifier', env)).toBe('gpt-5-mini');
    expect(Object.values(AGENT_MODEL_TIER).filter((t) => t === 'small')).toHaveLength(1);
  });

  it('sums usage per agent and model', () => {
    const e = { requests: 1, inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 };
    expect(summarizeUsage([{ agent: 'a', model: 'm', ...e }, { agent: 'a', model: 'm', ...e }, { agent: 'b', model: 'm', ...e }])).toEqual([
      { agent: 'a', model: 'm', requests: 2, inputTokens: 20, cachedInputTokens: 4, outputTokens: 10 },
      { agent: 'b', model: 'm', ...e },
    ]);
  });
});

describe('trackedRun and runGuard', () => {
  const t = useTestDatabase();
  const context = (): AgentContext => ({ db: t.db, allowedAccountIds: [], now: () => new Date() });

  it('records usage of the orchestrator and nested specialists with estimated cost', async () => {
    const analystModel = new MeteredModel(new ScriptedModel(() => [say('沒有資料')], { inputTokens: 1000, outputTokens: 100 }), 'analyst', 'gpt-5');
    const orchestratorModel = new MeteredModel(
      new ScriptedModel((_r, { lastItem }) => (toolResultText(lastItem) ? [say('完成')] : [callTool('analyst', { input: 'q' })]), {
        inputTokens: 2000,
        outputTokens: 200,
      }),
      'orchestrator',
      'gpt-5-mini',
    );
    const orchestrator = createOrchestrator({ model: orchestratorModel, specialists: { analyst: createAnalystAgent({ model: analystModel }) } });

    const tracked = await trackedRun({ db: t.db, name: 'test', ref: { kind: 'session', id: 'slack:C1:1.0' } }, () => run(orchestrator, 'hi', { context: context() }));
    expect(tracked.result.finalOutput).toBe('完成');
    const rows = await t.db.select().from(schema.llmUsage).where(eq(schema.llmUsage.refId, 'slack:C1:1.0'));
    expect(rows.map((r) => [r.agent, r.model, r.requests, r.inputTokens, r.outputTokens, r.costUsd]).sort()).toEqual([
      // 1000 × 1.25 + 100 × 10 per 1M on gpt-5
      ['analyst', 'gpt-5', 1, 1000, 100, 0.00225],
      // two calls × (2000 × 0.25 + 200 × 2) per 1M on gpt-5-mini
      ['orchestrator', 'gpt-5-mini', 2, 4000, 400, 0.0018],
    ]);
    expect(tracked.costUsd).toBeCloseTo(0.00405, 6);
    expect(rows.every((r) => r.orgId === DEFAULT_ORG_ID && r.refKind === 'session')).toBe(true);
  });

  it('uses model price overrides from settings', async () => {
    await setSetting(t.db, 'model_prices', { 'house-model': { input: 1000, output: 0 } });
    const model = new MeteredModel(new ScriptedModel(() => [say('ok')], { inputTokens: 1000, outputTokens: 0 }), 'analyst', 'house-model');
    const tracked = await trackedRun({ db: t.db, name: 'test', ref: { kind: 'job_run', id: 'run-1' } }, () =>
      run(createAnalystAgent({ model }), 'hi', { context: context() }),
    );
    expect(tracked.costUsd).toBe(1);
  });

  it('stops non-critical work at the budget and notifies once per day', async () => {
    const notices: number[] = [];
    const guard = (critical: boolean, now = new Date()) =>
      runGuard({ db: t.db, defaultBudgetUsd: 1, critical, now: () => now, notify: async (d) => void notices.push(d.spentUsd) });
    // Spent so far today: 0.00405 + 0.00225... + 1 from the previous tests → over a $1 budget.
    expect(await guard(true)).toEqual({ run: true });
    expect(await guard(false)).toMatchObject({ run: false, reason: 'llm_budget_exceeded', budgetUsd: 1 });
    expect(await guard(false)).toMatchObject({ run: false });
    expect(notices).toHaveLength(1);

    await setSetting(t.db, 'daily_llm_budget_usd', 100);
    expect(await guard(false)).toEqual({ run: true });
    // Tomorrow starts from zero.
    await setSetting(t.db, 'daily_llm_budget_usd', 0.5);
    expect(await guard(false, new Date(Date.now() + 2 * 86_400_000))).toEqual({ run: true });
  });
});
