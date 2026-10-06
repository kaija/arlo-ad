// Deterministic Monitor (ADR-0017, Requirements 12.1–12.4): rules over recent metrics, evaluated
// every 15 minutes without an LLM. Pure; the worker loads the window and builds ChangeSets.
import { z } from 'zod';
import type { EntityRef, Op } from '../platform/types';

export const MonitorRuleSpecSchema = z.discriminatedUnion('type', [
  /** Today's spend vs daily budget × elapsed share of the day: pct 1.5 = spending 150% of pace. */
  z.object({ type: z.literal('SpendPacing'), pct: z.number().gt(1).max(20), minSpendMicros: z.number().int().nonnegative().default(0) }),
  /** Month-to-date spend reached pct (0.9 = 90%) of the MonthlySpendCap. */
  z.object({ type: z.literal('SpendNearCap'), pct: z.number().gt(0).max(2) }),
  /** CPA over the last `hours` above multiplier × target CPA, with at least minConv conversions. */
  z.object({ type: z.literal('CpaSpike'), hours: z.number().int().min(1).max(72), multiplier: z.number().gt(1).max(20), minConv: z.number().min(0) }),
  /** ROAS over the last `hours` below ratio × target ROAS, with at least minConv conversions. */
  z.object({ type: z.literal('RoasDrop'), hours: z.number().int().min(1).max(72), ratio: z.number().gt(0).lt(1), minConv: z.number().min(0) }),
]);
export type MonitorRuleSpec = z.infer<typeof MonitorRuleSpecSchema>;
export type MonitorRuleType = MonitorRuleSpec['type'];
export const MONITOR_RULE_TYPES: readonly MonitorRuleType[] = ['SpendPacing', 'SpendNearCap', 'CpaSpike', 'RoasDrop'];

export const MonitorActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pause') }),
  /** Lower the daily budget by pct (0.3 = −30%). */
  z.object({ kind: z.literal('reduce_budget'), pct: z.number().gt(0).max(0.9) }),
  /** Make the bid target more conservative by pct: lower tCPA, higher tROAS. */
  z.object({ kind: z.literal('reduce_target'), pct: z.number().gt(0).max(0.9) }),
]);
export type MonitorAction = z.infer<typeof MonitorActionSchema>;

export const DEFAULT_COOLDOWN_MINUTES = 360;

/** What the worker measured for one entity (a campaign, or the account for SpendNearCap). */
export interface MonitorWindow {
  /** Spend so far today and the share of the day elapsed in the account timezone (0–1). */
  todaySpendMicros?: number;
  dayElapsed?: number;
  dailyBudgetMicros?: number | null;
  /** Month to date vs the MonthlySpendCap in force. */
  mtdSpendMicros?: number;
  monthlyCapMicros?: number | null;
  /** Totals over the rule's `hours`. */
  windowCostMicros?: number;
  windowConversions?: number;
  windowConvValue?: number;
  /** Bid targets in force: CPA in micros, ROAS as a ratio. */
  targetCpaMicros?: number | null;
  targetRoas?: number | null;
}

