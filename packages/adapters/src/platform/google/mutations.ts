// Builds one google-ads-api mutate operation per ChangeSet op (ADR-0004). Pure; the adapter
// supplies the campaign write context (budget resource, sharing, bid strategy) it looked up.
import type { CampaignBundle, Op } from '@arlo/core';
import { enums, type MutateOperation } from 'google-ads-api';
import { enumName, type Row } from './mappers';

export type Mutation = MutateOperation<Record<string, unknown>>;

/** What set_budget / set_bid_target need to know about a campaign before writing. */
export interface CampaignWriteContext {
  budgetResourceName: string | null;
  budgetShared: boolean;
  bidStrategy: string | null;
  /** Set when the campaign uses a portfolio strategy, which other campaigns share. */
  portfolioStrategy: string | null;
}

export class OpRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'OpRejectedError';
  }
}

const ID = /^\d+$/;
const KEYWORD_ID = /^\d+~\d+$/;
const MATCH_TYPES = new Set(['EXACT', 'PHRASE', 'BROAD']);

function checkId(id: string, pattern = ID): string {
  if (!pattern.test(id)) throw new OpRejectedError('INVALID_ID', `invalid Google Ads id: ${id}`);
  return id;
}

const STATUS = {
  campaign: enums.CampaignStatus,
  ad_group: enums.AdGroupStatus,
  keyword: enums.AdGroupCriterionStatus,
} as const;

// Which campaign field holds the target for each strategy (ADR-0009 compares the same fields).
const BID_TARGET_PATH: Record<string, { field: 'target_cpa_micros' | 'target_roas'; path: [string, string] }> = {
  TARGET_CPA: { field: 'target_cpa_micros', path: ['target_cpa', 'target_cpa_micros'] },
  MAXIMIZE_CONVERSIONS: { field: 'target_cpa_micros', path: ['maximize_conversions', 'target_cpa_micros'] },
  TARGET_ROAS: { field: 'target_roas', path: ['target_roas', 'target_roas'] },
  MAXIMIZE_CONVERSION_VALUE: { field: 'target_roas', path: ['maximize_conversion_value', 'target_roas'] },
};

/** Campaign ids whose write context must be looked up before building `ops`. */
export function campaignsNeedingContext(ops: readonly Op[]): string[] {
  return [...new Set(ops.filter((op) => op.kind === 'set_budget' || op.kind === 'set_bid_target').map((op) => op.target.id))];
}

export function mapCampaignWriteContext(rows: Row[]): Map<string, CampaignWriteContext> {
  const out = new Map<string, CampaignWriteContext>();
  for (const r of rows) {
    out.set(String(r.campaign?.id), {
      budgetResourceName: r.campaign?.campaign_budget ?? null,
      budgetShared: Boolean(r.campaign_budget?.explicitly_shared),
      bidStrategy: enumName(enums.BiddingStrategyType, r.campaign?.bidding_strategy_type),
      portfolioStrategy: r.campaign?.bidding_strategy || null,
    });
  }
  return out;
}

function keyword(after: unknown): { text: string; match_type: number } {
  const { text, matchType } = (after ?? {}) as { text?: unknown; matchType?: unknown };
  if (typeof text !== 'string' || !text.trim()) throw new OpRejectedError('INVALID_OP', 'keyword text is required');
  if (typeof matchType !== 'string' || !MATCH_TYPES.has(matchType)) throw new OpRejectedError('INVALID_OP', `invalid match type: ${String(matchType)}`);
  return { text: text.trim(), match_type: enums.KeywordMatchType[matchType as 'EXACT'] };
}

function positiveNumber(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new OpRejectedError('INVALID_OP', `${what} must be a positive number`);
  return n;
}

/**
 * The mutate operation for `op` in `customerId`. Throws OpRejectedError for ops this adapter
 * refuses: shared budgets and portfolio strategies (they move other campaigns), unsupported kinds.
 */
