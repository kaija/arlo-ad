import { describe, expect, it } from 'vitest';
import { keywordCandidates, type IdeaInput } from './keyword-candidates';

const idea = (text: string, searches: number | null = 100): IdeaInput => ({ text, avgMonthlySearches: searches, competition: 'MEDIUM', lowTopBidMicros: 1, highTopBidMicros: 2 });

describe('keywordCandidates (Requirement 14.7)', () => {
  it('ranks converting search terms first, then planner ideas, without duplicates', () => {
    const out = keywordCandidates(
      [idea('Wireless Camera', 5000), idea('wireless  camera', 4000), idea('arlo pro 6 price', 300), idea('doorbell camera', 9000)],
      [
        { term: 'arlo pro 6 price', conversions: 2, clicks: 10, costMicros: 1 },
        { term: 'ARLO pro 6 price', conversions: 1, clicks: 5, costMicros: 1 },
        { term: 'outdoor cam', conversions: 4, clicks: 9, costMicros: 1 },
      ],
      { existing: [], negatives: [] },
    );
    expect(out.map((c) => [c.text, c.source, c.matchType, c.conversions])).toEqual([
      ['outdoor cam', 'search_term', 'EXACT', 4],
      ['arlo pro 6 price', 'both', 'EXACT', 3],
      ['doorbell camera', 'planner', 'PHRASE', 0],
      ['wireless camera', 'planner', 'PHRASE', 0],
    ]);
  });

  it('drops existing keywords, negated terms and non-converting search terms', () => {
    const out = keywordCandidates([idea('free camera app'), idea('Arlo Camera'), idea('camera jobs near me'), idea('security camera')], [{ term: 'cheap cam', conversions: 0, clicks: 30, costMicros: 1 }], {
      existing: ['arlo camera'],
      negatives: ['free', 'jobs'],
    });
    expect(out.map((c) => c.text)).toEqual(['security camera']);
  });

  it('limits the list', () => {
    expect(keywordCandidates(Array.from({ length: 80 }, (_, i) => idea(`kw ${i}`, i)), [], { existing: [], negatives: [], limit: 5 })).toHaveLength(5);
  });
});
