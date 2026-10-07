// Campaign brief and draft (ADR-0020, Requirements 15.1, 15.2). Search campaigns only in v1.
// Fields are nullable rather than optional so the draft schema works as OpenAI structured output.
import { z } from 'zod';

export const CAMPAIGN_TASK_STATUSES = ['queued', 'running', 'draft', 'submitted', 'failed'] as const;
export type CampaignTaskStatus = (typeof CAMPAIGN_TASK_STATUSES)[number];

export const CampaignBriefSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** What the campaign should achieve, e.g. "Q4 新品 Arlo Pro 6 預購". */
  objective: z.string().trim().min(1).max(1000),
  /** What is sold and why it is worth buying. */
  offering: z.string().trim().min(1).max(2000),
  landingPageUrl: z.url({ protocol: /^https$/ }),
  audience: z.string().trim().max(1000).nullable(),
  /** Location names or ids as the person wrote them, e.g. "台灣". */
  locations: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  languages: z.array(z.string().trim().min(1).max(20)).min(1).max(5),
  /** Daily budget in account currency units. */
  dailyBudget: z.number().positive().max(1_000_000),
  notes: z.string().trim().max(2000).nullable(),
});
export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;

export const MATCH_TYPES = ['EXACT', 'PHRASE', 'BROAD'] as const;
const Keyword = z.object({ text: z.string().min(1).max(80), matchType: z.enum(MATCH_TYPES) });

export const RsaSchema = z.object({
  headlines: z.array(z.string()).min(3).max(15),
  descriptions: z.array(z.string()).min(2).max(4),
  finalUrl: z.string(),
  path1: z.string().nullable(),
  path2: z.string().nullable(),
});
export type Rsa = z.infer<typeof RsaSchema>;

export const AdGroupDraftSchema = z.object({
  name: z.string().min(1).max(100),
  keywords: z.array(Keyword).min(1).max(50),
  ads: z.array(RsaSchema).min(1).max(3),
});
export type AdGroupDraft = z.infer<typeof AdGroupDraftSchema>;

export const BIDDING_STRATEGIES = ['MAXIMIZE_CONVERSIONS', 'TARGET_CPA', 'MAXIMIZE_CLICKS'] as const;

export const CampaignDraftSchema = z.object({
  campaign: z.object({
    name: z.string().min(1).max(100),
    /** Daily budget in account currency units. */
    dailyBudget: z.number().positive(),
    biddingStrategy: z.enum(BIDDING_STRATEGIES),
    /** Target CPA in currency units when biddingStrategy is TARGET_CPA. */
    targetCpa: z.number().positive().nullable(),
    locations: z.array(z.string()).min(1),
    languages: z.array(z.string()).min(1),
  }),
  adGroups: z.array(AdGroupDraftSchema).min(1).max(20),
  negativeKeywords: z.array(Keyword).max(200),
  /** Why the structure, keywords and budget look the way they do. */
  rationale: z.string().max(3000),
});
export type CampaignDraft = z.infer<typeof CampaignDraftSchema>;

/** Draft sections that can be regenerated on their own (Requirement 15.4). */
export const DRAFT_SECTIONS = ['structure', 'keywords', 'ads', 'negatives', 'budget'] as const;
export type DraftSection = (typeof DRAFT_SECTIONS)[number];
