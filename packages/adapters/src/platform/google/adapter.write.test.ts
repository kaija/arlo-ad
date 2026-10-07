import { WriteNotAllowedError } from '@arlo/config';
import type { CampaignBundle, EntityKind, Op } from '@arlo/core';
import { enums } from 'google-ads-api';
import { describe, expect, it } from 'vitest';
import { GoogleAdsAdapter } from './adapter';
import type { GoogleAdsClient } from './client';
import { mapAdPolicies, type Row } from './mappers';
import { buildBundleMutations, buildMutation, mutateErrorMessage, OpRejectedError, resultResourceName, type CampaignWriteContext } from './mutations';

const ACC = '1234567890';
const ref = (kind: EntityKind, id: string, accountId = ACC) => ({ platform: 'google_ads' as const, accountId, kind, id });
const op = (o: Omit<Op, 'before'> & { before?: unknown }): Op => ({ before: null, ...o });

const ctx = (over: Partial<CampaignWriteContext> = {}): CampaignWriteContext => ({
  budgetResourceName: `customers/${ACC}/campaignBudgets/900`,
  budgetShared: false,
  bidStrategy: 'TARGET_CPA',
  portfolioStrategy: null,
  ...over,
});

describe('buildMutation', () => {
  const campaigns = new Map([
    ['111', ctx()],
    ['112', ctx({ budgetShared: true, bidStrategy: 'MAXIMIZE_CONVERSION_VALUE' })],
    ['113', ctx({ bidStrategy: 'TARGET_ROAS', portfolioStrategy: `customers/${ACC}/biddingStrategies/5` })],
    ['114', ctx({ bidStrategy: 'MANUAL_CPC' })],
  ]);
  const build = (o: Op) => buildMutation(ACC, o, campaigns);

  it.each([
    ['campaign', '111', 'campaign', `customers/${ACC}/campaigns/111`, enums.CampaignStatus.PAUSED],
    ['ad_group', '221', 'ad_group', `customers/${ACC}/adGroups/221`, enums.AdGroupStatus.PAUSED],
    ['keyword', '221~3001', 'ad_group_criterion', `customers/${ACC}/adGroupCriteria/221~3001`, enums.AdGroupCriterionStatus.PAUSED],
  ] as const)('set_status on %s', (kind, id, entity, resourceName, status) => {
    expect(build(op({ kind: 'set_status', target: ref(kind, id), field: 'status', after: 'PAUSED' }))).toEqual({
      entity,
      operation: 'update',
      resource: { resource_name: resourceName, status },
    });
  });

  it('set_budget updates the campaign budget resource', () => {
    expect(build(op({ kind: 'set_budget', target: ref('campaign', '111'), field: 'budget_micros', after: 1_500_000_000.4 }))).toEqual({
      entity: 'campaign_budget',
      operation: 'update',
      resource: { resource_name: `customers/${ACC}/campaignBudgets/900`, amount_micros: 1_500_000_000 },
    });
  });

  it('refuses set_budget on a shared budget', () => {
    expect(() => build(op({ kind: 'set_budget', target: ref('campaign', '112'), after: 1_000_000 }))).toThrow(/^SHARED_BUDGET/);
  });

  it('writes the bid target into the strategy-specific field', () => {
    expect(build(op({ kind: 'set_bid_target', target: ref('campaign', '111'), field: 'target_cpa_micros', after: 200_000_000 }))).toMatchObject({
      resource: { resource_name: `customers/${ACC}/campaigns/111`, target_cpa: { target_cpa_micros: 200_000_000 } },
    });
    expect(build(op({ kind: 'set_bid_target', target: ref('campaign', '112'), field: 'target_roas', after: 4.5 }))).toMatchObject({
      resource: { maximize_conversion_value: { target_roas: 4.5 } },
    });
  });

  it.each([
    ['portfolio strategies', '113', 'target_roas', 'PORTFOLIO_STRATEGY'],
    ['strategies without a target', '114', 'target_cpa_micros', 'UNSUPPORTED_BID_STRATEGY'],
    ['a field that does not match the strategy', '111', 'target_roas', 'BID_STRATEGY_MISMATCH'],
    ['unknown campaigns', '999', 'target_cpa_micros', 'RESOURCE_NOT_FOUND'],
  ] as const)('refuses set_bid_target on %s', (_, id, field, code) => {
    expect(() => build(op({ kind: 'set_bid_target', target: ref('campaign', id), field, after: 3 }))).toThrow(new RegExp(`^${code}`));
  });

  it('adds negative keywords to a shared set or a campaign', () => {
    const after = { text: ' free ', matchType: 'PHRASE' };
    expect(build(op({ kind: 'google.add_negative_keyword', target: ref('shared_set', '77'), after }))).toEqual({
      entity: 'shared_criterion',
      operation: 'create',
      resource: { shared_set: `customers/${ACC}/sharedSets/77`, keyword: { text: 'free', match_type: enums.KeywordMatchType.PHRASE } },
    });
    expect(build(op({ kind: 'google.add_negative_keyword', target: ref('campaign', '111'), after }))).toMatchObject({
      entity: 'campaign_criterion',
      resource: { campaign: `customers/${ACC}/campaigns/111`, negative: true },
    });
  });

  it('adds keywords to an ad group with an optional bid', () => {
    expect(build(op({ kind: 'google.add_keyword', target: ref('ad_group', '221'), after: { text: 'shoes', matchType: 'EXACT', cpcBidMicros: 1_200_000 } }))).toEqual({
      entity: 'ad_group_criterion',
      operation: 'create',
      resource: {
        ad_group: `customers/${ACC}/adGroups/221`,
        status: enums.AdGroupCriterionStatus.ENABLED,
        keyword: { text: 'shoes', match_type: enums.KeywordMatchType.EXACT },
        cpc_bid_micros: 1_200_000,
      },
    });
  });

  it('sets audience bid modifiers in place or on a new criterion, and excludes audiences', () => {
    const audiences = new Map([['111:501', `customers/${ACC}/campaignCriteria/111~9001`]]);
    const set = (userListId: string) => buildMutation(ACC, op({ kind: 'google.set_audience_bid_modifier', target: ref('campaign', '111'), after: { userListId, bidModifier: 1.25 } }), campaigns, audiences);
    expect(set('501')).toEqual({ entity: 'campaign_criterion', operation: 'update', resource: { resource_name: `customers/${ACC}/campaignCriteria/111~9001`, bid_modifier: 1.25 } });
    expect(set('502')).toEqual({
      entity: 'campaign_criterion',
      operation: 'create',
      resource: { campaign: `customers/${ACC}/campaigns/111`, user_list: { user_list: `customers/${ACC}/userLists/502` }, bid_modifier: 1.25 },
    });
    expect(build(op({ kind: 'google.exclude_audience', target: ref('campaign', '111'), after: { userListId: '501' } }))).toEqual({
      entity: 'campaign_criterion',
      operation: 'create',
      resource: { campaign: `customers/${ACC}/campaigns/111`, negative: true, user_list: { user_list: `customers/${ACC}/userLists/501` } },
    });
  });

  it.each<[string, Op, string]>([
    ['bad status', op({ kind: 'set_status', target: ref('campaign', '111'), after: 'REMOVED' }), 'INVALID_OP'],
    ['bad match type', op({ kind: 'google.add_keyword', target: ref('ad_group', '221'), after: { text: 'x', matchType: 'FUZZY' } }), 'INVALID_OP'],
    ['empty keyword', op({ kind: 'google.add_keyword', target: ref('ad_group', '221'), after: { text: ' ', matchType: 'EXACT' } }), 'INVALID_OP'],
    ['non-positive budget', op({ kind: 'set_budget', target: ref('campaign', '111'), after: 0 }), 'INVALID_OP'],
    ['injected id', op({ kind: 'set_status', target: ref('campaign', '1/../2'), after: 'PAUSED' }), 'INVALID_ID'],
    ['audience on an ad group', op({ kind: 'google.exclude_audience', target: ref('ad_group', '221'), after: { userListId: '1' } }), 'UNSUPPORTED_OP'],
    ['audience modifier out of range', op({ kind: 'google.set_audience_bid_modifier', target: ref('campaign', '111'), after: { userListId: '1', bidModifier: 12 } }), 'INVALID_OP'],
    ['audience without a user list', op({ kind: 'google.exclude_audience', target: ref('campaign', '111'), after: {} }), 'INVALID_ID'],
  ])('rejects %s', (_, o, code) => {
    expect(() => build(o)).toThrow(OpRejectedError);
    expect(() => build(o)).toThrow(new RegExp(`^${code}`));
  });
});

