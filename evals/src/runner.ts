// Runs eval suites against agents. The agent factory decides models (real ones from the CLI,
// scripted ones in tests).
import { run, type Agent } from '@openai/agents';
import { passRate, scoreCase, type CaseScore, type Observation } from './scoring';
import { sampleCases, type EvalCase, type EvalSuite } from './suite';

export interface EvalTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- suites mix agents with different contexts and outputs
  agent: Agent<any, any>;
  context?: unknown;
}

export type AgentFactory = (suite: EvalSuite, c: EvalCase) => EvalTarget | Promise<EvalTarget>;

export interface CaseResult extends CaseScore {
  id: string;
  observation: Observation;
  durationMs: number;
}

export interface SuiteResult {
  suite: string;
  agent: string;
  passRate: number;
  minPassRate: number;
  passed: boolean;
  cases: CaseResult[];
}

/** Top-level tool calls in a run (agent-as-tool calls appear as their tool name). */
function calledTools(items: readonly unknown[]): string[] {
  return items.flatMap((item) => {
    const raw = (item as { rawItem?: { type?: string; name?: string } }).rawItem;
    return raw?.type === 'function_call' && raw.name ? [raw.name] : [];
  });
}

export async function observe(target: EvalTarget, input: EvalCase['input']): Promise<Observation> {
  try {
    const result = await run(target.agent, typeof input === 'string' ? input : JSON.stringify(input), {
      context: target.context,
      maxTurns: 10,
    });
    const final = result.finalOutput;
    return {
      tools: calledTools(result.newItems),
      answer: typeof final === 'string' ? final : JSON.stringify(final ?? ''),
      output: typeof final === 'string' ? undefined : final,
    };
  } catch (err) {
    return { tools: [], answer: '', error: (err as Error).message };
  }
}

export async function runSuite(suite: EvalSuite, factory: AgentFactory, opts: { sample?: number; seed?: string; concurrency?: number } = {}): Promise<SuiteResult> {
  const cases = sampleCases(suite.cases, opts.sample, opts.seed);
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < cases.length; i = next++) {
      const c = cases[i]!;
      const started = performance.now();
      const observation = await observe(await factory(suite, c), c.input);
      results[i] = { id: c.id, observation, durationMs: Math.round(performance.now() - started), ...scoreCase(c.expect, observation) };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  const rate = passRate(results);
  const minPassRate = suite.minPassRate ?? 0.9;
  return { suite: suite.suite, agent: suite.agent, passRate: rate, minPassRate, passed: rate >= minPassRate, cases: results };
}

export function formatReport(results: readonly SuiteResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.passed ? 'PASS' : 'FAIL'} ${r.suite} (${r.agent}) ${(r.passRate * 100).toFixed(0)}% ≥ ${(r.minPassRate * 100).toFixed(0)}% required, ${r.cases.length} cases`);
    for (const c of r.cases.filter((x) => !x.pass)) lines.push(`  ✗ ${c.id}: ${c.failures.join('; ')}`);
  }
  return lines.join('\n');
}
