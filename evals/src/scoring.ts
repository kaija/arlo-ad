// Scoring for agent evals (ADR-0026). Pure functions over what a run produced.
import type { EvalExpect } from './suite';

export interface Observation {
  /** Tool names called by the evaluated agent (top level), in order. */
  tools: string[];
  answer: string;
  /** Structured final output, for structured-output agents. */
  output?: unknown;
  error?: string;
}

export interface CaseScore {
  pass: boolean;
  failures: string[];
}

export function scoreCase(expect: EvalExpect, obs: Observation): CaseScore {
  if (obs.error) return { pass: false, failures: [`error: ${obs.error}`] };
  const failures: string[] = [];
  const answer = obs.answer.toLowerCase();
  for (const tool of expect.tools ?? []) if (!obs.tools.includes(tool)) failures.push(`missing tool ${tool}`);
  if (expect.tools && expect.tools.length === 0 && obs.tools.length > 0) failures.push(`expected no tools, got ${obs.tools.join(', ')}`);
  for (const tool of expect.notTools ?? []) if (obs.tools.includes(tool)) failures.push(`unexpected tool ${tool}`);
  for (const s of expect.answerIncludes ?? []) if (!answer.includes(s.toLowerCase())) failures.push(`answer lacks "${s}"`);
  for (const s of expect.answerExcludes ?? []) if (answer.includes(s.toLowerCase())) failures.push(`answer contains "${s}"`);
  if (expect.output) {
    const out = (obs.output ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(expect.output)) {
      if (JSON.stringify(out[key]) !== JSON.stringify(value)) failures.push(`output.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(out[key])}`);
    }
  }
  return { pass: failures.length === 0, failures };
}

export function passRate(scores: readonly CaseScore[]): number {
  return scores.length ? scores.filter((s) => s.pass).length / scores.length : 1;
}

export interface Prediction {
  /** Predicted positive (e.g. "irrelevant, exclude"). */
  predicted: boolean;
  actual: boolean;
  confidence: number;
}

/**
 * Precision among predictions with confidence ≥ threshold — e.g. search terms the sweep would
 * exclude automatically (Requirement 14.4 needs ≥ 0.98 at 0.9).
 */
export function precisionAtConfidence(predictions: readonly Prediction[], threshold: number): { precision: number | null; support: number } {
  const auto = predictions.filter((p) => p.predicted && p.confidence >= threshold);
  if (auto.length === 0) return { precision: null, support: 0 };
  return { precision: auto.filter((p) => p.actual).length / auto.length, support: auto.length };
}
