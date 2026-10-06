import { describe, expect, it } from 'vitest';
import { autoNegativeDecision, type NegativeCandidate } from './negatives';

const c = (over: Partial<NegativeCandidate> & { relevant?: boolean; confidence?: number } = {}): NegativeCandidate => ({
  term: over.term ?? 'free camera app',
  label: { intent: 'free_or_diy', relevant: over.relevant ?? false, confidence: over.confidence ?? 0.95, reason: '免費' },
  conversions90d: over.conversions90d ?? 0,
  costMicros: over.costMicros ?? 1_000_000,
});

describe('autoNegativeDecision (Requirement 14.4)', () => {
  it.each<[string, NegativeCandidate, string]>([
    ['all conditions met', c(), 'auto'],
    ['exactly at the confidence threshold', c({ confidence: 0.9 }), 'auto'],
    ['relevant terms are kept', c({ relevant: true, confidence: 0.99 }), 'keep'],
    ['low confidence', c({ confidence: 0.89 }), 'review'],
    ['converted in 90 days', c({ conversions90d: 0.5 }), 'review'],
    ['brand term', c({ term: 'Arlo free trial' }), 'review'],
    ['no cost', c({ costMicros: 0 }), 'review'],
  ])('%s', (_, candidate, decision) => {
    expect(autoNegativeDecision(candidate, ['arlo']).decision).toBe(decision);
  });

  it('explains every blocker', () => {
    expect(autoNegativeDecision(c({ confidence: 0.5, conversions90d: 2, term: 'arlo', costMicros: 0 }), ['arlo']).reason).toBe('信心 0.50 < 0.9、近 90 天有 2 次轉換、含品牌字、沒有花費');
  });
});