describe('mutate helpers', () => {
  it('reads the resource name from any *_result entry', () => {
    expect(resultResourceName({ campaign_budget_result: { resource_name: 'customers/1/campaignBudgets/2' } })).toBe('customers/1/campaignBudgets/2');
    expect(resultResourceName({})).toBeUndefined();
  });

  it('formats Google Ads failures by error code', () => {
    const failure = { errors: [{ error_code: { campaign_budget_error: 'NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT' }, message: 'Budget not a multiple' }] };
    expect(mutateErrorMessage(failure)).toBe('campaign_budget_error.NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT: Budget not a multiple');
    expect(mutateErrorMessage(new Error('boom'))).toBe('boom');
  });
});

describe('GoogleAdsAdapter.applyOps', () => {
  function writeClient(opts: { contextRows?: Row[]; failOn?: (entity: string) => unknown } = {}) {
    const mutations: { customerId: string; entity: string; resource: Record<string, unknown> }[] = [];
    const queries: string[] = [];
    const client: GoogleAdsClient = {
      customer: () => {
        throw new Error('not used');
      },
      keywordIdeas: async () => ({}),
      async query(_customerId, gaql) {
        queries.push(gaql);
        return opts.contextRows ?? [];
      },
      async mutate(customerId, operations) {
        const [m] = operations;
        const failure = opts.failOn?.(String(m!.entity));
        if (failure) throw failure;
        mutations.push({ customerId, entity: String(m!.entity), resource: m!.resource });
        return { mutate_operation_responses: [{ [`${String(m!.entity)}_result`]: { resource_name: `customers/${customerId}/${String(m!.entity)}/1` } }] };
      },
    };
    return { client, mutations, queries };
  }

  const contextRows: Row[] = [
    { campaign: { id: 111, campaign_budget: `customers/${ACC}/campaignBudgets/900`, bidding_strategy_type: enums.BiddingStrategyType.TARGET_CPA }, campaign_budget: { explicitly_shared: false } },
    { campaign: { id: 112, campaign_budget: `customers/${ACC}/campaignBudgets/901`, bidding_strategy_type: enums.BiddingStrategyType.MANUAL_CPC }, campaign_budget: { explicitly_shared: true } },
  ];

  it('refuses accounts that are not on the write allowlist before any request', async () => {
    const { client, mutations, queries } = writeClient({ contextRows });
    const adapter = new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: [] });
    await expect(adapter.applyOps(ACC, [op({ kind: 'set_budget', target: ref('campaign', '111'), after: 1_000_000 })])).rejects.toThrow(WriteNotAllowedError);
    expect(queries).toEqual([]);
    expect(mutations).toEqual([]);
  });

  it('applies ops in order and reports per-op results, refusing shared budgets', async () => {
    const { client, mutations, queries } = writeClient({ contextRows });
    const adapter = new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: ['123-456-7890'] });
    const results = await adapter.applyOps('123-456-7890', [
      op({ kind: 'set_budget', target: ref('campaign', '111'), field: 'budget_micros', after: 2_000_000_000 }),
      op({ kind: 'set_budget', target: ref('campaign', '112'), field: 'budget_micros', after: 2_000_000_000 }),
      op({ kind: 'set_status', target: ref('keyword', '221~3001'), field: 'status', after: 'PAUSED' }),
      op({ kind: 'set_status', target: ref('campaign', '111', '9999999999'), field: 'status', after: 'PAUSED' }),
    ]);
    expect(results).toEqual([
      { index: 0, ok: true, resourceName: `customers/${ACC}/campaign_budget/1` },
      { index: 1, ok: false, error: expect.stringMatching(/^SHARED_BUDGET/) },
      { index: 2, ok: true, resourceName: `customers/${ACC}/ad_group_criterion/1` },
      { index: 3, ok: false, error: expect.stringMatching(/^ACCOUNT_MISMATCH/) },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('campaign.id IN (111, 112)');
    expect(mutations.map((m) => m.entity)).toEqual(['campaign_budget', 'ad_group_criterion']);
  });

  it('records a platform failure on its op and keeps going', async () => {
    const { client } = writeClient({
      failOn: (entity) => (entity === 'shared_criterion' ? { errors: [{ error_code: { criterion_error: 'KEYWORD_HAS_INVALID_CHARS' }, message: 'bad' }] } : undefined),
    });
    const adapter = new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: [ACC] });
    const results = await adapter.applyOps(ACC, [
      op({ kind: 'google.add_negative_keyword', target: ref('shared_set', '77'), after: { text: '$$$', matchType: 'EXACT' } }),
      op({ kind: 'google.add_keyword', target: ref('ad_group', '221'), after: { text: 'shoes', matchType: 'EXACT' } }),
    ]);
    expect(results.map((r) => [r.ok, r.error])).toEqual([
      [false, 'criterion_error.KEYWORD_HAS_INVALID_CHARS: bad'],
      [true, undefined],
    ]);
  });

  it('looks up existing audience criteria before setting modifiers', async () => {
    const { client, mutations, queries } = writeClient({
      contextRows: [{ campaign: { id: 111 }, campaign_criterion: { resource_name: `customers/${ACC}/campaignCriteria/111~9001`, user_list: { user_list: `customers/${ACC}/userLists/501` } } }],
    });
    const adapter = new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: [ACC] });
    const results = await adapter.applyOps(ACC, [op({ kind: 'google.set_audience_bid_modifier', target: ref('campaign', '111'), after: { userListId: '501', bidModifier: 0.8 } })]);
    expect(results).toEqual([{ index: 0, ok: true, resourceName: `customers/${ACC}/campaign_criterion/1` }]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('FROM campaign_criterion');
    expect(mutations).toEqual([{ customerId: ACC, entity: 'campaign_criterion', resource: { resource_name: `customers/${ACC}/campaignCriteria/111~9001`, bid_modifier: 0.8 } }]);
  });

  it('fails every op when the campaign lookup fails', async () => {
    const { client, mutations } = writeClient();
    client.query = async () => {
      throw new Error('UNAVAILABLE');
    };
    const adapter = new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: [ACC] });
    const results = await adapter.applyOps(ACC, [op({ kind: 'set_budget', target: ref('campaign', '111'), after: 1_000_000 })]);
    expect(results).toEqual([{ index: 0, ok: false, error: 'CONTEXT_LOOKUP_FAILED: UNAVAILABLE' }]);
    expect(mutations).toEqual([]);
  });
});

