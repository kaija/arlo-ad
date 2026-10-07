// Deterministic RSA and structure lint (ADR-0020, Requirement 15.3). The campaign agent's draft
// must pass before it is stored; failures go back to the agent (at most twice).
import type { CampaignDraft, Rsa } from './draft';

export interface LintIssue {
  severity: 'error' | 'warning';
  code: string;
  /** Where in the draft, e.g. adGroups[0].ads[0].headlines[2]. */
  path: string;
  message: string;
}

export const HEADLINE_MAX = 30;
export const DESCRIPTION_MAX = 90;
export const PATH_MAX = 15;

// East Asian wide and full-width characters count double in Google Ads.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏！-｠￠-￦]/u;

/** Display width as Google counts it; {KeyWord:default} counts its default text only. */
export function adTextWidth(text: string): number {
  const expanded = text.replace(/\{(?:keyword|KeyWord|Keyword|KEYWORD|KEYword|KeyWORD):([^}]*)\}/g, '$1');
  let n = 0;
  for (const ch of expanded) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// Google editorial policy patterns, and claims a reviewer would ask to substantiate.
const SYMBOLS = /[★☆✓✔✗❤♥→←⇒✨🔥]/u;
const REPEATED_PUNCT = /([!?！？.。])\1/u;
const PHONE = /(?:\+?\d[\d\s-]{7,}\d)/;
const SUPERLATIVES = /(最便宜|最好|第一名|全台第一|第一|No\.?\s?1|#1|best\b|cheapest|guaranteed|保證|100%)/iu;
const ALL_CAPS_WORD = /\b[A-Z]{4,}\b/;
// Common acronyms that are fine in caps.
const CAPS_OK = new Set(['ARLO', 'HDR', 'WIFI', 'NVR', 'CCTV', 'USB', 'HTTPS']);

function textIssues(text: string, path: string, kind: 'headline' | 'description' | 'path'): LintIssue[] {
  const issues: LintIssue[] = [];
  const max = kind === 'headline' ? HEADLINE_MAX : kind === 'description' ? DESCRIPTION_MAX : PATH_MAX;
  const width = adTextWidth(text);
  if (!text.trim()) issues.push({ severity: 'error', code: 'EMPTY', path, message: '內容是空的' });
  if (width > max) issues.push({ severity: 'error', code: 'TOO_LONG', path, message: `長度 ${width} 超過 ${max}（全形字計 2）` });
  if (kind === 'headline' && /[!！]/.test(text)) issues.push({ severity: 'error', code: 'EXCLAMATION_IN_HEADLINE', path, message: '標題不可使用驚嘆號' });
  if (kind === 'description' && (text.match(/[!！]/g)?.length ?? 0) > 1) issues.push({ severity: 'error', code: 'TOO_MANY_EXCLAMATIONS', path, message: '說明最多一個驚嘆號' });
  if (REPEATED_PUNCT.test(text)) issues.push({ severity: 'error', code: 'REPEATED_PUNCTUATION', path, message: '不可重複標點' });
  if (SYMBOLS.test(text)) issues.push({ severity: 'error', code: 'SYMBOLS', path, message: '不可使用裝飾符號或 emoji' });
  if (PHONE.test(text)) issues.push({ severity: 'error', code: 'PHONE_NUMBER', path, message: '電話號碼請用通話額外資訊，不要寫在廣告文字' });
  const caps = text.match(ALL_CAPS_WORD)?.[0];
  if (caps && !CAPS_OK.has(caps)) issues.push({ severity: 'warning', code: 'ALL_CAPS', path, message: `避免全大寫「${caps}」` });
  if (SUPERLATIVES.test(text)) issues.push({ severity: 'warning', code: 'UNSUPPORTED_CLAIM', path, message: '最高級或保證用語需要到達網頁上的佐證' });
  return issues;
}

function duplicates(texts: readonly string[], path: (i: number) => string, what: string): LintIssue[] {
  const seen = new Map<string, number>();
  const out: LintIssue[] = [];
  texts.forEach((t, i) => {
    const key = norm(t);
    if (!key) return;
    if (seen.has(key)) out.push({ severity: 'error', code: 'DUPLICATE', path: path(i), message: `與第 ${seen.get(key)! + 1} 個${what}重複` });
    else seen.set(key, i);
  });
  return out;
}

export function lintRsa(ad: Rsa, base = 'ad'): LintIssue[] {
  const issues: LintIssue[] = [];
  if (ad.headlines.length < 3 || ad.headlines.length > 15) issues.push({ severity: 'error', code: 'HEADLINE_COUNT', path: `${base}.headlines`, message: `標題需 3–15 個，目前 ${ad.headlines.length}` });
  else if (ad.headlines.length < 8) issues.push({ severity: 'warning', code: 'FEW_HEADLINES', path: `${base}.headlines`, message: '建議至少 8 個標題以提高廣告效力' });
  if (ad.descriptions.length < 2 || ad.descriptions.length > 4) issues.push({ severity: 'error', code: 'DESCRIPTION_COUNT', path: `${base}.descriptions`, message: `說明需 2–4 個，目前 ${ad.descriptions.length}` });
  ad.headlines.forEach((h, i) => issues.push(...textIssues(h, `${base}.headlines[${i}]`, 'headline')));
  ad.descriptions.forEach((d, i) => issues.push(...textIssues(d, `${base}.descriptions[${i}]`, 'description')));
  issues.push(...duplicates(ad.headlines, (i) => `${base}.headlines[${i}]`, '標題'));
  issues.push(...duplicates(ad.descriptions, (i) => `${base}.descriptions[${i}]`, '說明'));
  for (const [key, value] of [['path1', ad.path1], ['path2', ad.path2]] as const) {
    if (value) issues.push(...textIssues(value, `${base}.${key}`, 'path').filter((x) => x.code !== 'EXCLAMATION_IN_HEADLINE'));
  }
  if (ad.path2 && !ad.path1) issues.push({ severity: 'error', code: 'PATH2_WITHOUT_PATH1', path: `${base}.path2`, message: '有 path2 時必須有 path1' });
  if (!/^https:\/\//.test(ad.finalUrl)) issues.push({ severity: 'error', code: 'FINAL_URL', path: `${base}.finalUrl`, message: '最終網址需為 https' });
  return issues;
}

/** Hostname without www (core has no URL global: parsed by pattern). */
const host = (url: string) => /^https?:\/\/(?:[^@/?#]*@)?([^/:?#]+)/i.exec(url.trim())?.[1]?.toLowerCase().replace(/^www\./, '') ?? null;

/** Whole-draft checks; `landingPageUrl` (from the brief) pins the allowed domain. */
export function lintStructure(draft: CampaignDraft, opts: { landingPageUrl?: string } = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const c = draft.campaign;
  if (!(c.dailyBudget > 0)) issues.push({ severity: 'error', code: 'BUDGET', path: 'campaign.dailyBudget', message: '每日預算需大於 0' });
  if (c.biddingStrategy === 'TARGET_CPA' && !c.targetCpa) issues.push({ severity: 'error', code: 'TARGET_CPA_MISSING', path: 'campaign.targetCpa', message: 'TARGET_CPA 需要目標 CPA' });
  if (c.biddingStrategy !== 'TARGET_CPA' && c.targetCpa) issues.push({ severity: 'warning', code: 'TARGET_CPA_UNUSED', path: 'campaign.targetCpa', message: `${c.biddingStrategy} 不使用目標 CPA` });
  if (draft.adGroups.length === 0) issues.push({ severity: 'error', code: 'NO_AD_GROUPS', path: 'adGroups', message: '至少需要一個廣告群組' });
  issues.push(...duplicates(draft.adGroups.map((g) => g.name), (i) => `adGroups[${i}].name`, '廣告群組名稱'));

  const domain = opts.landingPageUrl ? host(opts.landingPageUrl) : null;
  const keywordOwner = new Map<string, number>();
  draft.adGroups.forEach((g, gi) => {
    const base = `adGroups[${gi}]`;
    if (g.keywords.length === 0) issues.push({ severity: 'error', code: 'NO_KEYWORDS', path: `${base}.keywords`, message: '廣告群組沒有關鍵字' });
    if (g.keywords.length > 20) issues.push({ severity: 'warning', code: 'TOO_MANY_KEYWORDS', path: `${base}.keywords`, message: '關鍵字超過 20 個，建議拆分主題' });
    if (g.ads.length === 0) issues.push({ severity: 'error', code: 'NO_ADS', path: `${base}.ads`, message: '廣告群組沒有廣告' });
    g.keywords.forEach((k, ki) => {
      const path = `${base}.keywords[${ki}]`;
      if (k.text.length > 80 || k.text.trim().split(/\s+/).length > 10) issues.push({ severity: 'error', code: 'KEYWORD_TOO_LONG', path, message: '關鍵字最多 80 字元、10 個字' });
      if (/[!@%^*=<>;,]/.test(k.text)) issues.push({ severity: 'error', code: 'KEYWORD_CHARS', path, message: '關鍵字含不允許的符號' });
      const key = `${norm(k.text)}|${k.matchType}`;
      if (keywordOwner.has(key)) issues.push({ severity: 'warning', code: 'DUPLICATE_KEYWORD', path, message: `與廣告群組 ${keywordOwner.get(key)! + 1} 重複，會互相競爭` });
      else keywordOwner.set(key, gi);
    });
    g.ads.forEach((ad, ai) => {
      issues.push(...lintRsa(ad, `${base}.ads[${ai}]`));
      const adHost = host(ad.finalUrl);
      if (domain && adHost && adHost !== domain && !adHost.endsWith(`.${domain}`)) issues.push({ severity: 'error', code: 'DOMAIN_MISMATCH', path: `${base}.ads[${ai}].finalUrl`, message: `網址網域需為 ${domain}` });
    });
  });

  const positives = new Set(draft.adGroups.flatMap((g) => g.keywords.map((k) => norm(k.text))));
  draft.negativeKeywords.forEach((n, i) => {
    const t = norm(n.text);
    const blocks = n.matchType === 'EXACT' ? positives.has(t) : [...positives].some((p) => (n.matchType === 'PHRASE' ? p.includes(t) : t.split(' ').every((w) => p.split(' ').includes(w))));
    if (blocks) issues.push({ severity: 'error', code: 'NEGATIVE_BLOCKS_KEYWORD', path: `negativeKeywords[${i}]`, message: `否定關鍵字「${n.text}」會擋掉自己的關鍵字` });
  });
  issues.push(...duplicates(draft.negativeKeywords.map((n) => `${n.text}|${n.matchType}`), (i) => `negativeKeywords[${i}]`, '否定關鍵字'));
  return issues;
}

export const hasLintErrors = (issues: readonly LintIssue[]) => issues.some((i) => i.severity === 'error');
