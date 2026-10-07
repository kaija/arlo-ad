// Budget reallocation (ADR-0018, Requirements 13.1, 13.2): greedy marginal allocation. Each
// unlocked campaign starts at its lower bound; the rest of the total goes out in steps to whichever
// campaign returns the most per extra unit right now, within its upper bound. Integer micros, so
// the total is conserved exactly. Pure and deterministic: the agent never produces these numbers.

export interface CampaignInput {
  id: string;
  /** Current daily budget, micros. */
  budget: number;
  /** Conversions (or value) per extra micro at a given daily budget; non-increasing in practice. */
  marginal: (budgetMicros: number) => number;
  /** Learning, too little data, shared budget, or excluded by a person: keeps its budget. */
  locked: boolean;
}

export interface AllocateOptions {
  /** Total daily budget to distribute; defaults to the current sum (conservation). */
  total?: number;
  /** Largest change per campaign as a ratio of its budget (default 0.3). */
  maxChangePct?: number;
  /** Increment handed out per round, micros (default ~1/200 of the movable amount, whole cents). */
  step?: number;
  /** No campaign goes below this, micros (default 1 currency unit). */
  minBudget?: number;
}

export interface Allocation {
  id: string;
  before: number;
  after: number;
  delta: number;
  locked: boolean;
  /** Marginal return at the old and new budget, for the explanation. */
  marginalBefore: number;
  marginalAfter: number;
}

const CENT = 10_000;
const floorCent = (n: number) => Math.floor(n / CENT) * CENT;
const ceilCent = (n: number) => Math.ceil(n / CENT) * CENT;

export class AllocationError extends Error {}

export function allocate(inputs: readonly CampaignInput[], opts: AllocateOptions = {}): Allocation[] {
  const maxPct = opts.maxChangePct ?? 0.3;
  const minBudget = opts.minBudget ?? 1_000_000;
  if (!(maxPct > 0 && maxPct < 1)) throw new AllocationError('maxChangePct must be in (0, 1)');
  const ids = new Set<string>();
  for (const c of inputs) {
    if (ids.has(c.id)) throw new AllocationError(`duplicate campaign ${c.id}`);
    ids.add(c.id);
    if (!Number.isSafeInteger(c.budget) || c.budget < 0) throw new AllocationError(`invalid budget for ${c.id}`);
  }

  const total = opts.total ?? inputs.reduce((s, c) => s + c.budget, 0);
  const lockedSum = inputs.filter((c) => c.locked).reduce((s, c) => s + c.budget, 0);
  const free = inputs.filter((c) => !c.locked);
  // Bounds in whole cents, never past the ±maxPct limit.
  const lo = new Map(free.map((c) => [c.id, Math.min(c.budget, Math.max(Math.min(minBudget, c.budget), ceilCent(c.budget * (1 - maxPct))))]));
  const hi = new Map(free.map((c) => [c.id, Math.max(c.budget, floorCent(c.budget * (1 + maxPct)))]));
  const sumLo = free.reduce((s, c) => s + lo.get(c.id)!, 0);
  const sumHi = free.reduce((s, c) => s + hi.get(c.id)!, 0);
  const movable = total - lockedSum;
  if (movable < sumLo || movable > sumHi) throw new AllocationError('total is outside what the change limits allow');

  const current = new Map(lo);
  let remaining = movable - sumLo;
  const step = Math.max(1, opts.step ?? Math.max(CENT, floorCent(remaining / 200)));
  while (remaining > 0) {
    const give = Math.min(step, remaining);
    let best: CampaignInput | undefined;
    let bestValue = -Infinity;
    for (const c of free) {
      const room = hi.get(c.id)! - current.get(c.id)!;
      if (room <= 0) continue;
      const value = c.marginal(current.get(c.id)!);
      // Ties go to the campaign further below its old budget, then by id, for stable output.
      if (value > bestValue || (value === bestValue && best && current.get(c.id)! - c.budget < current.get(best.id)! - best.budget)) {
        best = c;
        bestValue = value;
      }
    }
    if (!best) break;
    const amount = Math.min(give, hi.get(best.id)! - current.get(best.id)!);
    current.set(best.id, current.get(best.id)! + amount);
    remaining -= amount;
  }

  return inputs.map((c) => {
    const after = c.locked ? c.budget : current.get(c.id)!;
    return { id: c.id, before: c.budget, after, delta: after - c.budget, locked: c.locked, marginalBefore: c.marginal(c.budget), marginalAfter: c.marginal(after) };
  });
}
