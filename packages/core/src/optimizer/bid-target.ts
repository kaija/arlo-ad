// tCPA / tROAS tuning (ADR-0018, Requirement 13.5): nudge the target toward what the campaign
// actually achieved over 14 days, at most ±maxStepPct per change, skipping learning and thin
// campaigns. BidTargetRange rules are enforced later by the validator. Pure.

const CPA = new Set(['TARGET_CPA', 'MAXIMIZE_CONVERSIONS']);
const ROAS = new Set(['TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE']);

export interface BidTargetInput {
  bidStrategy: string | null;
  /** tCPA in micros or tROAS as a ratio. */
  currentTarget: number | null;
  costMicros: number;
  conversions: number;
  convValue: number;
  learning: boolean;
}

export interface BidTargetOptions {
  maxStepPct?: number;
  /** Ignore gaps smaller than this (default 0.05). */
  deadband?: number;
  minConversions?: number;
}

export type BidTargetSuggestion =
  | { action: 'skip'; reason: string }
  | { action: 'adjust'; field: 'target_cpa_micros' | 'target_roas'; before: number; after: number; actual: number; reason: string };

export function suggestBidTarget(c: BidTargetInput, opts: BidTargetOptions = {}): BidTargetSuggestion {
  const maxStep = opts.maxStepPct ?? 0.15;
  const deadband = opts.deadband ?? 0.05;
  const minConv = opts.minConversions ?? 30;
  const strategy = c.bidStrategy ?? '';
  const cpa = CPA.has(strategy);
  if (!cpa && !ROAS.has(strategy)) return { action: 'skip', reason: '出價策略沒有目標' };
  if (!c.currentTarget || c.currentTarget <= 0) return { action: 'skip', reason: '沒有設定目標' };
  if (c.learning) return { action: 'skip', reason: '學習中' };
  if (c.conversions < minConv) return { action: 'skip', reason: `近 14 天轉換 ${Math.round(c.conversions)} 次，資料不足` };
  if (c.costMicros <= 0) return { action: 'skip', reason: '沒有花費' };

  const actual = cpa ? c.costMicros / c.conversions : c.convValue / (c.costMicros / 1_000_000);
  const gap = (actual - c.currentTarget) / c.currentTarget;
  if (Math.abs(gap) < deadband) return { action: 'skip', reason: '實際表現接近目標' };
  const bounded = c.currentTarget * (1 + Math.max(-maxStep, Math.min(maxStep, gap)));
  const after = cpa ? Math.round(bounded / 10_000) * 10_000 : Math.round(bounded * 100) / 100;
  if (after === c.currentTarget) return { action: 'skip', reason: '調整幅度小於最小單位' };
  const pct = `${Math.round(((after - c.currentTarget) / c.currentTarget) * 100)}%`;
  return {
    action: 'adjust',
    field: cpa ? 'target_cpa_micros' : 'target_roas',
    before: c.currentTarget,
    after,
    actual: cpa ? Math.round(actual) : Math.round(actual * 100) / 100,
    reason: cpa ? `近 14 天實際 CPA 與目標差 ${Math.round(gap * 100)}%，目標調整 ${pct}` : `近 14 天實際 ROAS 與目標差 ${Math.round(gap * 100)}%，目標調整 ${pct}`,
  };
}
