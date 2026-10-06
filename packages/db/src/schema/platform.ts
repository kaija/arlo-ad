import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';
import { orgs } from './identity';

// Platform data synced into Postgres (ADR-0003). Core tables are platform-neutral
// (Requirement 2.7); Google-only data lives in the `g_` extension tables (ADR-0004).
// `platform` is stored once, on ad_accounts; child rows reach it through account_id.

const orgId = () =>
  uuid('org_id')
    .notNull()
    .references(() => orgs.id);
const accountId = () =>
  uuid('account_id')
    .notNull()
    .references(() => adAccounts.id);
const micros = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);
const count = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);
const decimal = (name: string) => numeric(name, { precision: 20, scale: 6, mode: 'number' }).notNull().default(0);
// Impression share is a ratio in [0, 1]; null when the platform does not report it.
const share = (name: string) => numeric(name, { precision: 6, scale: 5, mode: 'number' });
// Calendar date in the account's timezone.
const day = () => date('date', { mode: 'string' }).notNull();

export const PLATFORMS = ['google_ads'] as const;
export const platform = pgEnum('platform', PLATFORMS);

export const adAccounts = pgTable(
  'ad_accounts',
  {
    id: id(),
    orgId: orgId(),
    platform: platform('platform').notNull(),
    // Google Ads customer ID without dashes.
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    timezone: text('timezone').notNull(),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('ad_accounts_org_platform_external_id_key').on(t.orgId, t.platform, t.externalId),
    check('ad_accounts_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

// `account` rows exist so account-level metrics share the entity_id keyed metric tables.
export const ENTITY_KINDS = ['account', 'campaign', 'ad_group', 'keyword', 'shared_set', 'campaign_budget'] as const;
export const entityKind = pgEnum('entity_kind', ENTITY_KINDS);

export const entities = pgTable(
  'entities',
  {
    id: id(),
    orgId: orgId(),
    accountId: accountId(),
    kind: entityKind('kind').notNull(),
    // Stable platform identifier, unique per (account, kind). Google keywords use the
    // resource-name suffix `adGroupId~criterionId` because criterion IDs repeat across ad groups.
    externalId: text('external_id').notNull(),
    parentId: uuid('parent_id'),
    name: text('name'),
    // Platform status as reported (e.g. ENABLED / PAUSED / REMOVED).
    status: text('status'),
    attrs: jsonb('attrs').notNull().default({}),
    ...timestamps,
  },
  (t) => [
    unique('entities_account_kind_external_id_key').on(t.accountId, t.kind, t.externalId),
    // Target for the composite FKs that keep denormalized account_id / level consistent.
    unique('entities_id_account_kind_key').on(t.id, t.accountId, t.kind),
    foreignKey({ name: 'entities_parent_id_fk', columns: [t.parentId], foreignColumns: [t.id] }),
    index('entities_parent_id_idx').on(t.parentId),
  ],
);

// Point-in-time campaign state, captured every 15 minutes; source of ChangeSet `before` values.
export const entitySnapshots = pgTable(
  'entity_snapshots',
  {
    id: id(),
    orgId: orgId(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    budgetMicros: bigint('budget_micros', { mode: 'number' }),
    status: text('status'),
    bidStrategy: text('bid_strategy'),
    // Meaning depends on bid_strategy: target CPA in micros, or target ROAS as a ratio.
    bidTarget: numeric('bid_target', { precision: 20, scale: 6, mode: 'number' }),
    raw: jsonb('raw').notNull().default({}),
    ...timestamps,
  },
  (t) => [unique('entity_snapshots_entity_captured_at_key').on(t.entityId, t.capturedAt)],
);

const metricColumns = {
  costMicros: micros('cost_micros'),
  impressions: count('impressions'),
  clicks: count('clicks'),
  conversions: decimal('conversions'),
  convValue: decimal('conv_value'),
  searchIs: share('search_is'),
  lostIsBudget: share('lost_is_budget'),
  lostIsRank: share('lost_is_rank'),
};

// Denormalized account_id / level for dashboard queries, pinned to the entity by a composite FK.
const metricKeys = {
  orgId: orgId(),
  accountId: accountId(),
  entityId: uuid('entity_id').notNull(),
  level: entityKind('level').notNull(),
  date: day(),
};

export const metricsDaily = pgTable(
  'metrics_daily',
  { ...metricKeys, ...metricColumns, ...timestamps },
  (t) => [
    primaryKey({ name: 'metrics_daily_pk', columns: [t.entityId, t.date] }),
    foreignKey({
      name: 'metrics_daily_entity_fk',
      columns: [t.entityId, t.accountId, t.level],
      foreignColumns: [entities.id, entities.accountId, entities.kind],
    }),
    index('metrics_daily_account_level_date_idx').on(t.accountId, t.level, t.date),
  ],
);

// Today's metrics by hour (account timezone); kept 14 days.
export const metricsHourly = pgTable(
  'metrics_hourly',
  { ...metricKeys, hour: smallint('hour').notNull(), ...metricColumns, ...timestamps },
  (t) => [
    primaryKey({ name: 'metrics_hourly_pk', columns: [t.entityId, t.date, t.hour] }),
    foreignKey({
      name: 'metrics_hourly_entity_fk',
      columns: [t.entityId, t.accountId, t.level],
      foreignColumns: [entities.id, entities.accountId, entities.kind],
    }),
    index('metrics_hourly_account_level_date_idx').on(t.accountId, t.level, t.date),
    check('metrics_hourly_hour_range', sql`${t.hour} between 0 and 23`),
  ],
);

// Kept forever, beyond the platform's 30-day change history (Requirement 2.5). Immutable.
export const changeEvents = pgTable(
  'change_events',
  {
    id: id(),
    orgId: orgId(),
    accountId: accountId(),
    externalId: text('external_id').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
    userEmail: text('user_email'),
    clientType: text('client_type'),
    resourceType: text('resource_type'),
    resourceName: text('resource_name'),
    changedFields: text('changed_fields').array().notNull().default(sql`'{}'::text[]`),
    old: jsonb('old'),
    new: jsonb('new'),
    ...timestamps,
  },
  (t) => [
    unique('change_events_account_external_id_key').on(t.accountId, t.externalId),
    index('change_events_account_changed_at_idx').on(t.accountId, t.changedAt),
    index('change_events_resource_changed_at_idx').on(t.resourceName, t.changedAt),
  ],
);

// --- Google Ads extension tables ------------------------------------------------------

const entityRef = (name: string) =>
  uuid(name)
    .notNull()
    .references(() => entities.id);

export const gSearchTerms = pgTable(
  'g_search_terms',
  {
    orgId: orgId(),
    accountId: accountId(),
    campaignId: entityRef('campaign_id'),
    adGroupId: entityRef('ad_group_id'),
    term: text('term').notNull(),
    date: day(),
    costMicros: micros('cost_micros'),
    impressions: count('impressions'),
    clicks: count('clicks'),
    conversions: decimal('conversions'),
    convValue: decimal('conv_value'),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'g_search_terms_pk', columns: [t.adGroupId, t.term, t.date] }),
    index('g_search_terms_account_date_idx').on(t.accountId, t.date),
  ],
);

export const gConversionActions = pgTable(
  'g_conversion_actions',
  {
    id: id(),
    orgId: orgId(),
    accountId: accountId(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    category: text('category'),
    primary: boolean('primary').notNull().default(false),
    lastConversionAt: timestamp('last_conversion_at', { withTimezone: true }),
    ecDiagnostics: jsonb('ec_diagnostics'),
    ...timestamps,
  },
  (t) => [unique('g_conversion_actions_account_external_id_key').on(t.accountId, t.externalId)],
);

export const gAudienceMetrics = pgTable(
  'g_audience_metrics',
  {
    orgId: orgId(),
    accountId: accountId(),
    campaignId: entityRef('campaign_id'),
    userListId: text('user_list_id').notNull(),
    userListName: text('user_list_name'),
    // OBSERVATION or TARGETING (Requirement 17.1).
    targetingMode: text('targeting_mode'),
    date: day(),
    costMicros: micros('cost_micros'),
    impressions: count('impressions'),
    clicks: count('clicks'),
    conversions: decimal('conversions'),
    convValue: decimal('conv_value'),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'g_audience_metrics_pk', columns: [t.campaignId, t.userListId, t.date] }),
    index('g_audience_metrics_account_date_idx').on(t.accountId, t.date),
  ],
);

// GA4 is keyed by property, not ad account (ADR-0021).
export const ga4Daily = pgTable(
  'ga4_daily',
  {
    orgId: orgId(),
    propertyId: text('property_id').notNull(),
    date: day(),
    sourceMedium: text('source_medium').notNull(),
    sessions: count('sessions'),
    conversions: decimal('conversions'),
    ...timestamps,
  },
  (t) => [primaryKey({ name: 'ga4_daily_pk', columns: [t.orgId, t.propertyId, t.date, t.sourceMedium] })],
);
