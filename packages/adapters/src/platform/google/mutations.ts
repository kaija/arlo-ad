// Builds one google-ads-api mutate operation per ChangeSet op (ADR-0004). Pure; the adapter
// supplies the campaign write context (budget resource, sharing, bid strategy) it looked up.
import type { Op } from '@arlo/core';
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
export function buildMutation(customerId: string, op: Op, campaigns: ReadonlyMap<string, CampaignWriteContext>): Mutation {
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
