// Runs eval suites against agents. The agent factory decides models (real ones from the CLI,
// scripted ones in tests).
import { run, type Agent } from '@openai/agents';
import { passRate, precisionAtConfidence, scoreCase, type CaseScore, type Observation } from './scoring';
import { sampleCases, type EvalCase, type EvalSuite } from './suite';

export interface EvalTarget {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- suites mix agents with different contexts and outputs
  agent: Agent<any, any>;
  context?: unknown;
  /** Turns the case input into the model input (default: the string, or its JSON). */
  formatInput?: (input: EvalCase['input']) => string;
  /** Maps the structured output before scoring, e.g. the single label of a batch. */
  project?: (output: unknown) => unknown;
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
  /** For suites with precisionAt: precision of confident positives and how many there were. */
  precision?: { threshold: number; min: number; value: number | null; support: number };
  cases: CaseResult[];
}

/** Predictions of a classifier suite: positive = judged irrelevant (would be excluded). */
export function predictions(suite: EvalSuite, cases: readonly EvalCase[], results: readonly CaseResult[]) {
  return results.flatMap((r, i) => {
    const out = r.observation.output as { relevant?: unknown; confidence?: unknown } | undefined;
    const expected = cases[i]!.expect.output?.relevant;
    if (typeof out?.relevant !== 'boolean' || typeof out.confidence !== 'number' || typeof expected !== 'boolean') return [];
    return [{ predicted: out.relevant === false, actual: expected === false, confidence: out.confidence }];
  });
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
    const formatted = target.formatInput ? target.formatInput(input) : typeof input === 'string' ? input : JSON.stringify(input);
    const result = await run(target.agent, formatted, {
      context: target.context,
      maxTurns: 10,
    });
    const final = target.project ? target.project(result.finalOutput) : result.finalOutput;
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
  let passed = rate >= minPassRate;
  let precision: SuiteResult['precision'];
  if (suite.precisionAt) {
    const p = precisionAtConfidence(predictions(suite, cases, results), suite.precisionAt.threshold);
    precision = { ...suite.precisionAt, value: p.precision, support: p.support };
    // No confident positives means nothing would be excluded automatically: safe, not a failure.
    if (p.precision !== null && p.precision < suite.precisionAt.min) passed = false;
  }
  return { suite: suite.suite, agent: suite.agent, passRate: rate, minPassRate, passed, ...(precision ? { precision } : {}), cases: results };
}

export function formatReport(results: readonly SuiteResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.passed ? 'PASS' : 'FAIL'} ${r.suite} (${r.agent}) ${(r.passRate * 100).toFixed(0)}% ≥ ${(r.minPassRate * 100).toFixed(0)}% required, ${r.cases.length} cases`);
    if (r.precision) {
      const v = r.precision.value === null ? 'n/a' : `${(r.precision.value * 100).toFixed(1)}%`;
      lines.push(`  precision@${r.precision.threshold}: ${v} (≥ ${(r.precision.min * 100).toFixed(0)}% required, ${r.precision.support} confident exclusions)`);
    }
    for (const c of r.cases.filter((x) => !x.pass)) lines.push(`  ✗ ${c.id}: ${c.failures.join('; ')}`);
  }
  return lines.join('\n');
}
