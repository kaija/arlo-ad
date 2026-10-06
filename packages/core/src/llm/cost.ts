// LLM cost estimation and the daily budget guard (ADR-0023, Requirements 19.2, 19.3).

/** USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  cachedInput?: number;
  output: number;
}

/**
 * Default price table, matched by longest model-name prefix. Kept current by hand (ADR-0023);
 * the `model_prices` setting overrides or extends it without a deploy.
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'gpt-4.1': { input: 2, cachedInput: 0.5, output: 8 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cachedInput: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
};

/** Unknown models are priced high so the budget guard errs on the side of stopping. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { input: 5, output: 20 };

export function priceFor(model: string, table: Record<string, ModelPrice> = DEFAULT_MODEL_PRICES): { price: ModelPrice; known: boolean } {
  const name = model.toLowerCase();
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if ((name === key || name.startsWith(`${key}-`) || name.startsWith(`${key}.`)) && (!best || key.length > best.length)) best = key;
  }
  return best ? { price: table[best]!, known: true } : { price: UNKNOWN_MODEL_PRICE, known: false };
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
}

export function estimateCostUsd(model: string, usage: TokenUsage, table?: Record<string, ModelPrice>): number {
  const { price } = priceFor(model, table);
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const cost = ((usage.inputTokens - cached) * price.input + cached * (price.cachedInput ?? price.input) + usage.outputTokens * price.output) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

export type BudgetDecision = { run: true } | { run: false; reason: 'llm_budget_exceeded'; spentUsd: number; budgetUsd: number };

/** Non-critical work stops once today's spend reaches the budget; critical work always runs. */
export function llmBudgetDecision(input: { spentUsd: number; budgetUsd: number; critical: boolean }): BudgetDecision {
  if (input.critical || input.spentUsd < input.budgetUsd) return { run: true };
  return { run: false, reason: 'llm_budget_exceeded', spentUsd: input.spentUsd, budgetUsd: input.budgetUsd };
}