describe('campaign bundle', () => {
  const bundle: CampaignBundle = {
    name: 'Pro 6',
    budgetMicros: 1_500_000_000,
    biddingStrategy: 'TARGET_CPA',
    targetCpaMicros: 300_000_000,
    geoTargetIds: [2158],
    languageIds: [1018],
    adGroups: [
      { name: '品牌', keywords: [{ text: 'arlo pro 6', matchType: 'PHRASE' }], ads: [{ headlines: ['a', 'b', 'c'], descriptions: ['d', 'e'], finalUrl: 'https://www.arlo.com/pro6', path1: 'cam', path2: null }] },
      { name: '通用', keywords: [{ text: '監視器', matchType: 'EXACT' }], ads: [] },
    ],
    negativeKeywords: [{ text: '免費', matchType: 'PHRASE' }],
    status: 'PAUSED',
  };

  it('builds one atomic mutate with temporary ids, paused', () => {
    const m = buildBundleMutations(ACC, bundle, { suffix: 's' });
    expect(m.map((x) => x.entity)).toEqual(['campaign_budget', 'campaign', 'campaign_criterion', 'campaign_criterion', 'campaign_criterion', 'ad_group', 'ad_group_criterion', 'ad_group_ad', 'ad_group', 'ad_group_criterion']);
    expect(m[1]!.resource).toMatchObject({
      resource_name: `customers/${ACC}/campaigns/-2`,
      campaign_budget: `customers/${ACC}/campaignBudgets/-1`,
      status: enums.CampaignStatus.PAUSED,
      maximize_conversions: { target_cpa_micros: 300_000_000 },
    });
    expect(m[2]!.resource).toEqual({ campaign: `customers/${ACC}/campaigns/-2`, location: { geo_target_constant: 'geoTargetConstants/2158' } });
    expect(m[4]!.resource).toMatchObject({ negative: true, keyword: { text: '免費' } });
    expect(m[7]!.resource).toMatchObject({ ad_group: `customers/${ACC}/adGroups/-3`, ad: { final_urls: ['https://www.arlo.com/pro6'], responsive_search_ad: { headlines: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], path1: 'cam' } } });
    expect(m[8]!.resource).toMatchObject({ resource_name: `customers/${ACC}/adGroups/-4` });
    expect(() => buildBundleMutations(ACC, { ...bundle, status: 'ENABLED' as never }, { suffix: 's' })).toThrow('paused');
  });

  it('applies the bundle as one request and returns the campaign resource', async () => {
    const calls: number[] = [];
    const client: GoogleAdsClient = {
      customer: () => {
        throw new Error('not used');
      },
      query: async () => [],
      keywordIdeas: async () => ({}),
      mutate: async (_c, ops) => {
        calls.push(ops.length);
        return { mutate_operation_responses: [{ campaign_budget_result: { resource_name: `customers/${ACC}/campaignBudgets/91` } }, { campaign_result: { resource_name: `customers/${ACC}/campaigns/92` } }] };
      },
    };
    const adapter = new GoogleAdsAdapter(client, { loginCustomerId: ACC, writeAllowedCustomerIds: [ACC] });
    const results = await adapter.applyOps(ACC, [{ kind: 'google.create_campaign_bundle', target: ref('account', ACC), before: null, after: bundle }]);
    expect(results).toEqual([{ index: 0, ok: true, resourceName: `customers/${ACC}/campaigns/92` }]);
    expect(calls).toEqual([10]);
  });

  it('maps ad policy rows', () => {
    expect(
      mapAdPolicies([{ campaign: { id: 92 }, ad_group: { id: 5 }, ad_group_ad: { ad: { id: 7 }, policy_summary: { approval_status: enums.PolicyApprovalStatus.APPROVED_LIMITED, review_status: enums.PolicyReviewStatus.REVIEWED, policy_topic_entries: [{ topic: 'TRADEMARKS_IN_AD_TEXT' }] } } }] as Row[]),
    ).toEqual([{ campaignExternalId: '92', adGroupExternalId: '5', adId: '7', approvalStatus: 'APPROVED_LIMITED', reviewStatus: 'REVIEWED', topics: ['TRADEMARKS_IN_AD_TEXT'] }]);
  });
});
