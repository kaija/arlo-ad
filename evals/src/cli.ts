// pnpm eval [--suite name]... [--sample N] [--seed s]
// Runs golden sets against real models (OPENAI_API_KEY, MODEL_FLAGSHIP, MODEL_SMALL). CI runs a
// small sample; nightly runs everything (ADR-0026). Exits 1 when a suite misses its pass rate.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { EnvSchema, parseEnv } from '@arlo/config';
import { setDefaultOpenAIKey } from '@openai/agents';
import { agentFactory } from './agents';
import { formatReport, runSuite, type SuiteResult } from './runner';
import { loadSuites } from './suite';

const { values } = parseArgs({
  options: {
    suite: { type: 'string', multiple: true },
    sample: { type: 'string' },
    seed: { type: 'string', default: 'ci' },
    concurrency: { type: 'string', default: '4' },
  },
});

const env = parseEnv(EnvSchema.pick({ OPENAI_API_KEY: true, MODEL_FLAGSHIP: true, MODEL_SMALL: true }));
setDefaultOpenAIKey(env.OPENAI_API_KEY);

const suites = (await loadSuites()).filter((s) => !values.suite?.length || values.suite.includes(s.suite));
const factory = agentFactory({ flagship: env.MODEL_FLAGSHIP, small: env.MODEL_SMALL });
const results: SuiteResult[] = [];
for (const suite of suites) {
  results.push(
    await runSuite(suite, factory, {
      sample: values.sample ? Number(values.sample) : undefined,
      seed: values.seed,
      concurrency: Number(values.concurrency),
    }),
  );
}

console.log(formatReport(results));
const dir = join(import.meta.dirname, '..', 'reports');
await mkdir(dir, { recursive: true });
const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(file, JSON.stringify({ models: { flagship: env.MODEL_FLAGSHIP, small: env.MODEL_SMALL }, results }, null, 2));
console.log(`report: ${file}`);
process.exitCode = results.every((r) => r.passed) ? 0 : 1;
