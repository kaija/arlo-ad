// Marginal return estimates for the optimizer (ADR-0018, Requirements 13.1, 13.2): Google's
// budget simulation when available, else a 14-day cost→conversions curve, else the average rate.
// Campaigns in learning or with too little data are locked. Pure.

export interface SimulationPoint {
  budgetMicros: number;
  /** Conversions (or conversion value) the simulator expects per day at that budget. */
  value: number;
}

export interface HistoryDay {
  costMicros: number;
  value: number;
}

export type MarginalSource = 'simulation' | 'history' | 'average' | 'none';

export interface MarginalEstimate {
  source: MarginalSource;
  /** Value per extra micro at a daily budget. */
  marginal: (budgetMicros: number) => number;
  locked: boolean;
  reason: string;
}

const ZERO = () => 0;

/**
 * Piecewise-linear derivative of the simulated curve, made non-increasing (a budget curve with
 * rising returns would make greedy allocation pour everything into one campaign).
 */
export function marginalFromSimulation(points: readonly SimulationPoint[]): ((b: number) => number) | null {
  const pts = [...new Map(points.filter((p) => p.budgetMicros > 0 && Number.isFinite(p.value)).map((p) => [p.budgetMicros, p])).values()].sort((a, b) => a.budgetMicros - b.budgetMicros);
  if (pts.length < 2) return null;
  const slopes: { from: number; to: number; slope: number }[] = [];
  let cap = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const raw = (pts[i]!.value - pts[i - 1]!.value) / (pts[i]!.budgetMicros - pts[i - 1]!.budgetMicros);
    cap = Math.min(cap, Math.max(0, raw));
    slopes.push({ from: pts[i - 1]!.budgetMicros, to: pts[i]!.budgetMicros, slope: cap });
  }
  return (b) => (slopes.find((s) => b < s.to) ?? slopes.at(-1)!).slope;
}

/**
 * Fits value = a · cost^k on days with spend and conversions (log-log least squares), k clamped
 * to [0.3, 1] for diminishing returns; the marginal is a·k·cost^(k−1).
 */
export function marginalFromHistory(days: readonly HistoryDay[], minDays = 7): { marginal: (b: number) => number; k: number } | null {
  const pts = days.filter((d) => d.costMicros > 0 && d.value > 0).map((d) => [Math.log(d.costMicros), Math.log(d.value)] as const);
  if (pts.length < minDays) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  // Spend that barely varies says nothing about the slope: assume mild diminishing returns.
  const rawK = sxx > 1e-6 ? pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx : 0.7;
  const k = Math.min(1, Math.max(0.3, rawK));
  const a = Math.exp(my - k * mx);
  return { marginal: (b) => (b > 0 ? a * k * b ** (k - 1) : a * k), k };
}

export interface EstimateInput {
  currentBudgetMicros: number;
  simulation?: readonly SimulationPoint[] | null;
  /** Last 14 days. */
  history: readonly HistoryDay[];
  /** Search impression share lost to budget (0–1), when reported. */
  lostIsBudget?: number | null;
  learning: boolean;
  /** Conversions over the history the campaign needs to be optimized (default 30). */
  minConversions?: number;
}

export function estimateMarginal(input: EstimateInput): MarginalEstimate {
  const conversions = input.history.reduce((s, d) => s + d.value, 0);
  const cost = input.history.reduce((s, d) => s + d.costMicros, 0);
  if (input.learning) return { source: 'none', marginal: ZERO, locked: true, reason: '出價策略學習中' };
  if (conversions < (input.minConversions ?? 30)) return { source: 'none', marginal: ZERO, locked: true, reason: `近 14 天轉換 ${Math.round(conversions)} 次，資料不足` };

  // Not losing impressions to budget: more budget buys little beyond the current level.
  const saturated = input.lostIsBudget !== null && input.lostIsBudget !== undefined && input.lostIsBudget < 0.02;
  const damp = (f: (b: number) => number) => (b: number) => (saturated && b > input.currentBudgetMicros ? f(b) * 0.3 : f(b));

  const sim = input.simulation ? marginalFromSimulation(input.simulation) : null;
  if (sim) return { source: 'simulation', marginal: damp(sim), locked: false, reason: 'Google 預算模擬' };
  const fit = marginalFromHistory(input.history);
  if (fit) return { source: 'history', marginal: damp(fit.marginal), locked: false, reason: `近 14 天花費與轉換曲線（彈性 ${fit.k.toFixed(2)}）` };
  const rate = cost > 0 ? (conversions / cost) * 0.8 : 0;
  return { source: 'average', marginal: damp(() => rate), locked: false, reason: '平均轉換率（資料點不足以擬合曲線）' };
}

export interface StrategySnapshot {
  capturedAt: Date;
  bidStrategy: string | null;
  bidTarget: number | null;
}

/** A bid strategy or target change within `days` restarts learning (proxy for Google's status). */
export function isLearning(snapshots: readonly StrategySnapshot[], now: Date, days = 7): boolean {
  const since = now.getTime() - days * 86_400_000;
  const sorted = [...snapshots].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.capturedAt.getTime() < since) continue;
    if (cur.bidStrategy !== prev.bidStrategy || cur.bidTarget !== prev.bidTarget) return true;
  }
  return false;
}
