import { describe, expect, it } from 'vitest';
import { planReallocation, type OptimizerCampaign } from './plan';

const M = 1_000_000;
const camp = (id: string, budget: number, convPerDay: number, over: Partial<OptimizerCampaign> = {}): OptimizerCampaign => ({
  id,
  name: id,
  budgetMicros: budget * M,
  // Spend varies ±20% around the budget; conversions follow a square-root curve.
  history: Array.from({ length: 14 }, (_, i) => {
    const cost = budget * (0.8 + (i % 5) * 0.1);
    return { costMicros: cost * M, value: convPerDay * Math.sqrt(cost / budget) };
  }),
  simulation: null,
  lostIsBudget: 0.2,
  learning: false,
  budgetShared: false,
  ...over,
});

describe('planReallocation', () => {
  it('moves budget from the weaker campaign to the stronger one, conserving the total', () => {
    const plan = planReallocation([camp('strong', 1000, 20), camp('weak', 1000, 4)]);
    expect(plan.empty).toBe(false);
    const [strong, weak] = plan.campaigns;
    expect(strong!.delta).toBeGreaterThan(0);
    expect(weak!.delta).toBeLessThan(0);
    expect(strong!.delta + weak!.delta).toBe(0);
    expect(plan.expectedGain).toBeGreaterThan(0);
    expect(strong!.source).toBe('history');
  });

  it('locks excluded, shared-budget, learning and thin campaigns', () => {
    const plan = planReallocation(
      [camp('a', 1000, 20), camp('b', 1000, 4), camp('ex', 1000, 30), camp('shared', 1000, 30, { budgetShared: true }), camp('new', 1000, 30, { learning: true }), camp('thin', 1000, 1)],
      { exclude: ['ex'] },
    );
    const by = new Map(plan.campaigns.map((c) => [c.id, c]));
    for (const id of ['ex', 'shared', 'new', 'thin']) expect(by.get(id)).toMatchObject({ delta: 0, locked: true });
    expect(by.get('ex')!.reason).toBe('已排除');
    expect(by.get('shared')!.reason).toBe('共用預算');
    expect(by.get('a')!.delta).toBeGreaterThan(0);
  });

  it('is empty with fewer than two free campaigns', () => {
    expect(planReallocation([camp('a', 1000, 20), camp('b', 1000, 4)], { exclude: ['b'] }).empty).toBe(true);
  });
});
