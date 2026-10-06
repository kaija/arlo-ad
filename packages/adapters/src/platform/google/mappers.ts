// Maps google-ads-api rows (snake_case, numeric enums, int64 as numbers) to adapter types.
// Pure; covered by fixture tests.
import { zonedToInstant } from '@arlo/core';
import { enums, type services } from 'google-ads-api';
import { currentFromRecord } from '../current';
import type {
  AccountInfo,
  AudienceRow,
  BudgetSimRow,
  ChangeEventRow,
  ConversionActionRow,
  EntityRecord,
  MetricLevel,
  MetricRow,
  SearchTermRow,
} from '../types';

export type Row = services.IGoogleAdsRow;
type EnumObject = Record<number | string, string | number>;

/** Enum label for a numeric (gRPC) or string (REST) enum value. */
export function enumName(e: EnumObject, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  const label = e[value as number];
  return typeof label === 'string' ? label : 'UNKNOWN';
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const positiveOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n !== null && n > 0 ? n : null;
};

export function mapAccessibleAccounts(rows: Row[]): AccountInfo[] {
  return rows.map((r) => ({
    externalId: str(r.customer_client?.id),
    name: str(r.customer_client?.descriptive_name),
    currency: str(r.customer_client?.currency_code),
    timezone: str(r.customer_client?.time_zone),
  }));
}

export function mapAccountEntity(row: Row): EntityRecord {
  return {
    kind: 'account',
    externalId: str(row.customer?.id),
    name: row.customer?.descriptive_name ?? null,
    status: enumName(enums.CustomerStatus, row.customer?.status),
    attrs: { currency: row.customer?.currency_code ?? null, timezone: row.customer?.time_zone ?? null },
  };
}

function campaignState(r: Row): NonNullable<EntityRecord['state']> {
  const c = r.campaign ?? {};
  const bidStrategy = enumName(enums.BiddingStrategyType, c.bidding_strategy_type);
  const bidTarget =
    positiveOrNull(c.target_cpa?.target_cpa_micros) ??
    positiveOrNull(c.maximize_conversions?.target_cpa_micros) ??
    positiveOrNull(c.target_roas?.target_roas) ??
    positiveOrNull(c.maximize_conversion_value?.target_roas);
  return { budgetMicros: numOrNull(r.campaign_budget?.amount_micros), bidStrategy, bidTarget };
}

export function mapCampaigns(rows: Row[]): EntityRecord[] {
  return rows.map((r) => ({
    kind: 'campaign',
    externalId: str(r.campaign?.id),
    name: r.campaign?.name ?? null,
    status: enumName(enums.CampaignStatus, r.campaign?.status),
    attrs: {
      channelType: enumName(enums.AdvertisingChannelType, r.campaign?.advertising_channel_type),
      budgetId: r.campaign_budget?.id ? str(r.campaign_budget.id) : null,
      // A shared budget moves every campaign on it; the Executor refuses set_budget on these.
      budgetShared: Boolean(r.campaign_budget?.explicitly_shared),
    },
    state: campaignState(r),
  }));
}

export function mapAdGroups(rows: Row[]): EntityRecord[] {
  return rows.map((r) => ({
    kind: 'ad_group',
    externalId: str(r.ad_group?.id),
    parent: { kind: 'campaign', externalId: str(r.campaign?.id) },
    name: r.ad_group?.name ?? null,
    status: enumName(enums.AdGroupStatus, r.ad_group?.status),
    attrs: { type: enumName(enums.AdGroupType, r.ad_group?.type) },
  }));
}

export const keywordId = (adGroupId: unknown, criterionId: unknown) => `${str(adGroupId)}~${str(criterionId)}`;

export function mapKeywords(rows: Row[]): EntityRecord[] {
  return rows.map((r) => ({
    kind: 'keyword',
    externalId: keywordId(r.ad_group?.id, r.ad_group_criterion?.criterion_id),
    parent: { kind: 'ad_group', externalId: str(r.ad_group?.id) },
    name: r.ad_group_criterion?.keyword?.text ?? null,
    status: enumName(enums.AdGroupCriterionStatus, r.ad_group_criterion?.status),
    attrs: {
      matchType: enumName(enums.KeywordMatchType, r.ad_group_criterion?.keyword?.match_type),
      negative: Boolean(r.ad_group_criterion?.negative),
    },
  }));
}

