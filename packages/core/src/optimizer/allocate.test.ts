import { describe, expect, it } from 'vitest';
import { allocate, AllocationError, type CampaignInput } from './allocate';

const M = 1_000_000;
/** Diminishing returns: marginal = a / (1 + budget / scale). */
const curve = (a: number, scale = 1000 * M) => (b: number) => a / (1 + b / scale);
const c = (id: string, budget: number, marginal: (b: number) => number, locked = false): CampaignInput => ({ id, budget: budget * M, marginal, locked });

describe('allocate', () => {
  it('moves budget toward the better marginal return, within ±30%', () => {
    const out = allocate([c('good', 1000, curve(3)), c('poor', 1000, curve(1))]);
    expect(out.map((a) => [a.id, a.after / M])).toEqual([
      ['good', 1300],
      ['poor', 700],
    ]);
    expect(out.reduce((s, a) => s + a.delta, 0)).toBe(0);
  });

  it('stops at equal marginals instead of maxing out', () => {
    const out = allocate([c('a', 1000, curve(1.2)), c('b', 1000, curve(1))], { step: M });
    const [a, b] = out;
    expect(a!.after).toBeGreaterThan(1000 * M);
    expect(a!.after).toBeLessThan(1300 * M);
    expect(Math.abs(a!.marginalAfter - b!.marginalAfter)).toBeLessThan(0.01);
  });

  it('keeps locked campaigns as they are', () => {
    const out = allocate([c('learning', 500, curve(10), true), c('a', 1000, curve(2)), c('b', 1000, curve(1))]);
    expect(out[0]).toMatchObject({ after: 500 * M, delta: 0, locked: true });
    expect(out[1]!.after + out[2]!.after).toBe(2000 * M);
  });

  it('rejects impossible totals and bad input', () => {
    expect(() => allocate([c('a', 1000, curve(1))], { total: 2000 * M })).toThrow(AllocationError);
    expect(() => allocate([c('a', 1000, curve(1)), c('a', 1, curve(1))])).toThrow('duplicate');
    expect(() => allocate([c('a', 1000, curve(1))], { maxChangePct: 1 })).toThrow('maxChangePct');
  });

  // Property test with a seeded PRNG (core has no test-time dependencies beyond vitest).
  it('always conserves the total and respects the per-campaign limit', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 300; round++) {
      const n = 1 + Math.floor(rand() * 8);
      const maxChangePct = 0.05 + rand() * 0.6;
      const inputs = Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        budget: Math.round((1 + rand() * 5000) * 100) * 10_000,
        marginal: curve(rand() * 5, (100 + rand() * 5000) * M),
        locked: rand() < 0.2,
      }));
      const out = allocate(inputs, { maxChangePct, step: rand() < 0.5 ? undefined : Math.round(rand() * 50 * M) + 1 });
      expect(out.reduce((s, a) => s + a.after, 0)).toBe(inputs.reduce((s, i) => s + i.budget, 0));
      for (const a of out) {
        if (a.locked) expect(a.delta).toBe(0);
        expect(Math.abs(a.delta)).toBeLessThanOrEqual(a.before * maxChangePct + 1);
        expect(a.after).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
