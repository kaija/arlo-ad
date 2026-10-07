// Budget reallocation plan (ADR-0018): serializable per-campaign inputs → marginal estimates →
// allocate(). The worker / tools store the inputs so a plan can be recomputed exactly, e.g. after
// the agent excludes campaigns; the agent never supplies numbers.
import { allocate, type Allocation } from './allocate';
import { estimateMarginal, type HistoryDay, type MarginalSource, type SimulationPoint } from './marginal';

export interface OptimizerCampaign {
  /** Platform campaign id. */
  id: string;
  name: string;
  budgetMicros: number;
  history: HistoryDay[];
  simulation: SimulationPoint[] | null;
  lostIsBudget: number | null;
  learning: boolean;
  /** Shared budgets move other campaigns too: never reallocated. */
  budgetShared: boolean;
}

export interface PlannedCampaign extends Allocation {
  name: string;
  source: MarginalSource;
  reason: string;
}

export interface PlanOptions {
  maxChangePct?: number;
  minConversions?: number;
  /** Campaign ids a person (or the agent) excluded from the reallocation. */
  exclude?: readonly string[];
}

export interface ReallocationPlan {
  campaigns: PlannedCampaign[];
  totalMicros: number;
  /** Estimated change in daily conversions (or value), from the marginal curves. */
  expectedGain: number;
  /** Nothing to move: fewer than two campaigns are free to change. */
  empty: boolean;
}

/** ∫ marginal over [from, to] by the trapezoid rule; a rough expected gain for the explanation. */
function integrate(f: (b: number) => number, from: number, to: number, steps = 20): number {
  if (from === to) return 0;
  const h = (to - from) / steps;
  let s = (f(from) + f(to)) / 2;
  for (let i = 1; i < steps; i++) s += f(from + i * h);
  return s * h;
}

export function planReallocation(campaigns: readonly OptimizerCampaign[], opts: PlanOptions = {}): ReallocationPlan {
  const excluded = new Set(opts.exclude ?? []);
  const estimates = campaigns.map((c) => {
    const e = estimateMarginal({ currentBudgetMicros: c.budgetMicros, simulation: c.simulation, history: c.history, lostIsBudget: c.lostIsBudget, learning: c.learning, minConversions: opts.minConversions });
    const reason = excluded.has(c.id) ? '已排除' : c.budgetShared ? '共用預算' : e.reason;
    return { c, e, locked: e.locked || excluded.has(c.id) || c.budgetShared, reason };
  });
  const free = estimates.filter((x) => !x.locked).length;
  const allocations = free >= 2 ? allocate(estimates.map((x) => ({ id: x.c.id, budget: x.c.budgetMicros, marginal: x.e.marginal, locked: x.locked })), { maxChangePct: opts.maxChangePct }) : null;
  const planned = estimates.map((x, i): PlannedCampaign => {
    const a = allocations?.[i] ?? { id: x.c.id, before: x.c.budgetMicros, after: x.c.budgetMicros, delta: 0, locked: true, marginalBefore: x.e.marginal(x.c.budgetMicros), marginalAfter: x.e.marginal(x.c.budgetMicros) };
    return { ...a, name: x.c.name, source: x.e.source, reason: x.reason };
  });
  const expectedGain = estimates.reduce((s, x, i) => s + integrate(x.e.marginal, planned[i]!.before, planned[i]!.after), 0);
  return { campaigns: planned, totalMicros: campaigns.reduce((s, c) => s + c.budgetMicros, 0), expectedGain, empty: allocations === null || planned.every((p) => p.delta === 0) };
}