export function mapSharedSets(rows: Row[]): EntityRecord[] {
  return rows.map((r) => ({
    kind: 'shared_set',
    externalId: str(r.shared_set?.id),
    name: r.shared_set?.name ?? null,
    status: enumName(enums.SharedSetStatus, r.shared_set?.status),
    attrs: { type: enumName(enums.SharedSetType, r.shared_set?.type), memberCount: num(r.shared_set?.member_count) },
  }));
}

export function mapCampaignBudgets(rows: Row[]): EntityRecord[] {
  return rows.map((r) => ({
    kind: 'campaign_budget',
    externalId: str(r.campaign_budget?.id),
    name: r.campaign_budget?.name ?? null,
    status: enumName(enums.BudgetStatus, r.campaign_budget?.status),
    attrs: {
      amountMicros: numOrNull(r.campaign_budget?.amount_micros),
      shared: Boolean(r.campaign_budget?.explicitly_shared),
      deliveryMethod: enumName(enums.BudgetDeliveryMethod, r.campaign_budget?.delivery_method),
    },
  }));
}

function metricKey(level: MetricLevel, r: Row): string {
  switch (level) {
    case 'account':
      return str(r.customer?.id);
    case 'campaign':
      return str(r.campaign?.id);
    case 'ad_group':
      return str(r.ad_group?.id);
    case 'keyword':
      return keywordId(r.ad_group?.id, r.ad_group_criterion?.criterion_id);
  }
}

export function mapMetrics(level: MetricLevel, rows: Row[], hourly = false): MetricRow[] {
  return rows.map((r) => {
    const m = r.metrics ?? {};
    const row: MetricRow = {
      level,
      externalId: metricKey(level, r),
      date: str(r.segments?.date),
      costMicros: num(m.cost_micros),
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      conversions: num(m.conversions),
      convValue: num(m.conversions_value),
    };
    if (hourly) row.hour = num(r.segments?.hour);
    else {
      row.searchIs = numOrNull(m.search_impression_share);
      row.lostIsBudget = level === 'account' || level === 'campaign' ? numOrNull(m.search_budget_lost_impression_share) : null;
      row.lostIsRank = numOrNull(m.search_rank_lost_impression_share);
    }
    return row;
  });
}

function changedFieldPaths(mask: unknown): string[] {
  if (!mask) return [];
  if (typeof mask === 'string') return mask.split(',').filter(Boolean);
  const paths = (mask as { paths?: unknown }).paths;
  return Array.isArray(paths) ? paths.map(String) : [];
}

export function mapChangeEvents(rows: Row[], timeZone: string): ChangeEventRow[] {
  return rows.map((r) => {
    const e = r.change_event ?? {};
    return {
      externalId: str(e.resource_name),
      changedAt: zonedToInstant(str(e.change_date_time), timeZone),
      userEmail: e.user_email || null,
      clientType: enumName(enums.ChangeClientType, e.client_type),
      resourceType: enumName(enums.ChangeEventResourceType, e.change_resource_type),
      resourceName: e.change_resource_name || null,
      changedFields: changedFieldPaths(e.changed_fields),
      old: e.old_resource ?? null,
      new: e.new_resource ?? null,
    };
  });
}

/** One row per (ad group, term, date); duplicates from extra segments are summed. */
export function mapSearchTerms(rows: Row[]): SearchTermRow[] {
  const out = new Map<string, SearchTermRow>();
  for (const r of rows) {
    const term = str(r.search_term_view?.search_term);
    const adGroupExternalId = str(r.ad_group?.id);
    const date = str(r.segments?.date);
    const key = `${adGroupExternalId}\u0000${term}\u0000${date}`;
    const m = r.metrics ?? {};
    const row = out.get(key) ?? {
      campaignExternalId: str(r.campaign?.id),
      adGroupExternalId,
      term,
      date,
      costMicros: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      convValue: 0,
    };
    row.costMicros += num(m.cost_micros);
    row.impressions += num(m.impressions);
    row.clicks += num(m.clicks);
    row.conversions += num(m.conversions);
    row.convValue += num(m.conversions_value);
    out.set(key, row);
  }
  return [...out.values()];
}