export function buildMutation(
  customerId: string,
  op: Op,
  campaigns: ReadonlyMap<string, CampaignWriteContext>,
  /** Existing audience criteria, `${campaignId}:${userListId}` → resource name. */
  audiences: ReadonlyMap<string, string> = new Map(),
): Mutation {
  const c = `customers/${checkId(customerId)}`;
  const { kind, target } = op;

  switch (kind) {
    case 'set_status': {
      if (op.after !== 'ENABLED' && op.after !== 'PAUSED') throw new OpRejectedError('INVALID_OP', `invalid status: ${String(op.after)}`);
      const status = op.after;
      if (target.kind === 'campaign') {
        return { entity: 'campaign', operation: 'update', resource: { resource_name: `${c}/campaigns/${checkId(target.id)}`, status: STATUS.campaign[status] } };
      }
      if (target.kind === 'ad_group') {
        return { entity: 'ad_group', operation: 'update', resource: { resource_name: `${c}/adGroups/${checkId(target.id)}`, status: STATUS.ad_group[status] } };
      }
      if (target.kind === 'keyword') {
        return {
          entity: 'ad_group_criterion',
          operation: 'update',
          resource: { resource_name: `${c}/adGroupCriteria/${checkId(target.id, KEYWORD_ID)}`, status: STATUS.keyword[status] },
        };
      }
      throw new OpRejectedError('UNSUPPORTED_OP', `set_status on ${target.kind}`);
    }

    case 'set_budget': {
      if (target.kind !== 'campaign') throw new OpRejectedError('UNSUPPORTED_OP', `set_budget on ${target.kind}`);
      const ctx = campaigns.get(checkId(target.id));
      if (!ctx?.budgetResourceName) throw new OpRejectedError('RESOURCE_NOT_FOUND', `campaign ${target.id} has no budget`);
      if (ctx.budgetShared) throw new OpRejectedError('SHARED_BUDGET', `campaign ${target.id} uses a shared budget`);
      return {
        entity: 'campaign_budget',
        operation: 'update',
        resource: { resource_name: ctx.budgetResourceName, amount_micros: Math.round(positiveNumber(op.after, 'budget')) },
      };
    }

    case 'set_bid_target': {
      if (target.kind !== 'campaign') throw new OpRejectedError('UNSUPPORTED_OP', `set_bid_target on ${target.kind}`);
      const ctx = campaigns.get(checkId(target.id));
      if (!ctx) throw new OpRejectedError('RESOURCE_NOT_FOUND', `campaign ${target.id} not found`);
      if (ctx.portfolioStrategy) throw new OpRejectedError('PORTFOLIO_STRATEGY', `campaign ${target.id} uses a portfolio bid strategy`);
      const spec = ctx.bidStrategy ? BID_TARGET_PATH[ctx.bidStrategy] : undefined;
      if (!spec) throw new OpRejectedError('UNSUPPORTED_BID_STRATEGY', `bid strategy ${ctx.bidStrategy ?? 'unknown'} has no target`);
      if (op.field && op.field !== spec.field) {
        throw new OpRejectedError('BID_STRATEGY_MISMATCH', `${op.field} does not apply to ${ctx.bidStrategy}`);
      }
      const raw = positiveNumber(op.after, spec.field);
      const value = spec.field === 'target_cpa_micros' ? Math.round(raw) : raw;
      const [group, field] = spec.path;
      return { entity: 'campaign', operation: 'update', resource: { resource_name: `${c}/campaigns/${target.id}`, [group]: { [field]: value } } };
    }

    case 'google.add_negative_keyword': {
      if (target.kind === 'shared_set') {
        return {
          entity: 'shared_criterion',
          operation: 'create',
          resource: { shared_set: `${c}/sharedSets/${checkId(target.id)}`, keyword: keyword(op.after) },
        };
      }
      if (target.kind === 'campaign') {
        return {
          entity: 'campaign_criterion',
          operation: 'create',
          resource: { campaign: `${c}/campaigns/${checkId(target.id)}`, negative: true, keyword: keyword(op.after) },
        };
      }
      throw new OpRejectedError('UNSUPPORTED_OP', `add_negative_keyword on ${target.kind}`);
    }

    case 'google.add_keyword': {
      if (target.kind !== 'ad_group') throw new OpRejectedError('UNSUPPORTED_OP', `add_keyword on ${target.kind}`);
      const { cpcBidMicros } = (op.after ?? {}) as { cpcBidMicros?: unknown };
      return {
        entity: 'ad_group_criterion',
        operation: 'create',
        resource: {
          ad_group: `${c}/adGroups/${checkId(target.id)}`,
          status: enums.AdGroupCriterionStatus.ENABLED,
          keyword: keyword(op.after),
          ...(cpcBidMicros === undefined || cpcBidMicros === null ? {} : { cpc_bid_micros: Math.round(positiveNumber(cpcBidMicros, 'cpcBidMicros')) }),
        },
      };
    }

    case 'google.set_audience_bid_modifier':
    case 'google.exclude_audience': {
      if (target.kind !== 'campaign') throw new OpRejectedError('UNSUPPORTED_OP', `${kind} on ${target.kind}`);
      const { userListId, bidModifier } = (op.after ?? {}) as { userListId?: unknown; bidModifier?: unknown };
      const list = `${c}/userLists/${checkId(String(userListId ?? ''))}`;
      const campaign = `${c}/campaigns/${checkId(target.id)}`;
      if (kind === 'google.exclude_audience') {
        return { entity: 'campaign_criterion', operation: 'create', resource: { campaign, negative: true, user_list: { user_list: list } } };
      }
      const modifier = Number(bidModifier);
      if (!Number.isFinite(modifier) || modifier < 0.1 || modifier > 10) throw new OpRejectedError('INVALID_OP', 'bidModifier must be between 0.1 and 10');
      const existing = audiences.get(`${target.id}:${String(userListId)}`);
      return existing
        ? { entity: 'campaign_criterion', operation: 'update', resource: { resource_name: existing, bid_modifier: modifier } }
        : { entity: 'campaign_criterion', operation: 'create', resource: { campaign, user_list: { user_list: list }, bid_modifier: modifier } };
    }

    case 'google.create_campaign_bundle':
      throw new OpRejectedError('INVALID_OP', 'campaign bundles are built with buildBundleMutations');

    default:
      throw new OpRejectedError('UNSUPPORTED_OP', `${kind} is not supported by GoogleAdsAdapter yet`);
  }
}

