// Automatic negative keyword condition (ADR-0019, Requirement 14.4). Pure: the sweep decides with
// it, tests pin it down. Everything else judged irrelevant goes to a Tier 2 batch for review.
import { containsBrandTerm, type SearchTermLabel } from './business-profile';

export const AUTO_NEGATIVE_MIN_CONFIDENCE = 0.9;
/** Dedicated shared negative list, so automatic exclusions can be rolled back as a whole. */
export const AUTO_NEGATIVE_LIST_NAME = 'arlo-auto-negatives';

export interface NegativeCandidate {
  term: string;
  label: SearchTermLabel;
  /** Conversions over the last 90 days. */
  conversions90d: number;
  /** Cost over the sweep window, in micros. */
  costMicros: number;
}

export type NegativeDecision = 'auto' | 'review' | 'keep';

export function autoNegativeDecision(c: NegativeCandidate, brandTerms: readonly string[]): { decision: NegativeDecision; reason: string } {
  if (c.label.relevant) return { decision: 'keep', reason: '判定為相關' };
  const blockers: string[] = [];
  if (c.label.confidence < AUTO_NEGATIVE_MIN_CONFIDENCE) blockers.push(`信心 ${c.label.confidence.toFixed(2)} < ${AUTO_NEGATIVE_MIN_CONFIDENCE}`);
  if (c.conversions90d > 0) blockers.push(`近 90 天有 ${c.conversions90d} 次轉換`);
  if (containsBrandTerm(c.term, brandTerms)) blockers.push('含品牌字');
  if (!(c.costMicros > 0)) blockers.push('沒有花費');
  return blockers.length ? { decision: 'review', reason: blockers.join('、') } : { decision: 'auto', reason: c.label.reason };
}