const lastSegment = (resourceName: unknown) => str(resourceName).split('/').pop() ?? '';

export function mapConversionActions(actions: Row[], activity: Row[], uploadSummaries: Row[], timeZone: string): ConversionActionRow[] {
  // Latest hour with conversions per action; the action is "last converted" by the end of that hour.
  const last = new Map<string, Date>();
  for (const r of activity) {
    if (!r.segments?.conversion_action || !r.segments.date) continue;
    const id = lastSegment(r.segments.conversion_action);
    const at = zonedToInstant(`${str(r.segments?.date)} ${String(num(r.segments?.hour)).padStart(2, '0')}:00:00`, timeZone);
    const end = new Date(at.getTime() + 3_600_000);
    const prev = last.get(id);
    if (!prev || end > prev) last.set(id, end);
  }
  const uploads = new Map<string, unknown>();
  for (const r of uploadSummaries) {
    const s = r.offline_conversion_upload_conversion_action_summary;
    if (!s?.conversion_action_name) continue;
    uploads.set(s.conversion_action_name, {
      status: enumName(enums.OfflineConversionDiagnosticStatus, s.status),
      totalEventCount: num(s.total_event_count),
      successfulEventCount: num(s.successful_event_count),
      pendingEventCount: num(s.pending_event_count),
      alerts: s.alerts ?? [],
    });
  }
  return actions.map((r) => {
    const a = r.conversion_action ?? {};
    const id = str(a.id);
    return {
      externalId: id,
      name: str(a.name),
      status: enumName(enums.ConversionActionStatus, a.status) ?? 'UNKNOWN',
      category: enumName(enums.ConversionActionCategory, a.category),
      primary: Boolean(a.primary_for_goal),
      lastConversionAt: last.get(id) ?? null,
      ecDiagnostics: uploads.get(str(a.name)) ?? null,
    };
  });
}

export function mapUserListMetrics(rows: Row[], userLists: Row[]): AudienceRow[] {
  const names = new Map(userLists.map((u) => [str(u.user_list?.resource_name), u.user_list?.name ?? null]));
  return rows.map((r) => {
    const m = r.metrics ?? {};
    const userList = str(r.campaign_criterion?.user_list?.user_list);
    const restrictions = (r.campaign?.targeting_setting?.target_restrictions ?? []) as {
      targeting_dimension?: unknown;
      bid_only?: boolean | null;
    }[];
    const audience = restrictions.find((t) => enumName(enums.TargetingDimension, t.targeting_dimension) === 'AUDIENCE');
    return {
      campaignExternalId: str(r.campaign?.id),
      userListId: lastSegment(userList),
      userListName: names.get(userList) ?? null,
      // bid_only = observation; absent restriction also means observation.
      targetingMode: audience && audience.bid_only === false ? 'TARGETING' : 'OBSERVATION',
      date: str(r.segments?.date),
      costMicros: num(m.cost_micros),
      impressions: num(m.impressions),
      clicks: num(m.clicks),
      conversions: num(m.conversions),
      convValue: num(m.conversions_value),
    };
  });
}

export function mapBudgetSimulations(rows: Row[]): BudgetSimRow[] {
  return rows.map((r) => ({
    campaignExternalId: str(r.campaign_simulation?.campaign_id),
    points: (r.campaign_simulation?.budget_point_list?.points ?? []).map((p) => ({
      budgetMicros: num(p.budget_amount_micros),
      costMicros: num(p.cost_micros),
      clicks: num(p.clicks),
      conversions: num(p.biddable_conversions),
      convValue: num(p.biddable_conversions_value),
    })),
  }));
}

/** fetchCurrent values from a campaign state row. */
export function currentFromCampaignRow(r: Row) {
  return currentFromRecord({ status: enumName(enums.CampaignStatus, r.campaign?.status), state: campaignState(r) });
}
