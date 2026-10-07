import { describe, expect, it } from 'vitest';
import { estimateMarginal, isLearning, marginalFromHistory, marginalFromSimulation } from './marginal';

const M = 1_000_000;

describe('marginalFromSimulation', () => {
  it('interpolates segment slopes and forces them non-increasing', () => {
    const f = marginalFromSimulation([
      { budgetMicros: 1000 * M, value: 10 },
      { budgetMicros: 2000 * M, value: 18 },
      { budgetMicros: 3000 * M, value: 30 }, // a rising segment, capped to the previous slope
      { budgetMicros: 4000 * M, value: 32 },
    ])!;
    expect(f(500 * M) * M * 1000).toBeCloseTo(8);
    expect(f(1500 * M) * M * 1000).toBeCloseTo(8);
    expect(f(2500 * M) * M * 1000).toBeCloseTo(8);
    expect(f(3500 * M) * M * 1000).toBeCloseTo(2);
    expect(f(9000 * M) * M * 1000).toBeCloseTo(2);
  });

  it('needs two distinct budgets', () => {
    expect(marginalFromSimulation([{ budgetMicros: 1000 * M, value: 10 }, { budgetMicros: 1000 * M, value: 12 }])).toBeNull();
  });
});

describe('marginalFromHistory', () => {
  it('recovers the exponent of a power curve', () => {
    const days = [500, 700, 900, 1100, 1300, 1500, 1700].map((c) => ({ costMicros: c * M, value: 0.5 * Math.sqrt(c) }));
    const fit = marginalFromHistory(days)!;
    expect(fit.k).toBeCloseTo(0.5, 5);
    expect(fit.marginal(400 * M)).toBeGreaterThan(fit.marginal(1600 * M));
  });

  it('assumes mild diminishing returns when spend never varies, and needs 7 days', () => {
    expect(marginalFromHistory(Array.from({ length: 7 }, () => ({ costMicros: 1000 * M, value: 5 })))!.k).toBe(0.7);
    expect(marginalFromHistory(Array.from({ length: 6 }, () => ({ costMicros: 1000 * M, value: 5 })))).toBeNull();
  });
});

describe('estimateMarginal', () => {
  const history = Array.from({ length: 14 }, (_, i) => ({ costMicros: (800 + i * 30) * M, value: 3 + (i % 3) }));
  const sim = [
    { budgetMicros: 1000 * M, value: 4 },
    { budgetMicros: 2000 * M, value: 6 },
  ];

  it.each([
    ['learning locks', { learning: true }, 'none', true],
    ['too few conversions locks', { history: history.slice(0, 3) }, 'none', true],
    ['simulation first', { simulation: sim }, 'simulation', false],
    ['history next', {}, 'history', false],
    ['average last', { history: [...Array.from({ length: 13 }, () => ({ costMicros: 100 * M, value: 0 })), { costMicros: 100 * M, value: 40 }] }, 'average', false],
  ] as const)('%s', (_, over, source, locked) => {
    const e = estimateMarginal({ currentBudgetMicros: 1000 * M, history, learning: false, ...over });
    expect([e.source, e.locked]).toEqual([source, locked]);
  });

  it('damps returns above the current budget when nothing is lost to budget', () => {
    const open = estimateMarginal({ currentBudgetMicros: 1000 * M, simulation: sim, history, learning: false, lostIsBudget: 0.3 });
    const saturated = estimateMarginal({ currentBudgetMicros: 1000 * M, simulation: sim, history, learning: false, lostIsBudget: 0 });
    expect(saturated.marginal(1500 * M)).toBeCloseTo(open.marginal(1500 * M) * 0.3);
    expect(saturated.marginal(900 * M)).toBe(open.marginal(900 * M));
  });
});

describe('isLearning', () => {
  const now = new Date('2026-10-07T00:00:00Z');
  const snap = (daysAgo: number, target: number | null, strategy = 'TARGET_CPA') => ({ capturedAt: new Date(now.getTime() - daysAgo * 86_400_000), bidStrategy: strategy, bidTarget: target });
  it.each([
    ['target changed 3 days ago', [snap(10, 200), snap(3, 250)], true],
    ['target changed 10 days ago', [snap(12, 200), snap(10, 250), snap(1, 250)], false],
    ['strategy changed yesterday', [snap(5, 200), snap(1, 200, 'MAXIMIZE_CONVERSIONS')], true],
    ['no change', [snap(5, 200), snap(1, 200)], false],
  ])('%s', (_, snapshots, expected) => {
    expect(isLearning(snapshots, now)).toBe(expected);
  });
});
