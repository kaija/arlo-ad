import { describe, expect, it } from 'vitest';
import { BusinessProfileSchema, containsBrandTerm, EMPTY_BUSINESS_PROFILE, withExample } from './business-profile';

describe('Business Profile', () => {
  it('validates and fills defaults', () => {
    expect(BusinessProfileSchema.parse({ ...EMPTY_BUSINESS_PROFILE, offerings: [' 監視器 '], examples: [{ term: 'free camera', relevant: false }] })).toEqual({
      ...EMPTY_BUSINESS_PROFILE,
      offerings: ['監視器'],
      examples: [{ term: 'free camera', relevant: false, note: null }],
    });
    expect(BusinessProfileSchema.safeParse({ ...EMPTY_BUSINESS_PROFILE, competitorPolicy: 'bid' }).success).toBe(false);
  });

  it.each([
    ['arlo pro 5', ['Arlo'], true],
    ['ARLO 監視器', ['arlo'], true],
    ['ａｒｌｏ camera', ['arlo'], true],
    ['arlopro price', ['arlo pro'], true],
    ['ring doorbell', ['arlo'], false],
    ['anything', [''], false],
  ])('containsBrandTerm(%s, %j) = %s', (term, brands, expected) => {
    expect(containsBrandTerm(term, brands)).toBe(expected);
  });

  it('keeps one example per term, latest wins', () => {
    const p = withExample(withExample(EMPTY_BUSINESS_PROFILE, { term: 'Arlo Login', relevant: false, note: null }), { term: 'arlo  login', relevant: true, note: '客服流量' });
    expect(p.examples).toEqual([{ term: 'arlo  login', relevant: true, note: '客服流量' }]);
  });
});
