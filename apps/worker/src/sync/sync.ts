// Pulls platform data into Postgres (ADR-0003, Requirements 2.1–2.5). Every step is an
// idempotent upsert, so a retried or repeated run converges on the same rows.
import type { Ga4Adapter } from '@arlo/adapters/analytics';
import type { GoogleAdsPlatform, EntityRecord, MetricLevel } from '@arlo/adapters/platform';
import type { Logger } from '@arlo/config/logger';
import { addDays, dateInTimeZone, type EntityKind } from '@arlo/core';
import {
  DEFAULT_ORG_ID,
  deactivateAccountsExcept,
  deleteHourlyMetricsBefore,
  entityMapKey,
  insertChangeEvents,
  insertEntitySnapshots,
  latestChangeEventAt,
  listActiveAccounts,
  loadEntityIds,
  markEntitiesRemoved,
  upsertAdAccounts,
  upsertConversionActions,
  upsertEntities,
  upsertGa4Daily,
  upsertMetricsDaily,
  upsertMetricsHourly,
  upsertSearchTerms,
  type AdAccount,
  type Db,
} from '@arlo/db';

export interface SyncDeps {
  db: Db;
  platform: GoogleAdsPlatform;
  /** GA4 Data API, when GA4_SERVICE_ACCOUNT_JSON is configured (ADR-0021). */
  ga4?: Ga4Adapter;
  logger: Logger;
  now: () => Date;
}

const orgId = DEFAULT_ORG_ID;
// Parents before children so parent ids resolve.
const ENTITY_ORDER: EntityKind[] = ['account', 'campaign_budget', 'shared_set', 'campaign', 'ad_group', 'keyword'];
const METRIC_LEVELS: MetricLevel[] = ['account', 'campaign', 'ad_group', 'keyword'];
const SNAPSHOT_SLOT_MS = 15 * 60_000;
// Overlap when resuming change history; inserts are de-duplicated by external id.
const CHANGE_EVENT_OVERLAP_MS = 60 * 60_000;
const CHANGE_HISTORY_MS = 29 * 86_400_000;
export const HOURLY_RETENTION_DAYS = 14;
export const BACKFILL_DAYS = 3;

/** Refreshes ad_accounts from the manager account; returns the active ones. */
export async function syncAccounts({ db, platform }: SyncDeps): Promise<AdAccount[]> {
  const listed = await platform.listAccounts();
  await db.transaction(async (tx) => {
    if (listed.length) {
      await upsertAdAccounts(
        tx,
        listed.map((a) => ({ orgId, platform: platform.platform, externalId: a.externalId, name: a.name, currency: a.currency, timezone: a.timezone, active: true })),
      );
    }
    await deactivateAccountsExcept(tx, platform.platform, listed.map((a) => a.externalId));
  });
  return listActiveAccounts(db, platform.platform);
}

/** Every 15 minutes: entities, campaign state snapshots and change events (Requirement 2.3). */
export async function syncSnapshots({ db, platform, logger, now }: SyncDeps, account: AdAccount) {
  const at = now();
  const records = await platform.fetchEntities(account.externalId, ENTITY_ORDER);
  const latest = await latestChangeEventAt(db, account.id);
  const since = latest ? new Date(latest.getTime() - CHANGE_EVENT_OVERLAP_MS) : new Date(at.getTime() - CHANGE_HISTORY_MS);
  const events = await platform.fetchChangeHistory(account.externalId, since);

  return db.transaction(async (tx) => {
    const ids = await loadEntityIds(tx, account.id);
    let removed = 0;
    for (const kind of ENTITY_ORDER) {
      const batch = records.filter((r) => r.kind === kind);
      const accountEntityId = ids.get(entityMapKey('account', account.externalId)) ?? null;
      const rows = batch.map((r) => ({
        orgId,
        accountId: account.id,
        kind,
        externalId: r.externalId,
        parentId: parentId(r, ids, accountEntityId),
        name: r.name,
        status: r.status,
        attrs: r.attrs,
      }));
      for (const row of await upsertEntities(tx, rows)) ids.set(entityMapKey(row.kind, row.externalId), row.id);
      if (kind !== 'account') removed += await markEntitiesRemoved(tx, account.id, kind, batch.map((r) => r.externalId));
    }

    // One snapshot per 15-minute slot, so a retried run does not add rows.
    const capturedAt = new Date(Math.floor(at.getTime() / SNAPSHOT_SLOT_MS) * SNAPSHOT_SLOT_MS);
    const snapshots = records
      .filter((r) => r.state)
      .map((r) => ({
        orgId,
        entityId: ids.get(entityMapKey(r.kind, r.externalId))!,
        capturedAt,
        budgetMicros: r.state!.budgetMicros,
        status: r.status,
        bidStrategy: r.state!.bidStrategy,
        bidTarget: r.state!.bidTarget,
        raw: { attrs: r.attrs },
      }));
    const insertedSnapshots = await insertEntitySnapshots(tx, snapshots);

    const insertedEvents = await insertChangeEvents(
      tx,
      events.map((e) => ({
        orgId,
        accountId: account.id,
        externalId: e.externalId,
        changedAt: e.changedAt,
        userEmail: e.userEmail,
        clientType: e.clientType,
        resourceType: e.resourceType,
        resourceName: e.resourceName,
        changedFields: e.changedFields,
        old: e.old,
        new: e.new,
      })),
    );
    const result = { entities: records.length, removed, snapshots: insertedSnapshots, changeEvents: insertedEvents };
    logger.info({ account: account.externalId, ...result }, 'snapshot sync done');
    return result;
  });
}

