import { describe, expect, it } from 'vitest';
import type { CampaignDraft } from './draft';
import { mergeDraftSection } from './merge';

const ad = (h: string) => ({ headlines: [h, 'b', 'c'], descriptions: ['d', 'e'], finalUrl: 'https://a.com', path1: null, path2: null });
const current: CampaignDraft = {
  campaign: { name: 'c', dailyBudget: 1000, biddingStrategy: 'MAXIMIZE_CONVERSIONS', targetCpa: null, locations: ['台灣'], languages: ['zh-TW'] },
  adGroups: [
    { name: '品牌', keywords: [{ text: 'arlo', matchType: 'EXACT' }], ads: [ad('edited by person')] },
    { name: '通用', keywords: [{ text: '監視器', matchType: 'PHRASE' }], ads: [ad('generic')] },
  ],
  negativeKeywords: [{ text: '免費', matchType: 'PHRASE' }],
  rationale: 'old',
};
const generated: CampaignDraft = {
  campaign: { ...current.campaign, name: 'renamed', dailyBudget: 2000, biddingStrategy: 'TARGET_CPA', targetCpa: 300 },
  adGroups: [
    { name: '品牌 ', keywords: [{ text: 'arlo pro', matchType: 'PHRASE' }], ads: [ad('new brand ad')] },
    { name: '新群組', keywords: [{ text: 'doorbell', matchType: 'PHRASE' }], ads: [ad('new')] },
  ],
  negativeKeywords: [{ text: '求職', matchType: 'PHRASE' }],
  rationale: 'new',
};

describe('mergeDraftSection', () => {
  it('keywords: replaces keywords of matching ad groups only', () => {
    const m = mergeDraftSection(current, generated, 'keywords');
    expect(m.adGroups.map((g) => g.keywords[0]!.text)).toEqual(['arlo pro', '監視器']);
    expect(m.adGroups[0]!.ads[0]!.headlines[0]).toBe('edited by person');
    expect(m.campaign).toEqual(current.campaign);
  });

  it('ads: keeps keywords and other groups', () => {
    const m = mergeDraftSection(current, generated, 'ads');
    expect(m.adGroups.map((g) => g.ads[0]!.headlines[0])).toEqual(['new brand ad', 'generic']);
    expect(m.adGroups[0]!.keywords).toEqual(current.adGroups[0]!.keywords);
  });

  it('budget: only budget and bidding change', () => {
    const m = mergeDraftSection(current, generated, 'budget');
    expect(m.campaign).toEqual({ ...current.campaign, dailyBudget: 2000, biddingStrategy: 'TARGET_CPA', targetCpa: 300 });
    expect(m.adGroups).toBe(current.adGroups);
  });

  it('negatives and structure', () => {
    expect(mergeDraftSection(current, generated, 'negatives').negativeKeywords).toEqual(generated.negativeKeywords);
    const s = mergeDraftSection(current, generated, 'structure');
    expect(s.adGroups).toBe(generated.adGroups);
    expect(s.campaign).toEqual(current.campaign);
  });
});
