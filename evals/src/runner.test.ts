import { createAnalystAgent, createOrchestrator } from '@arlo/agents';
import { callTool, say, ScriptedModel, toolResultText } from '@arlo/agents/testing';
import { setTracingDisabled } from '@openai/agents';
import { describe, expect, it } from 'vitest';
import { formatReport, runSuite } from './runner';
import { loadSuites } from './suite';

setTracingDisabled(true);

describe('runSuite', () => {
  it('runs the routing suite end to end with a scripted orchestrator', async () => {
    const suite = (await loadSuites()).find((s) => s.suite === 'orchestrator_routing')!;
    // A crude "model": data-looking questions go to the analyst; everything else is answered directly.
    const orchestratorModel = new ScriptedModel((req, { lastItem }) => {
      if (toolResultText(lastItem)) return [say('完成')];
      const input = typeof req.input === 'string' ? req.input : JSON.stringify(req.input);
      if (/花|CPA|預算會|轉換|ROAS|曝光|關鍵字|campaign|spend|誰動過/i.test(input) && !/忽略之前/.test(input)) return [callTool('analyst', { input })];
      return [say('我可以協助查數據；任何變更都需要經過審核。')];
    });
    const analyst = createAnalystAgent({ model: new ScriptedModel(() => [say('stub')]) });
    const result = await runSuite(suite, () => ({ agent: createOrchestrator({ model: orchestratorModel, specialists: { analyst } }), context: {} }), {
      concurrency: 2,
    });
    expect(result.cases.filter((c) => !c.pass).map((c) => [c.id, c.failures])).toEqual([]);
    expect(result).toMatchObject({ passed: true, passRate: 1 });
    expect(formatReport([result])).toContain('PASS orchestrator_routing');
  });

  it('reports failures per case', async () => {
    const suite = (await loadSuites()).find((s) => s.suite === 'orchestrator_routing')!;
    const silent = new ScriptedModel(() => [say('不知道')]);
    const result = await runSuite(suite, () => ({ agent: createOrchestrator({ model: silent, specialists: { analyst: createAnalystAgent({ model: silent }) } }) }), {
      sample: 4,
    });
    expect(result.passed).toBe(false);
    expect(formatReport([result])).toMatch(/✗ .+: missing tool analyst/);
  });
});
