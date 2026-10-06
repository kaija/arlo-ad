// PlatformAdapter: shared core + Google extensions (ADR-0004). All ids are platform ids;
// mapping to internal rows is the sync worker's job. Money in micros, ratios in 0–1.
import type { CurrentState, EntityKind, EntityRef, Op, OpResult, Platform } from '@arlo/core';

/** Inclusive calendar range in the account's timezone, YYYY-MM-DD. */
export interface DateRange {
  from: string;
  to: string;
}

export interface AccountInfo {
  externalId: string;
  name: string;
  currency: string;
  timezone: string;
}

export interface EntityRecord {
  kind: EntityKind;
  externalId: string;
  parent?: { kind: EntityKind; externalId: string };
  name: string | null;
  status: string | null;
  attrs: Record<string, unknown>;
  /** Point-in-time campaign state, stored as entity_snapshots. */
  state?: { budgetMicros: number | null; bidStrategy: string | null; bidTarget: number | null };
}

export type MetricLevel = 'account' | 'campaign' | 'ad_group' | 'keyword';

export interface MetricsQuery {
  accountId: string;
  level: MetricLevel;
  range: DateRange;
  /** Segment by hour of day (today's metrics, Requirement 2.1). */
  hourly?: boolean;
}

export interface MetricValues {
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  convValue: number;
  searchIs?: number | null;
  lostIsBudget?: number | null;
  lostIsRank?: number | null;
}

export interface MetricRow extends MetricValues {
  level: MetricLevel;
  /** Entity external id; the account's own id for level `account`. */
  externalId: string;
  date: string;
  hour?: number;
}

export interface ChangeEventRow {
  /** change_event resource name; unique per account. */
  externalId: string;
  changedAt: Date;
  userEmail: string | null;
  clientType: string | null;
  resourceType: string | null;
  resourceName: string | null;
  changedFields: string[];
  old: unknown;
  new: unknown;
}

export interface SearchTermRow {
  campaignExternalId: string;
  adGroupExternalId: string;
  term: string;
  date: string;
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  convValue: number;
}

export interface ConversionActionRow {
  externalId: string;
  name: string;
  status: string;
  category: string | null;
  primary: boolean;
  lastConversionAt: Date | null;
  /** All conversions over the last 30 days, for the tracking health baseline (Requirement 16.2). */
  conversions30d: number;
  ecDiagnostics: unknown;
}

export interface AudienceRow {
  campaignExternalId: string;
  userListId: string;
  userListName: string | null;
  targetingMode: 'OBSERVATION' | 'TARGETING' | null;
  date: string;
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  convValue: number;
}

export interface BudgetSimPoint {
  budgetMicros: number;
  costMicros: number;
  clicks: number;
  conversions: number;
  convValue: number;
}

export interface BudgetSimRow {
  campaignExternalId: string;
  points: BudgetSimPoint[];
}

export interface KeywordIdea {
  text: string;
  avgMonthlySearches: number | null;
  competition: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  lowTopBidMicros: number | null;
  highTopBidMicros: number | null;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  listAccounts(): Promise<AccountInfo[]>;
  fetchEntities(accountId: string, kinds: EntityKind[]): Promise<EntityRecord[]>;
  fetchMetrics(q: MetricsQuery): Promise<MetricRow[]>;
  fetchChangeHistory(accountId: string, since: Date): Promise<ChangeEventRow[]>;
  /** Live values for re-validation (ADR-0009), keyed by entityKey(ref). Missing entities are absent. */
  fetchCurrent(refs: EntityRef[]): Promise<Map<string, CurrentState>>;
  /** Executor only (ADR-0006). One result per op, in order. */
  applyOps(accountId: string, ops: Op[]): Promise<OpResult[]>;
}

export interface GoogleAdsExtensions {
  fetchSearchTerms(accountId: string, range: DateRange): Promise<SearchTermRow[]>;
  fetchConversionActions(accountId: string): Promise<ConversionActionRow[]>;
  fetchUserListMetrics(accountId: string, range: DateRange): Promise<AudienceRow[]>;
  fetchBudgetSimulations(accountId: string, campaignIds: string[]): Promise<BudgetSimRow[]>;
  generateKeywordIdeas(accountId: string, seeds: string[]): Promise<KeywordIdea[]>;
}

export type GoogleAdsPlatform = PlatformAdapter & GoogleAdsExtensions;
