// Golden set format (evals/cases/*.json). Each suite targets one agent; each case has an input
// and expectations that scoring.ts turns into pass / fail.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const ExpectSchema = z.object({
  /** Tools that must be called (any order). */
  tools: z.array(z.string()).optional(),
  /** Tools that must not be called. */
  notTools: z.array(z.string()).optional(),
  /** Substrings the final answer must contain (case-insensitive). */
  answerIncludes: z.array(z.string()).optional(),
  answerExcludes: z.array(z.string()).optional(),
  /** Structured output fields that must match exactly (classification suites). */
  output: z.record(z.string(), z.unknown()).optional(),
});

export const CaseSchema = z.object({
  id: z.string().min(1),
  input: z.union([z.string(), z.record(z.string(), z.unknown())]),
  expect: ExpectSchema,
  tags: z.array(z.string()).optional(),
});

export const SuiteSchema = z.object({
  suite: z.string().min(1),
  description: z.string(),
  agent: z.string().min(1),
  /** Pass rate below which the suite fails (default 0.9). */
  minPassRate: z.number().min(0).max(1).optional(),
  cases: z.array(CaseSchema).min(1),
});

export type EvalExpect = z.infer<typeof ExpectSchema>;
export type EvalCase = z.infer<typeof CaseSchema>;
export type EvalSuite = z.infer<typeof SuiteSchema>;

export const CASES_DIR = join(import.meta.dirname, '..', 'cases');

export async function loadSuites(dir = CASES_DIR): Promise<EvalSuite[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const suites: EvalSuite[] = [];
  for (const file of files) {
    const parsed = SuiteSchema.safeParse(JSON.parse(await readFile(join(dir, file), 'utf8')));
    if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const ids = new Set<string>();
    for (const c of parsed.data.cases) {
      if (ids.has(c.id)) throw new Error(`${file}: duplicate case id ${c.id}`);
      ids.add(c.id);
    }
    suites.push(parsed.data);
  }
  return suites;
}

/** Stable 32-bit FNV-1a hash, for deterministic sampling. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** CI small-sample mode: the same `n` cases for a given seed, in suite order. */
export function sampleCases(cases: EvalCase[], n: number | undefined, seed = 'ci'): EvalCase[] {
  if (n === undefined || n >= cases.length) return cases;
  const chosen = new Set(
    [...cases]
      .sort((a, b) => hash(`${seed}:${a.id}`) - hash(`${seed}:${b.id}`))
      .slice(0, n)
      .map((c) => c.id),
  );
  return cases.filter((c) => chosen.has(c.id));
}
