import type { CampaignDraft } from '@arlo/core';
import { describe, expect, it } from 'vitest';
import { draftFromForm, keywordsToText } from './campaign-draft';

const ad = { headlines: ['Arlo Pro 6', '2K 夜視', '免佈線'], descriptions: ['看清每個細節。', '立即預購。'], finalUrl: 'https://www.arlo.com/pro6', path1: '監視器', path2: null };
const draft: CampaignDraft = {
  campaign: { name: 'Pro 6', dailyBudget: 1500, biddingStrategy: 'TARGET_CPA', targetCpa: 300, locations: ['台灣', '香港'], languages: ['zh-TW'] },
  adGroups: [
    { name: '品牌', keywords: [{ text: 'arlo pro 6', matchType: 'PHRASE' }, { text: 'arlo', matchType: 'EXACT' }], ads: [ad] },
    { name: '通用', keywords: [{ text: '監視器', matchType: 'BROAD' }], ads: [ad] },
  ],
  negativeKeywords: [{ text: '免費', matchType: 'PHRASE' }],
  rationale: 'r',
};

/** What the editor posts for a draft. */
function toForm(d: CampaignDraft, extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  const set = (k: string, v: string) => f.set(k, v);
  set('c_name', d.campaign.name);
  set('c_budget', String(d.campaign.dailyBudget));
  set('c_strategy', d.campaign.biddingStrategy);
  set('c_targetCpa', d.campaign.targetCpa === null ? '' : String(d.campaign.targetCpa));
  set('c_locations', d.campaign.locations.join(', '));
  set('c_languages', d.campaign.languages.join(', '));
  set('g_count', String(d.adGroups.length));
  d.adGroups.forEach((g, i) => {
    set(`g${i}_name`, g.name);
    set(`g${i}_keywords`, keywordsToText(g.keywords));
    set(`g${i}_adCount`, String(g.ads.length));
    g.ads.forEach((a, j) => {
      const p = `g${i}_ad${j}_`;
      set(`${p}headlines`, a.headlines.join('\n'));
      set(`${p}descriptions`, a.descriptions.join('\n'));
      set(`${p}finalUrl`, a.finalUrl);
      set(`${p}path1`, a.path1 ?? '');
      set(`${p}path2`, a.path2 ?? '');
    });
  });
  set('negatives', keywordsToText(d.negativeKeywords));
  set('rationale', d.rationale);
  for (const [k, v] of Object.entries(extra)) set(k, v);
  return f;
}

describe('draftFromForm', () => {
  it('round-trips a draft', () => {
    expect(draftFromForm(toForm(draft))).toEqual({ ok: true, draft });
  });

  it('removes ticked ad groups and defaults match types to PHRASE', () => {
    const r = draftFromForm(toForm(draft, { g1_remove: 'on', g0_keywords: 'arlo pro 6\narlo | exact\n\n' }));
    expect(r).toMatchObject({ ok: true, draft: { adGroups: [{ name: '品牌', keywords: [{ text: 'arlo pro 6', matchType: 'PHRASE' }, { text: 'arlo', matchType: 'EXACT' }] }] } });
  });

  it('explains structural errors', () => {
    expect(draftFromForm(toForm(draft, { g0_ad0_headlines: 'only one' }))).toEqual({ ok: false, error: expect.stringContaining('標題需 3–15 個') });
    expect(draftFromForm(toForm(draft, { g0_remove: 'on', g1_remove: 'on' }))).toEqual({ ok: false, error: expect.stringContaining('至少保留一個廣告群組') });
  });
});
