import { describe, expect, it } from 'vitest';
import type { CampaignDraft, Rsa } from './draft';
import { adTextWidth, hasLintErrors, lintRsa, lintStructure } from './lint';

const rsa = (over: Partial<Rsa> = {}): Rsa => ({
  headlines: ['Arlo Pro 6 監視器', '2K HDR 夜視', '免佈線輕鬆安裝', '雲端與本地儲存', '官方網站預購', '戶外防水設計', '智慧偵測人車', 'Arlo 官方保固'],
  descriptions: ['2K HDR 影像與彩色夜視，看清每個細節。', '無線免佈線，十分鐘完成安裝，立即預購。'],
  finalUrl: 'https://www.arlo.com/pro6',
  path1: '監視器',
  path2: null,
  ...over,
});
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('adTextWidth', () => {
  it.each([
    ['Arlo', 4],
    ['監視器', 6],
    ['Ａｒｌｏ', 8],
    ['2K 監視器', 9],
    ['{KeyWord:監視器} 推薦', 11],
  ])('%s → %d', (text, width) => {
    expect(adTextWidth(text)).toBe(width);
  });
});

describe('lintRsa', () => {
  it('passes a clean ad', () => {
    expect(lintRsa(rsa())).toEqual([]);
  });

  it.each<[string, Partial<Rsa>, string]>([
    ['CJK headline over 30', { headlines: [...rsa().headlines.slice(1), '這是一個超過三十個字元寬度的中文標題'] }, 'TOO_LONG'],
    ['too few headlines', { headlines: ['a', 'b'] }, 'HEADLINE_COUNT'],
    ['too many descriptions', { descriptions: ['一', '二', '三', '四', '五'] }, 'DESCRIPTION_COUNT'],
    ['duplicate headline (case and spaces)', { headlines: [...rsa().headlines, 'arlo  pro 6 監視器'] }, 'DUPLICATE'],
    ['exclamation in headline', { headlines: [...rsa().headlines.slice(1), '限時預購!'] }, 'EXCLAMATION_IN_HEADLINE'],
    ['two exclamations in a description', { descriptions: ['立即預購！現在下單！', '說明二'] }, 'TOO_MANY_EXCLAMATIONS'],
    ['repeated punctuation', { descriptions: ['真的嗎??', '說明二'] }, 'REPEATED_PUNCTUATION'],
    ['decorative symbol', { headlines: [...rsa().headlines.slice(1), '★ 熱銷款'] }, 'SYMBOLS'],
    ['phone number', { descriptions: ['來電 02-2345-6789 洽詢', '說明二'] }, 'PHONE_NUMBER'],
    ['http final url', { finalUrl: 'http://www.arlo.com' }, 'FINAL_URL'],
    ['path2 without path1', { path1: null, path2: 'pro6' }, 'PATH2_WITHOUT_PATH1'],
  ])('%s', (_, over, code) => {
    const issues = lintRsa(rsa(over));
    expect(codes(issues)).toContain(code);
    expect(hasLintErrors(issues)).toBe(true);
  });

  it.each<[string, Partial<Rsa>, string]>([
    ['unsupported superlative', { headlines: [...rsa().headlines.slice(1), '全台第一監視器'] }, 'UNSUPPORTED_CLAIM'],
    ['shouting', { headlines: [...rsa().headlines.slice(1), 'BEST DEAL NOW'] }, 'ALL_CAPS'],
    ['few headlines', { headlines: rsa().headlines.slice(0, 4) }, 'FEW_HEADLINES'],
  ])('warns on %s', (_, over, code) => {
    const issues = lintRsa(rsa(over));
    expect(codes(issues)).toContain(code);
    expect(issues.find((i) => i.code === code)?.severity).toBe('warning');
  });
});

describe('lintStructure', () => {
  const draft = (over: Partial<CampaignDraft> = {}): CampaignDraft => ({
    campaign: { name: 'Pro 6', dailyBudget: 1500, biddingStrategy: 'MAXIMIZE_CONVERSIONS', targetCpa: null, locations: ['台灣'], languages: ['zh-TW'] },
    adGroups: [
      { name: '品牌', keywords: [{ text: 'arlo pro 6', matchType: 'PHRASE' }], ads: [rsa()] },
      { name: '通用', keywords: [{ text: '無線監視器', matchType: 'PHRASE' }], ads: [rsa()] },
    ],
    negativeKeywords: [{ text: '免費', matchType: 'PHRASE' }],
    rationale: 'r',
    ...over,
  });

  it('passes a clean draft', () => {
    expect(lintStructure(draft(), { landingPageUrl: 'https://arlo.com/pro6' })).toEqual([]);
  });

  it.each<[string, Partial<CampaignDraft>, string]>([
    ['TARGET_CPA without a target', { campaign: { ...draft().campaign, biddingStrategy: 'TARGET_CPA', targetCpa: null } }, 'TARGET_CPA_MISSING'],
    ['negative blocks a keyword', { negativeKeywords: [{ text: '監視器', matchType: 'PHRASE' }] }, 'NEGATIVE_BLOCKS_KEYWORD'],
    ['exact negative equals a keyword', { negativeKeywords: [{ text: 'Arlo Pro 6', matchType: 'EXACT' }] }, 'NEGATIVE_BLOCKS_KEYWORD'],
    ['duplicate ad group names', { adGroups: [draft().adGroups[0]!, { ...draft().adGroups[1]!, name: '品牌' }] }, 'DUPLICATE'],
    ['keyword with symbols', { adGroups: [{ ...draft().adGroups[0]!, keywords: [{ text: 'arlo!', matchType: 'EXACT' }] }] }, 'KEYWORD_CHARS'],
    ['ad without keywords', { adGroups: [{ ...draft().adGroups[0]!, keywords: [] }] }, 'NO_KEYWORDS'],
    ['other domain', { adGroups: [{ ...draft().adGroups[0]!, ads: [rsa({ finalUrl: 'https://example.com' })] }] }, 'DOMAIN_MISMATCH'],
  ])('%s', (_, over, code) => {
    expect(codes(lintStructure(draft(over), { landingPageUrl: 'https://www.arlo.com/pro6' }))).toContain(code);
  });

  it('warns about keywords competing across ad groups', () => {
    const issues = lintStructure(draft({ adGroups: [draft().adGroups[0]!, { ...draft().adGroups[1]!, keywords: [{ text: 'Arlo Pro 6', matchType: 'PHRASE' }] }] }));
    expect(issues).toEqual([expect.objectContaining({ code: 'DUPLICATE_KEYWORD', severity: 'warning', path: 'adGroups[1].keywords[0]' })]);
  });
});
