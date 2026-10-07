// Partial regeneration (ADR-0020, Requirement 15.4): only the requested section of a regenerated
// draft is taken; everything else stays as the person left it. Pure.
import type { CampaignDraft, DraftSection } from './draft';

const byName = <T extends { name: string }>(groups: readonly T[]) => new Map(groups.map((g) => [g.name.trim().toLowerCase(), g]));

export function mergeDraftSection(current: CampaignDraft, generated: CampaignDraft, section: DraftSection): CampaignDraft {
  switch (section) {
    case 'structure':
      // A new ad group layout brings its own keywords and ads.
      return { ...current, adGroups: generated.adGroups, rationale: generated.rationale };
    case 'keywords': {
      const gen = byName(generated.adGroups);
      return { ...current, adGroups: current.adGroups.map((g) => ({ ...g, keywords: gen.get(g.name.trim().toLowerCase())?.keywords ?? g.keywords })) };
    }
    case 'ads': {
      const gen = byName(generated.adGroups);
      return { ...current, adGroups: current.adGroups.map((g) => ({ ...g, ads: gen.get(g.name.trim().toLowerCase())?.ads ?? g.ads })) };
    }
    case 'negatives':
      return { ...current, negativeKeywords: generated.negativeKeywords };
    case 'budget':
      return {
        ...current,
        campaign: { ...current.campaign, dailyBudget: generated.campaign.dailyBudget, biddingStrategy: generated.campaign.biddingStrategy, targetCpa: generated.campaign.targetCpa },
      };
  }
}

export const SECTION_LABEL: Record<DraftSection, string> = {
  structure: '廣告群組結構（含關鍵字與廣告）',
  keywords: '關鍵字',
  ads: '廣告文字',
  negatives: '否定關鍵字',
  budget: '預算與出價',
};
