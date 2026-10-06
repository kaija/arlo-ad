// Risk tier of a ChangeSet (ADR-0007, Requirements 4.1–4.5). Pure.
import { budgetDeltaMicros, changeRatio, classifyOp } from '../changeset/classify';
import type { Tier, Violation } from '../changeset/types';
import type { Op } from '../platform/types';

export interface TierThresholds {
  /** A change larger than this ratio (0.5 = 50%) is Tier 3. */
  tier3Pct: number;
  /** A budget change (per op or summed over the ChangeSet) above this many micros is Tier 3; null = off. */
  tier3AmountMicros: number | null;
  /** Protective reductions up to this ratio run automatically (Tier 1); larger ones need approval. */
  tier1MaxReducePct: number;
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = { tier3Pct: 0.5, tier3AmountMicros: null, tier1MaxReducePct: 0.3 };

export interface OpTier {
  opIndex: number;
  tier: Tier;
  reason: string;
}

/** Budget a create op commits to, for the Tier 3 amount threshold. */
function createdBudgetMicros(op: Op): number {
  if (op.kind !== 'google.create_campaign_bundle') return 0;
  const b = (op.after as { budgetMicros?: unknown } | null)?.budgetMicros;
  return typeof b === 'number' ? b : 0;
}

export function tierOfOp(op: Op, opIndex: number, t: TierThresholds): OpTier {
  const cls = classifyOp(op);
  const ratio = changeRatio(op);
  const amount = budgetDeltaMicros(op) || createdBudgetMicros(op);

  if (ratio !== null && ratio > t.tier3Pct) return { opIndex, tier: 3, reason: `變動 ${Number.isFinite(ratio) ? `${(ratio * 100).toFixed(0)}%` : '∞'} 超過 Tier 3 門檻` };
  if (t.tier3AmountMicros !== null && amount > t.tier3AmountMicros) return { opIndex, tier: 3, reason: '變動金額超過 Tier 3 門檻' };
  if (cls === 'protective') {
    if (ratio !== null && ratio > t.tier1MaxReducePct) return { opIndex, tier: 2, reason: '減量幅度超過自動執行門檻' };
    return { opIndex, tier: 1, reason: '保護性變更' };
  }
  return { opIndex, tier: 2, reason: cls === 'expansive' ? '擴張性變更' : '一般變更' };
}

export interface TierResult {
  tier: Tier;
  ops: OpTier[];
  reasons: string[];
}

/** The highest op tier (Requirement 4.5), raised to Tier 2 by WARN violations (Requirement 5.4). */
export function computeTierDetailed(ops: readonly Op[], t: TierThresholds, violations: readonly Violation[] = []): TierResult {
  if (ops.length === 0) return { tier: 0, ops: [], reasons: ['沒有變更'] };
  const perOp = ops.map((op, i) => tierOfOp(op, i, t));
  let tier = Math.max(...perOp.map((o) => o.tier)) as Tier;
  const reasons = [...new Set(perOp.filter((o) => o.tier === tier).map((o) => o.reason))];

  const total = ops.reduce((s, op) => s + budgetDeltaMicros(op), 0);
  if (t.tier3AmountMicros !== null && total > t.tier3AmountMicros && tier < 3) {
    tier = 3;
    reasons.splice(0, reasons.length, 'ChangeSet 合計變動金額超過 Tier 3 門檻');
  }
  if (violations.some((v) => v.severity === 'WARN') && tier < 2) {
    tier = 2;
    reasons.splice(0, reasons.length, '有 validator 警告，需要人工審核');
  }
  return { tier, ops: perOp, reasons };
}

export function computeTier(cs: { ops: readonly Op[] }, t: TierThresholds, violations: readonly Violation[] = []): Tier {
  return computeTierDetailed(cs.ops, t, violations).tier;
}