/** The resource name in a mutate response entry, e.g. `campaign_budget_result.resource_name`. */
export function resultResourceName(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') return undefined;
  for (const value of Object.values(response as Record<string, unknown>)) {
    const name = (value as { resource_name?: unknown } | null)?.resource_name;
    if (typeof name === 'string' && name) return name;
  }
  return undefined;
}

/** A short error string from a GoogleAdsFailure (or any error), without request details. */
export function mutateErrorMessage(err: unknown): string {
  if (err instanceof OpRejectedError) return err.message;
  const errors = (err as { errors?: { error_code?: Record<string, unknown>; message?: string }[] } | null)?.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors
      .map((e) => {
        const [code, value] = Object.entries(e.error_code ?? {})[0] ?? [];
        const label = code ? `${code}${typeof value === 'string' ? `.${value}` : ''}` : 'ERROR';
        return e.message ? `${label}: ${e.message}` : label;
      })
      .join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

const MATCH = (m: string) => {
  if (!MATCH_TYPES.has(m)) throw new OpRejectedError('INVALID_OP', `invalid match type: ${m}`);
  return enums.KeywordMatchType[m as 'EXACT'];
};

/**
 * One atomic mutate that creates a Search campaign bundle PAUSED (ADR-0020, Requirement 15.5):
 * budget, campaign, location / language / negative criteria, ad groups, keywords and RSAs, linked
 * by temporary (negative) resource ids. Index 1 is the campaign, whose result names it.
 */
export function buildBundleMutations(customerId: string, bundle: CampaignBundle, opts: { suffix: string }): Mutation[] {
  const c = `customers/${checkId(customerId)}`;
  if (bundle.status !== 'PAUSED') throw new OpRejectedError('INVALID_OP', 'campaign bundles are created paused');
  let tmp = 0;
  const next = (collection: string) => `${c}/${collection}/${--tmp}`;
  const budget = next('campaignBudgets');
  const campaign = next('campaigns');
  const bidding =
    bundle.biddingStrategy === 'MAXIMIZE_CLICKS'
      ? { target_spend: {} }
      : { maximize_conversions: bundle.biddingStrategy === 'TARGET_CPA' && bundle.targetCpaMicros ? { target_cpa_micros: bundle.targetCpaMicros } : {} };
  const out: Mutation[] = [
    {
      entity: 'campaign_budget',
      operation: 'create',
      resource: { resource_name: budget, name: `${bundle.name} 預算 ${opts.suffix}`, amount_micros: positiveNumber(bundle.budgetMicros, 'budget'), delivery_method: enums.BudgetDeliveryMethod.STANDARD, explicitly_shared: false },
    },
    {
      entity: 'campaign',
      operation: 'create',
      resource: {
        resource_name: campaign,
        name: bundle.name,
        status: enums.CampaignStatus.PAUSED,
        advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
        campaign_budget: budget,
        network_settings: { target_google_search: true, target_search_network: true, target_content_network: false, target_partner_search_network: false },
        contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
        ...bidding,
      },
    },
    ...bundle.geoTargetIds.map((id): Mutation => ({ entity: 'campaign_criterion', operation: 'create', resource: { campaign, location: { geo_target_constant: `geoTargetConstants/${checkId(String(id))}` } } })),
    ...bundle.languageIds.map((id): Mutation => ({ entity: 'campaign_criterion', operation: 'create', resource: { campaign, language: { language_constant: `languageConstants/${checkId(String(id))}` } } })),
    ...bundle.negativeKeywords.map((k): Mutation => ({ entity: 'campaign_criterion', operation: 'create', resource: { campaign, negative: true, keyword: keyword(k) } })),
  ];
  for (const group of bundle.adGroups) {
    const adGroup = next('adGroups');
    out.push({ entity: 'ad_group', operation: 'create', resource: { resource_name: adGroup, campaign, name: group.name, status: enums.AdGroupStatus.ENABLED, type: enums.AdGroupType.SEARCH_STANDARD } });
    for (const k of group.keywords) {
      out.push({ entity: 'ad_group_criterion', operation: 'create', resource: { ad_group: adGroup, status: enums.AdGroupCriterionStatus.ENABLED, keyword: { text: k.text.trim(), match_type: MATCH(k.matchType) } } });
    }
    for (const ad of group.ads) {
      out.push({
        entity: 'ad_group_ad',
        operation: 'create',
        resource: {
          ad_group: adGroup,
          status: enums.AdGroupAdStatus.ENABLED,
          ad: {
            final_urls: [ad.finalUrl],
            responsive_search_ad: {
              headlines: ad.headlines.map((text) => ({ text })),
              descriptions: ad.descriptions.map((text) => ({ text })),
              ...(ad.path1 ? { path1: ad.path1 } : {}),
              ...(ad.path2 ? { path2: ad.path2 } : {}),
            },
          },
        },
      });
    }
  }
  return out;
}

/** Campaigns whose existing audience criteria a bid-modifier op needs (update in place vs create). */
export function audienceCampaignIds(ops: readonly Op[]): string[] {
  const ids = ops.filter((op) => op.kind === 'google.set_audience_bid_modifier' && op.target.kind === 'campaign').map((op) => op.target.id);
  return [...new Set(ids)].filter((id) => ID.test(id));
}

/** `${campaignId}:${userListId}` → campaign criterion resource name. */
export function mapAudienceCriteria(rows: Row[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const list = r.campaign_criterion?.user_list?.user_list ?? '';
    const name = r.campaign_criterion?.resource_name;
    if (name && list) out.set(`${String(r.campaign?.id)}:${list.split('/').at(-1)}`, name);
  }
  return out;
}
