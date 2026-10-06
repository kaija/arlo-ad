import { describe, expect, it } from 'vitest';
import { estimateCostUsd, llmBudgetDecision, priceFor, UNKNOWN_MODEL_PRICE } from './cost';

describe('LLM cost', () => {
  it.each([
    ['gpt-5', 'gpt-5'],
    ['gpt-5-2026-08-01', 'gpt-5'],
    ['gpt-5-mini', 'gpt-5-mini'],
    ['gpt-5-mini-2026-08-01', 'gpt-5-mini'],
    ['GPT-4.1-mini', 'gpt-4.1-mini'],
    ['gpt-4o-mini', 'gpt-4o-mini'],
  ])('prices %s as %s by longest prefix', (model, expected) => {
    expect(priceFor(model)).toEqual({ price: priceFor(expected).price, known: true });
  });

  it('prices unknown models conservatively', () => {
    expect(priceFor('my-finetune')).toEqual({ price: UNKNOWN_MODEL_PRICE, known: false });
    expect(priceFor('gpt-50')).toMatchObject({ known: false });
  });

  it('computes cost with cached input discounted', () => {
    // 1M input (200k cached) + 100k output on gpt-5: 0.8×1.25 + 0.2×0.125 + 0.1×10
    expect(estimateCostUsd('gpt-5', { inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000 })).toBeCloseTo(2.025, 6);
    expect(estimateCostUsd('gpt-5-mini', { inputTokens: 1000, outputTokens: 500 })).toBeCloseTo(0.00125, 6);
    expect(estimateCostUsd('custom', { inputTokens: 1000, outputTokens: 0 }, { custom: { input: 3, output: 6 } })).toBeCloseTo(0.003, 6);
  });

  it.each([
    [{ spentUsd: 10, budgetUsd: 30, critical: false }, { run: true }],
    [{ spentUsd: 30, budgetUsd: 30, critical: false }, { run: false, reason: 'llm_budget_exceeded', spentUsd: 30, budgetUsd: 30 }],
    [{ spentUsd: 45, budgetUsd: 30, critical: true }, { run: true }],
  ])('budget decision %j', (input, expected) => {
    expect(llmBudgetDecision(input)).toEqual(expected);
  });
});