export interface MonitorEvaluation {
  triggered: boolean;
  /** Numbers behind the decision, for the ChangeSet rationale and the audit agent. */
  evidence: Record<string, number | null>;
  /** Why it could not be evaluated, when it could not. */
  skipped?: string;
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export function evaluateMonitor(rule: MonitorRuleSpec, w: MonitorWindow): MonitorEvaluation {
  switch (rule.type) {
    case 'SpendPacing': {
      const spend = w.todaySpendMicros ?? 0;
      const budget = w.dailyBudgetMicros ?? 0;
      const elapsed = w.dayElapsed ?? 0;
      if (!(budget > 0) || !(elapsed > 0)) return { triggered: false, evidence: { spendMicros: spend, budgetMicros: budget || null }, skipped: 'no budget or day not started' };
      const expected = budget * Math.min(1, elapsed);
      const pacing = spend / expected;
      return { triggered: pacing > rule.pct && spend >= rule.minSpendMicros, evidence: { spendMicros: spend, budgetMicros: budget, dayElapsed: round(elapsed), pacing: round(pacing), threshold: rule.pct } };
    }
    case 'SpendNearCap': {
      const cap = w.monthlyCapMicros ?? 0;
      const mtd = w.mtdSpendMicros ?? 0;
      if (!(cap > 0)) return { triggered: false, evidence: { mtdMicros: mtd, capMicros: null }, skipped: 'no MonthlySpendCap' };
      const share = mtd / cap;
      return { triggered: share >= rule.pct, evidence: { mtdMicros: mtd, capMicros: cap, share: round(share), threshold: rule.pct } };
    }
    case 'CpaSpike': {
      const target = w.targetCpaMicros ?? 0;
      const conv = w.windowConversions ?? 0;
      const cost = w.windowCostMicros ?? 0;
      if (!(target > 0)) return { triggered: false, evidence: { targetCpaMicros: null }, skipped: 'no target CPA' };
      if (conv < rule.minConv || conv <= 0) return { triggered: false, evidence: { conversions: conv, minConv: rule.minConv, costMicros: cost } };
      const cpa = cost / conv;
      return { triggered: cpa > rule.multiplier * target, evidence: { cpaMicros: Math.round(cpa), targetCpaMicros: target, ratio: round(cpa / target), threshold: rule.multiplier, conversions: conv, costMicros: cost, hours: rule.hours } };
    }
    case 'RoasDrop': {
      const target = w.targetRoas ?? 0;
      const conv = w.windowConversions ?? 0;
      const cost = w.windowCostMicros ?? 0;
      if (!(target > 0)) return { triggered: false, evidence: { targetRoas: null }, skipped: 'no target ROAS' };
      if (conv < rule.minConv || !(cost > 0)) return { triggered: false, evidence: { conversions: conv, minConv: rule.minConv, costMicros: cost } };
      const roas = (w.windowConvValue ?? 0) / (cost / 1_000_000);
      return { triggered: roas < rule.ratio * target, evidence: { roas: round(roas), targetRoas: target, ratio: round(roas / target), threshold: rule.ratio, conversions: conv, costMicros: cost, hours: rule.hours } };
    }
  }
}

/** Whether the same rule fired for the same entity within the cooldown (Requirement 12.4). */
export function inCooldown(lastFiredAt: Date | null | undefined, cooldownMinutes: number, now: Date): boolean {
  return !!lastFiredAt && now.getTime() - lastFiredAt.getTime() < cooldownMinutes * 60_000;
}

/** A campaign's current state, as the Monitor saw it (ChangeSet `before` values). */
export interface MonitoredCampaign {
  ref: EntityRef;
  status: string | null;
  budgetMicros: number | null;
  bidStrategy: string | null;
  bidTarget: number | null;
}

const CPA = new Set(['TARGET_CPA', 'MAXIMIZE_CONVERSIONS']);
const ROAS = new Set(['TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE']);
/** Budgets move in whole cents (10,000 micros) so the platform accepts them. */
const roundBudget = (micros: number) => Math.max(10_000, Math.floor(micros / 10_000) * 10_000);

/**
 * The protective ops for `action` on a campaign; empty when nothing applies (already paused,
 * no budget, no target). Protective by construction, so they classify as Tier 1 within limits.
 */
export function monitorActionOps(action: MonitorAction, c: MonitoredCampaign): Op[] {
  switch (action.kind) {
    case 'pause':
      return c.status === 'ENABLED' ? [{ kind: 'set_status', target: c.ref, field: 'status', before: c.status, after: 'PAUSED' }] : [];
    case 'reduce_budget': {
      if (!c.budgetMicros || c.status !== 'ENABLED') return [];
      const after = roundBudget(c.budgetMicros * (1 - action.pct));
      return after < c.budgetMicros ? [{ kind: 'set_budget', target: c.ref, field: 'budget_micros', before: c.budgetMicros, after }] : [];
    }
    case 'reduce_target': {
      if (!c.bidTarget || !c.bidStrategy) return [];
      if (CPA.has(c.bidStrategy)) {
        const after = Math.max(10_000, Math.round((c.bidTarget * (1 - action.pct)) / 10_000) * 10_000);
        return after < c.bidTarget ? [{ kind: 'set_bid_target', target: c.ref, field: 'target_cpa_micros', before: c.bidTarget, after }] : [];
      }
      if (ROAS.has(c.bidStrategy)) {
        return [{ kind: 'set_bid_target', target: c.ref, field: 'target_roas', before: c.bidTarget, after: round(c.bidTarget * (1 + action.pct), 4) }];
      }
      return [];
    }
  }
}
