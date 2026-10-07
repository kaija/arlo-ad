import { createAnalystAgent, createOrchestrator } from '@arlo/agents';
import { callTool, say, ScriptedModel, toolResultText } from '@arlo/agents/testing';
import { setTracingDisabled } from '@openai/agents';
import { describe, expect, it } from 'vitest';
import { agentFactory } from './agents';
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

describe('classifier suite precision gate', () => {
  const termOf = (req: { input: unknown }) => {
    const items = req.input as { content?: unknown }[] | string;
    const text = typeof items === 'string' ? items : (items.at(-1)!.content as { text?: string }[] | string);
    const raw = typeof text === 'string' ? text : text[0]!.text!;
    return (JSON.parse(raw) as { terms: { term: string }[] }).terms[0]!.term;
  };

  async function run(misjudge: string | null) {
    const suite = (await loadSuites()).find((s) => s.suite === 'search_term_classifier')!;
    const irrelevant = new Set(suite.cases.filter((c) => c.expect.output?.relevant === false).map((c) => (c.input as { term: string }).term));
    const model = new ScriptedModel((req) => {
      const term = termOf(req);
      const relevant = term === misjudge ? false : !irrelevant.has(term);
      return [say(JSON.stringify({ labels: [{ index: 0, intent: relevant ? 'purchase' : 'unrelated', relevant, confidence: 0.95, reason: 'scripted' }] }))];
    });
    return runSuite(suite, agentFactory({ flagship: model, small: model }), { concurrency: 4 });
  }

  it('passes when confident exclusions are all correct', async () => {
    const result = await run(null);
    expect(result).toMatchObject({ passed: true, passRate: 1, precision: { value: 1, threshold: 0.9, min: 0.98 } });
    expect(formatReport([result])).toContain('precision@0.9: 100.0%');
  });

  it('fails on a single confident wrong exclusion even with a high pass rate', async () => {
    const result = await run('arlo 登入');
    expect(result.passRate).toBeGreaterThan(0.95);
    expect(result.passed).toBe(false);
    expect(result.precision!.value).toBeLessThan(0.98);
  });
});

describe('cause ranking suite', () => {
  it('scores the top cause from a scripted ranker', async () => {
    const suite = (await loadSuites()).find((s) => s.suite === 'audit_cause_ranking')!;
    const expected = new Map(suite.cases.map((c) => [JSON.stringify(c.input), (c.expect.output as { topCause: string | null }).topCause]));
    const model = new ScriptedModel((req) => {
      const items = req.input as { content: { text: string }[] | string }[];
      const last = items.at(-1)!.content;
      const top = expected.get(typeof last === 'string' ? last : last[0]!.text) ?? null;
      return [say(JSON.stringify({ causes: top ? [{ id: top, likelihood: 0.8, reason: 'scripted' }] : [], summary: 's' }))];
    });
    const result = await runSuite(suite, agentFactory({ flagship: model, small: model }), { concurrency: 4 });
    expect(result.cases.filter((c) => !c.pass).map((c) => c.id)).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
