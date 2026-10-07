import { describe, expect, it } from 'vitest';
import type { CampaignDraft } from './draft';
import { draftToBundle, geoTargetId, languageId } from './bundle';

const ad = { headlines: ['Arlo Pro 6', '2K 夜視', '免佈線', '官方預購', '雲端儲存', '防水設計', '智慧偵測', '官方保固'], descriptions: ['看清每個細節。', '立即預購。'], finalUrl: 'https://www.arlo.com/pro6', path1: null, path2: null };
const draft = (over: Partial<CampaignDraft['campaign']> = {}): CampaignDraft => ({
  campaign: { name: 'Pro 6', dailyBudget: 1500.004, biddingStrategy: 'TARGET_CPA', targetCpa: 300, locations: ['台灣', 'Hong Kong'], languages: ['zh-TW', 'en'], ...over },
  adGroups: [{ name: 'g', keywords: [{ text: 'arlo pro 6', matchType: 'PHRASE' }], ads: [ad] }],
  negativeKeywords: [],
  rationale: 'r',
});

describe('draftToBundle', () => {
  it('maps targets and money and is always paused', () => {
    expect(draftToBundle(draft())).toEqual({
      ok: true,
      bundle: expect.objectContaining({ name: 'Pro 6', budgetMicros: 1_500_000_000, targetCpaMicros: 300_000_000, geoTargetIds: [2158, 2344], languageIds: [1018, 1000], status: 'PAUSED' }),
    });
    expect(draftToBundle(draft({ biddingStrategy: 'MAXIMIZE_CONVERSIONS', targetCpa: null }))).toMatchObject({ bundle: { targetCpaMicros: null } });
  });

  it('refuses unknown targets and lint errors', () => {
    const r = draftToBundle(draft({ locations: ['火星'], languages: ['klingon'], targetCpa: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code).sort()).toEqual(['TARGET_CPA_MISSING', 'UNKNOWN_LANGUAGE', 'UNKNOWN_LOCATION']);
  });

  it('looks up names case-insensitively', () => {
    expect([geoTargetId(' United States '), geoTargetId('台灣'), languageId('ZH-TW'), geoTargetId('nowhere')]).toEqual([2840, 2158, 1018, null]);
  });
});
