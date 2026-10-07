// Draft → google.create_campaign_bundle payload (ADR-0020, Requirement 15.5). Pure. The bundle is
// created PAUSED in one atomic mutate; enabling it is a separate ChangeSet (Requirement 15.6).
import type { CampaignDraft } from './draft';
import { hasLintErrors, lintStructure, type LintIssue } from './lint';

// Google Ads geo target and language constants for the names briefs use. Extend as needed.
const GEO: Record<string, number> = {
  台灣: 2158, 臺灣: 2158, taiwan: 2158, tw: 2158,
  香港: 2344, 'hong kong': 2344, hk: 2344,
  日本: 2392, japan: 2392, jp: 2392,
  新加坡: 2702, singapore: 2702, sg: 2702,
  美國: 2840, 'united states': 2840, usa: 2840, us: 2840,
  加拿大: 2124, canada: 2124, ca: 2124,
  英國: 2826, 'united kingdom': 2826, uk: 2826, gb: 2826,
  澳洲: 2036, australia: 2036, au: 2036,
  馬來西亞: 2458, malaysia: 2458, my: 2458,
};
const LANG: Record<string, number> = {
  'zh-tw': 1018, 繁體中文: 1018, 'zh-hant': 1018,
  'zh-cn': 1017, 簡體中文: 1017, 'zh-hans': 1017,
  en: 1000, english: 1000, 英文: 1000,
  ja: 1005, 日文: 1005,
  ko: 1012, 韓文: 1012,
};

export const geoTargetId = (name: string): number | null => GEO[name.trim().toLowerCase()] ?? null;
export const languageId = (code: string): number | null => LANG[code.trim().toLowerCase()] ?? null;

export interface CampaignBundle {
  name: string;
  budgetMicros: number;
  biddingStrategy: CampaignDraft['campaign']['biddingStrategy'];
  targetCpaMicros: number | null;
  geoTargetIds: number[];
  languageIds: number[];
  adGroups: CampaignDraft['adGroups'];
  negativeKeywords: CampaignDraft['negativeKeywords'];
  /** Always created paused; turning it on is its own ChangeSet. */
  status: 'PAUSED';
}

export type BundleResult = { ok: true; bundle: CampaignBundle } | { ok: false; issues: LintIssue[] };

/** Builds the bundle, refusing drafts with lint errors or targets Google ids are unknown for. */
export function draftToBundle(draft: CampaignDraft, opts: { landingPageUrl?: string } = {}): BundleResult {
  const issues = lintStructure(draft, opts).filter((i) => i.severity === 'error');
  const geo = draft.campaign.locations.map((l, i) => ({ id: geoTargetId(l), path: `campaign.locations[${i}]`, name: l }));
  const lang = draft.campaign.languages.map((l, i) => ({ id: languageId(l), path: `campaign.languages[${i}]`, name: l }));
  for (const g of geo) if (g.id === null) issues.push({ severity: 'error', code: 'UNKNOWN_LOCATION', path: g.path, message: `不支援的地區「${g.name}」` });
  for (const l of lang) if (l.id === null) issues.push({ severity: 'error', code: 'UNKNOWN_LANGUAGE', path: l.path, message: `不支援的語言「${l.name}」` });
  if (hasLintErrors(issues)) return { ok: false, issues };
  return {
    ok: true,
    bundle: {
      name: draft.campaign.name,
      budgetMicros: Math.round(draft.campaign.dailyBudget * 1_000_000 / 10_000) * 10_000,
      biddingStrategy: draft.campaign.biddingStrategy,
      targetCpaMicros: draft.campaign.biddingStrategy === 'TARGET_CPA' && draft.campaign.targetCpa ? Math.round(draft.campaign.targetCpa * 1_000_000 / 10_000) * 10_000 : null,
      geoTargetIds: [...new Set(geo.map((g) => g.id!))],
      languageIds: [...new Set(lang.map((l) => l.id!))],
      adGroups: draft.adGroups,
      negativeKeywords: draft.negativeKeywords,
      status: 'PAUSED',
    },
  };
}
