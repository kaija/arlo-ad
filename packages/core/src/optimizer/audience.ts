// Audience bid adjustments and exclusions (ADR-0022, Requirement 17.2): compare a segment's CPA
// (or ROAS) with its campaign over the same window, nudge the modifier at most ±maxStepPct per
// change, and flag segments that keep spending without converting. Pure.

/** Strategies that apply audience bid adjustments; Smart Bidding ignores them. */
const MODIFIER_STRATEGIES = new Set(['MANUAL_CPC', 'MANUAL_CPM', 'MANUAL_CPV']);
export const AUDIENCE_MODIFIER_MIN = 0.1;
export const AUDIENCE_MODIFIER_MAX = 10;

export interface AudiencePerformance {
  costMicros: number;
  clicks: number;
  conversions: number;
  convValue: number;
}

export interface AudienceSegmentInput {
  bidStrategy: string | null;
  /** Current modifier on the criterion; null = none (1). */
  currentModifier: number | null;
  segment: AudiencePerformance;
  /** The whole campaign over the same window. */
  campaign: AudiencePerformance;
  /** Compare ROAS instead of CPA. */
  valueBased?: boolean;
}

export interface AudienceOptions {
  maxStepPct?: number;
  /** Ignore gaps smaller than this (default 0.1). */
  deadband?: number;
  /** Segment conversions needed before adjusting (default 10). */
  minConversions?: number;
  /** Exclusion: clicks without a conversion (default 50)… */
  excludeMinClicks?: number;
  /** …and spend of at least this many campaign CPAs (default 3). */
  excludeCostMultiple?: number;
}

export type AudienceSuggestion =
  | { action: 'skip'; reason: string }
  | { action: 'modifier'; before: number; after: number; reason: string }
  | { action: 'exclude'; reason: string };

const round2 = (n: number) => Math.round(n * 100) / 100;

export function suggestAudienceAction(input: AudienceSegmentInput, opts: AudienceOptions = {}): AudienceSuggestion {
  const maxStep = opts.maxStepPct ?? 0.2;
  const deadband = opts.deadband ?? 0.1;
  const minConv = opts.minConversions ?? 10;
  const { segment: s, campaign: c } = input;
  if (c.conversions <= 0 || c.costMicros <= 0) return { action: 'skip', reason: 'campaign 沒有轉換，無法比較' };

  const campaignCpa = c.costMicros / c.conversions;
  if (s.conversions === 0 && s.clicks >= (opts.excludeMinClicks ?? 50) && s.costMicros >= campaignCpa * (opts.excludeCostMultiple ?? 3)) {
    return { action: 'exclude', reason: `${s.clicks} 次點擊、花費約 campaign CPA 的 ${round2(s.costMicros / campaignCpa)} 倍，沒有轉換` };
  }
  if (!MODIFIER_STRATEGIES.has(input.bidStrategy ?? '')) return { action: 'skip', reason: '智慧出價不套用受眾出價調整' };
  if (s.conversions < minConv) return { action: 'skip', reason: `轉換 ${Math.round(s.conversions)} 次，資料不足` };

  let ratio: number;
  if (input.valueBased) {
    if (c.convValue <= 0 || s.costMicros <= 0) return { action: 'skip', reason: '沒有轉換價值，無法比較' };
    ratio = s.convValue / s.costMicros / (c.convValue / c.costMicros);
  } else {
    if (s.costMicros <= 0) return { action: 'skip', reason: '沒有花費' };
    ratio = campaignCpa / (s.costMicros / s.conversions);
  }
  if (Math.abs(ratio - 1) < deadband) return { action: 'skip', reason: '表現接近 campaign 平均' };

  const before = input.currentModifier ?? 1;
  const bounded = before * Math.max(1 - maxStep, Math.min(1 + maxStep, ratio));
  const after = Math.min(AUDIENCE_MODIFIER_MAX, Math.max(AUDIENCE_MODIFIER_MIN, Math.round(bounded * 20) / 20));
  if (after === before) return { action: 'skip', reason: '調整幅度小於最小單位' };
  const metric = input.valueBased ? 'ROAS' : 'CPA';
  const better = ratio > 1 ? '優於' : '差於';
  return { action: 'modifier', before, after, reason: `${metric} ${better} campaign 平均 ${Math.round(Math.abs(ratio - 1) * 100)}%，出價調整 ×${before.toFixed(2)} → ×${after.toFixed(2)}` };
}
