// Every GAQL query the adapter runs (ADR-0004). Inputs are validated before interpolation:
// GAQL has no bind parameters.
import { isIsoDate } from '@arlo/core';
import type { DateRange, MetricLevel } from '../types';

const ID = /^\d+$/;

function ids(values: readonly string[]): string {
  for (const v of values) if (!ID.test(v)) throw new Error(`invalid Google Ads id: ${v}`);
  return values.join(', ');
}

function during(range: DateRange): string {
  if (!isIsoDate(range.from) || !isIsoDate(range.to) || range.from > range.to) {
    throw new Error(`invalid date range: ${range.from}..${range.to}`);
  }
  return `segments.date BETWEEN '${range.from}' AND '${range.to}'`;
}

export const ACCESSIBLE_ACCOUNTS = `
  SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code,
         customer_client.time_zone, customer_client.manager, customer_client.status
  FROM customer_client
  WHERE customer_client.manager = false AND customer_client.status = 'ENABLED'`;

export const CUSTOMER = `
  SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status
  FROM customer`;

const CAMPAIGN_STATE_FIELDS = `
  campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
  campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas,
  campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas,
  campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared`;

export const CAMPAIGNS = `
  SELECT ${CAMPAIGN_STATE_FIELDS}
  FROM campaign
  WHERE campaign.status != 'REMOVED'`;

export const AD_GROUPS = `
  SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, campaign.id
  FROM ad_group
  WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`;

export const KEYWORDS = `
  SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
         ad_group_criterion.status, ad_group_criterion.negative, ad_group.id
  FROM keyword_view
  WHERE ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'`;

export const NEGATIVE_SHARED_SETS = `
  SELECT shared_set.id, shared_set.name, shared_set.type, shared_set.status, shared_set.member_count
  FROM shared_set
  WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'`;

export const CAMPAIGN_BUDGETS = `
  SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.status,
         campaign_budget.explicitly_shared, campaign_budget.delivery_method
  FROM campaign_budget
  WHERE campaign_budget.status != 'REMOVED'`;

const METRIC_FIELDS = `metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value`;

// Impression share is daily only (not segmentable by hour); budget-lost IS has no ad group / keyword view.
const SHARE_FIELDS: Record<MetricLevel, string> = {
  account: 'metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share',
  campaign: 'metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share',
  ad_group: 'metrics.search_impression_share, metrics.search_rank_lost_impression_share',
  keyword: 'metrics.search_impression_share, metrics.search_rank_lost_impression_share',
};

const LEVEL_SOURCE: Record<MetricLevel, { from: string; key: string }> = {
  account: { from: 'customer', key: 'customer.id' },
  campaign: { from: 'campaign', key: 'campaign.id' },
  ad_group: { from: 'ad_group', key: 'ad_group.id' },
  keyword: { from: 'keyword_view', key: 'ad_group.id, ad_group_criterion.criterion_id' },
};

export function metrics(level: MetricLevel, range: DateRange, hourly = false): string {
  const { from, key } = LEVEL_SOURCE[level];
  const fields = [key, 'segments.date', ...(hourly ? ['segments.hour'] : []), METRIC_FIELDS, ...(hourly ? [] : [SHARE_FIELDS[level]])];
  return `
  SELECT ${fields.join(', ')}
  FROM ${from}
  WHERE ${during(range)}`;
}

/** change_event needs both bounds and a LIMIT of at most 10000; times are in the account timezone. */
export function changeEvents(sinceLocal: string, untilLocal: string, limit = 10_000): string {
  const dt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (!dt.test(sinceLocal) || !dt.test(untilLocal)) throw new Error('invalid change_event bounds');
  return `
  SELECT change_event.resource_name, change_event.change_date_time, change_event.user_email,
         change_event.client_type, change_event.change_resource_type, change_event.change_resource_name,
         change_event.resource_change_operation, change_event.changed_fields,
         change_event.old_resource, change_event.new_resource
  FROM change_event
  WHERE change_event.change_date_time >= '${sinceLocal}' AND change_event.change_date_time <= '${untilLocal}'
  ORDER BY change_event.change_date_time
  LIMIT ${limit}`;
}

export function currentCampaigns(campaignIds: readonly string[]): string {
  return `
  SELECT ${CAMPAIGN_STATE_FIELDS}
  FROM campaign
  WHERE campaign.id IN (${ids(campaignIds)})`;
}

/** What applyOps needs to write budgets and bid targets (shared budget, portfolio strategy). */
export function campaignWriteContext(campaignIds: readonly string[]): string {
  return `
  SELECT campaign.id, campaign.campaign_budget, campaign.bidding_strategy, campaign.bidding_strategy_type,
         campaign_budget.explicitly_shared
  FROM campaign
  WHERE campaign.id IN (${ids(campaignIds)})`;
}

export function currentAdGroups(adGroupIds: readonly string[]): string {
  return `
  SELECT ad_group.id, ad_group.status
  FROM ad_group
  WHERE ad_group.id IN (${ids(adGroupIds)})`;
}

export function currentKeywords(adGroupIds: readonly string[], criterionIds: readonly string[]): string {
  return `
  SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.status
  FROM ad_group_criterion
  WHERE ad_group.id IN (${ids(adGroupIds)}) AND ad_group_criterion.criterion_id IN (${ids(criterionIds)})`;
}

export function searchTerms(range: DateRange): string {
  return `
  SELECT search_term_view.search_term, segments.date, campaign.id, ad_group.id, ${METRIC_FIELDS}
  FROM search_term_view
  WHERE ${during(range)}`;
}

export const CONVERSION_ACTIONS = `
  SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.category,
         conversion_action.primary_for_goal, conversion_action.type
  FROM conversion_action
  WHERE conversion_action.status != 'REMOVED'`;

/** Hours with conversions, per action, to find each action's last conversion. */
export function conversionActivity(range: DateRange): string {
  return `
  SELECT segments.conversion_action, segments.date, segments.hour, metrics.all_conversions
  FROM customer
  WHERE ${during(range)} AND metrics.all_conversions > 0`;
}

export const CONVERSION_UPLOAD_SUMMARIES = `
  SELECT offline_conversion_upload_conversion_action_summary.conversion_action_name,
         offline_conversion_upload_conversion_action_summary.status,
         offline_conversion_upload_conversion_action_summary.total_event_count,
         offline_conversion_upload_conversion_action_summary.successful_event_count,
         offline_conversion_upload_conversion_action_summary.pending_event_count,
         offline_conversion_upload_conversion_action_summary.alerts
  FROM offline_conversion_upload_conversion_action_summary`;

export function userListMetrics(range: DateRange): string {
  return `
  SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.user_list.user_list,
         campaign_criterion.bid_modifier, campaign.targeting_setting.target_restrictions,
         segments.date, ${METRIC_FIELDS}
  FROM campaign_audience_view
  WHERE ${during(range)} AND campaign_criterion.type = 'USER_LIST'`;
}

export const USER_LISTS = `
  SELECT user_list.id, user_list.name, user_list.resource_name
  FROM user_list`;

export function budgetSimulations(campaignIds: readonly string[]): string {
  return `
  SELECT campaign_simulation.campaign_id, campaign_simulation.type, campaign_simulation.budget_point_list.points
  FROM campaign_simulation
  WHERE campaign_simulation.type = 'BUDGET' AND campaign_simulation.campaign_id IN (${ids(campaignIds)})`;
}
