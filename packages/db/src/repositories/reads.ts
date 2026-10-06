// Read queries over synced platform data for agent tools and the Web dashboard
// (Requirement 2.8: reads go to Postgres, not the platform API).
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { EntityKind } from '@arlo/core';
import { adAccounts, changeEvents, DEFAULT_ORG_ID, entities, entitySnapshots, metricsDaily } from '../schema';
import type { AdAccount } from './sync';
import type { DbOrTx } from './upsert';

/**
 * Accounts the caller may read, optionally narrowed by `account` (internal id, customer ID with or
 * without dashes, or exact name). `allowed` null means every account.
 */
export async function resolveAccounts(db: DbOrTx, opts: { allowed: readonly string[] | null; account?: string | null }): Promise<AdAccount[]> {
  const rows = await db
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.orgId, DEFAULT_ORG_ID), opts.allowed ? inArray(adAccounts.id, [...opts.allowed]) : undefined))
    .orderBy(asc(adAccounts.name));
  const wanted = opts.account?.trim();
  if (!wanted) return rows.filter((a) => a.active);
  const digits = wanted.replace(/-/g, '');
  return rows.filter((a) => a.id === wanted || a.externalId === digits || a.name.toLowerCase() === wanted.toLowerCase());
}

export interface CampaignRow {
  accountId: string;
  accountName: string;
  currency: string;
  campaignId: string;
  externalId: string;
  name: string | null;
  status: string | null;
  budgetMicros: number | null;
  bidStrategy: string | null;
  bidTarget: number | null;
  snapshotAt: Date | null;
}

/** Campaigns (not removed) with their latest state snapshot. */
export async function listCampaigns(db: DbOrTx, accountIds: readonly string[]): Promise<CampaignRow[]> {
  if (accountIds.length === 0) return [];
  const latest = db
    .selectDistinctOn([entitySnapshots.entityId], {
      entityId: entitySnapshots.entityId,
      capturedAt: entitySnapshots.capturedAt,
      budgetMicros: entitySnapshots.budgetMicros,
      bidStrategy: entitySnapshots.bidStrategy,
      bidTarget: entitySnapshots.bidTarget,
    })
    .from(entitySnapshots)
    .orderBy(entitySnapshots.entityId, desc(entitySnapshots.capturedAt))
    .as('latest');
  return db
    .select({
      accountId: adAccounts.id,
      accountName: adAccounts.name,
      currency: adAccounts.currency,
      campaignId: entities.id,
      externalId: entities.externalId,
      name: entities.name,
      status: entities.status,
      budgetMicros: latest.budgetMicros,
      bidStrategy: latest.bidStrategy,
      bidTarget: latest.bidTarget,
      snapshotAt: latest.capturedAt,
    })
    .from(entities)
    .innerJoin(adAccounts, eq(adAccounts.id, entities.accountId))
    .leftJoin(latest, eq(latest.entityId, entities.id))
    .where(and(inArray(entities.accountId, [...accountIds]), eq(entities.kind, 'campaign'), sql`${entities.status} is distinct from 'REMOVED'`))
    .orderBy(asc(adAccounts.name), asc(entities.name));
}

export interface MetricsQuery {
  accountIds: readonly string[];
  level: Extract<EntityKind, 'account' | 'campaign' | 'ad_group' | 'keyword'>;
  from: string;
  to: string;
  /** Restrict to these entities (internal ids). */
  entityIds?: readonly string[];
  groupBy: 'total' | 'day' | 'entity';
  limit?: number;
}

export interface MetricsRow {
  date: string | null;
  entityId: string | null;
  entityName: string | null;
  accountId: string | null;
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  convValue: number;
  /** Impression-weighted averages; null when not reported. */
  searchIs: number | null;
  lostIsBudget: number | null;
  lostIsRank: number | null;
}

const weighted = (col: SQL | typeof metricsDaily.searchIs) =>
  sql<number | null>`sum(${col} * ${metricsDaily.impressions}) filter (where ${col} is not null) / nullif(sum(${metricsDaily.impressions}) filter (where ${col} is not null), 0)`.mapWith(
    (v) => (v === null ? null : Number(v)),
  );