function parentId(r: EntityRecord, ids: Map<string, string>, accountEntityId: string | null): string | null {
  if (r.kind === 'account') return null;
  if (r.parent) return ids.get(entityMapKey(r.parent.kind, r.parent.externalId)) ?? null;
  return accountEntityId;
}

async function upsertMetricLevels(
  deps: SyncDeps,
  account: AdAccount,
  range: { from: string; to: string },
  hourly: boolean,
): Promise<{ written: number; skipped: number }> {
  const { db, platform } = deps;
  const ids = await loadEntityIds(db, account.id, METRIC_LEVELS);
  let written = 0;
  let skipped = 0;
  for (const level of METRIC_LEVELS) {
    const rows = await platform.fetchMetrics({ accountId: account.externalId, level, range, hourly });
    const mapped = rows.flatMap((r) => {
      const entityId = ids.get(entityMapKey(level, r.externalId));
      // Entities appear with the next snapshot sync; their metrics are picked up on the next run.
      if (!entityId) return (skipped++, []);
      const { externalId, level: _level, hour, searchIs, lostIsBudget, lostIsRank, ...values } = r;
      return [
        {
          ...values,
          orgId,
          accountId: account.id,
          entityId,
          level,
          hour: hour ?? 0,
          searchIs: searchIs ?? null,
          lostIsBudget: lostIsBudget ?? null,
          lostIsRank: lostIsRank ?? null,
        },
      ];
    });
    written += hourly ? await upsertMetricsHourly(db, mapped) : await upsertMetricsDaily(db, mapped.map(({ hour, ...m }) => m));
  }
  return { written, skipped };
}

/** Hourly: today's metrics by hour, and today's daily totals (Requirement 2.1). */
export async function syncHourly(deps: SyncDeps, account: AdAccount) {
  const today = dateInTimeZone(deps.now(), account.timezone);
  const range = { from: today, to: today };
  const hourly = await upsertMetricLevels(deps, account, range, true);
  const daily = await upsertMetricLevels(deps, account, range, false);
  const result = { date: today, hourly: hourly.written, daily: daily.written, skipped: hourly.skipped + daily.skipped };
  deps.logger.info({ account: account.externalId, ...result }, 'hourly sync done');
  return result;
}

/** Daily: re-pull D-3..D-1 for conversion backfill, search terms, conversion actions (Requirements 2.2, 2.4). */
export async function syncDaily(deps: SyncDeps, account: AdAccount) {
  const { db, platform, logger } = deps;
  const today = dateInTimeZone(deps.now(), account.timezone);
  const range = { from: addDays(today, -BACKFILL_DAYS), to: addDays(today, -1) };
  const metrics = await upsertMetricLevels(deps, account, range, false);

  const ids = await loadEntityIds(db, account.id, ['campaign', 'ad_group']);
  let skippedTerms = 0;
  const terms = (await platform.fetchSearchTerms(account.externalId, range)).flatMap((t) => {
    const campaignId = ids.get(entityMapKey('campaign', t.campaignExternalId));
    const adGroupId = ids.get(entityMapKey('ad_group', t.adGroupExternalId));
    if (!campaignId || !adGroupId) return (skippedTerms++, []);
    return [
      {
        orgId,
        accountId: account.id,
        campaignId,
        adGroupId,
        term: t.term,
        date: t.date,
        costMicros: t.costMicros,
        impressions: t.impressions,
        clicks: t.clicks,
        conversions: t.conversions,
        convValue: t.convValue,
      },
    ];
  });
  const searchTerms = await upsertSearchTerms(db, terms);

  const actions = await platform.fetchConversionActions(account.externalId);
  await upsertConversionActions(
    db,
    actions.map((a) => ({ orgId, accountId: account.id, ...a })),
  );

  const ga4 = await syncGa4(deps, account, today);
  const result = { range, metrics: metrics.written, searchTerms, conversionActions: actions.length, skipped: metrics.skipped + skippedTerms, ga4 };
  logger.info({ account: account.externalId, ...result }, 'daily sync done');
  return result;
}

/** Days of GA4 history kept fresh: the 14-day baseline plus the recent window (Requirement 16.3). */
export const GA4_DAYS = 17;

/** GA4 google / cpc for the account's linked property; best effort, never fails the Ads sync. */
async function syncGa4(deps: SyncDeps, account: AdAccount, today: string): Promise<number | 'skipped' | 'failed'> {
  if (!deps.ga4 || !account.ga4PropertyId) return 'skipped';
  try {
    const rows = await deps.ga4.fetchDaily(account.ga4PropertyId, { from: addDays(today, -GA4_DAYS), to: addDays(today, -1) });
    return await upsertGa4Daily(
      deps.db,
      rows.map((r) => ({ orgId, propertyId: account.ga4PropertyId!, date: r.date, sourceMedium: r.sourceMedium, sessions: r.sessions, conversions: r.conversions })),
    );
  } catch (err) {
    deps.logger.warn({ err, account: account.externalId }, 'GA4 sync failed');
    return 'failed';
  }
}

/** Drops hourly metrics older than the retention window (dates compared in UTC with a day of slack). */
export function cleanupHourlyMetrics({ db, now }: Pick<SyncDeps, 'db' | 'now'>): Promise<number> {
  return deleteHourlyMetricsBefore(db, addDays(dateInTimeZone(now(), 'UTC'), -(HOURLY_RETENTION_DAYS + 1)));
}