export async function queryMetrics(db: DbOrTx, q: MetricsQuery): Promise<MetricsRow[]> {
  if (q.accountIds.length === 0) return [];
  const sums = {
    costMicros: sql<number>`coalesce(sum(${metricsDaily.costMicros}), 0)`.mapWith(Number),
    impressions: sql<number>`coalesce(sum(${metricsDaily.impressions}), 0)`.mapWith(Number),
    clicks: sql<number>`coalesce(sum(${metricsDaily.clicks}), 0)`.mapWith(Number),
    conversions: sql<number>`coalesce(sum(${metricsDaily.conversions}), 0)`.mapWith(Number),
    convValue: sql<number>`coalesce(sum(${metricsDaily.convValue}), 0)`.mapWith(Number),
    searchIs: weighted(metricsDaily.searchIs),
    lostIsBudget: weighted(metricsDaily.lostIsBudget),
    lostIsRank: weighted(metricsDaily.lostIsRank),
  };
  const where = and(
    inArray(metricsDaily.accountId, [...q.accountIds]),
    eq(metricsDaily.level, q.level),
    gte(metricsDaily.date, q.from),
    lte(metricsDaily.date, q.to),
    q.entityIds?.length ? inArray(metricsDaily.entityId, [...q.entityIds]) : undefined,
  );

  if (q.groupBy === 'total') {
    const [row] = await db.select(sums).from(metricsDaily).where(where);
    return [{ date: null, entityId: null, entityName: null, accountId: null, ...row! }];
  }
  if (q.groupBy === 'day') {
    const rows = await db
      .select({ date: metricsDaily.date, ...sums })
      .from(metricsDaily)
      .where(where)
      .groupBy(metricsDaily.date)
      .orderBy(asc(metricsDaily.date))
      .limit(q.limit ?? 400);
    return rows.map((r) => ({ entityId: null, entityName: null, accountId: null, ...r }));
  }
  const rows = await db
    .select({ entityId: metricsDaily.entityId, entityName: entities.name, accountId: metricsDaily.accountId, ...sums })
    .from(metricsDaily)
    .innerJoin(entities, eq(entities.id, metricsDaily.entityId))
    .where(where)
    .groupBy(metricsDaily.entityId, entities.name, metricsDaily.accountId)
    .orderBy(desc(sql`sum(${metricsDaily.costMicros})`))
    .limit(q.limit ?? 50);
  return rows.map((r) => ({ date: null, ...r }));
}

/** Account-level spend per day (summed across the given accounts). */
export async function dailySpend(db: DbOrTx, accountIds: readonly string[], from: string, to: string) {
  if (accountIds.length === 0) return [];
  return db
    .select({ date: metricsDaily.date, costMicros: sql<number>`sum(${metricsDaily.costMicros})`.mapWith(Number) })
    .from(metricsDaily)
    .where(and(inArray(metricsDaily.accountId, [...accountIds]), eq(metricsDaily.level, 'account'), gte(metricsDaily.date, from), lte(metricsDaily.date, to)))
    .groupBy(metricsDaily.date)
    .orderBy(asc(metricsDaily.date));
}

export interface ChangeEventQuery {
  accountIds: readonly string[];
  from: Date;
  to: Date;
  /** Match resource names containing this id fragment, e.g. a campaign or budget id. */
  resourceContains?: string;
  limit?: number;
}

export async function listChangeEvents(db: DbOrTx, q: ChangeEventQuery) {
  if (q.accountIds.length === 0) return [];
  return db
    .select({
      accountId: changeEvents.accountId,
      changedAt: changeEvents.changedAt,
      userEmail: changeEvents.userEmail,
      clientType: changeEvents.clientType,
      resourceType: changeEvents.resourceType,
      resourceName: changeEvents.resourceName,
      changedFields: changeEvents.changedFields,
      old: changeEvents.old,
      new: changeEvents.new,
    })
    .from(changeEvents)
    .where(
      and(
        inArray(changeEvents.accountId, [...q.accountIds]),
        gte(changeEvents.changedAt, q.from),
        lte(changeEvents.changedAt, q.to),
        q.resourceContains ? sql`${changeEvents.resourceName} like ${`%${q.resourceContains.replace(/[%_\\]/g, '\\$&')}%`}` : undefined,
      ),
    )
    .orderBy(desc(changeEvents.changedAt))
    .limit(q.limit ?? 50);
}

/** Entity ids of an account's entities by external id, for tools that accept platform ids. */
export async function findEntities(db: DbOrTx, accountIds: readonly string[], kind: EntityKind, refs: readonly string[]) {
  if (accountIds.length === 0 || refs.length === 0) return [];
  return db
    .select({ id: entities.id, accountId: entities.accountId, externalId: entities.externalId, name: entities.name })
    .from(entities)
    .where(
      and(
        inArray(entities.accountId, [...accountIds]),
        eq(entities.kind, kind),
        sql`(${entities.externalId} = any(${sql.param([...refs])}::text[]) or ${entities.id}::text = any(${sql.param([...refs])}::text[]))`,
        sql`${entities.status} is distinct from 'REMOVED'`,
      ),
    );
}
