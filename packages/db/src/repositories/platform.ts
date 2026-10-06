// Idempotent writes for the sync worker (ADR-0003). Re-running a sync with the same data
// leaves the same rows; re-syncing a date overwrites its metrics (conversion backfill,
// Requirement 2.2). Immutable history (snapshots, change events) is insert-only.
// Within one call, rows must be unique by the table's conflict key.
import {
  adAccounts,
  changeEvents,
  entities,
  entitySnapshots,
  ga4Daily,
  gAudienceMetrics,
  gConversionActions,
  gSearchTerms,
  metricsDaily,
  metricsHourly,
} from '../schema';
import { inBatches, setExcluded, type DbOrTx, type Insert } from './upsert';

const METRICS = [
  'costMicros',
  'impressions',
  'clicks',
  'conversions',
  'convValue',
  'searchIs',
  'lostIsBudget',
  'lostIsRank',
] as const;

export function upsertAdAccounts(db: DbOrTx, rows: readonly Insert<typeof adAccounts>[]) {
  return inBatches(adAccounts, rows, (batch) =>
    db
      .insert(adAccounts)
      .values(batch)
      .onConflictDoUpdate({
        target: [adAccounts.orgId, adAccounts.platform, adAccounts.externalId],
        set: setExcluded(adAccounts, ['name', 'currency', 'timezone', 'active']),
      })
      .returning({ id: adAccounts.id, platform: adAccounts.platform, externalId: adAccounts.externalId }),
  );
}

/** Parents must be upserted first so `parentId` can be resolved from the returned ids. */
export function upsertEntities(db: DbOrTx, rows: readonly Insert<typeof entities>[]) {
  return inBatches(entities, rows, (batch) =>
    db
      .insert(entities)
      .values(batch)
      .onConflictDoUpdate({
        target: [entities.accountId, entities.kind, entities.externalId],
        set: setExcluded(entities, ['parentId', 'name', 'status', 'attrs']),
      })
      .returning({ id: entities.id, kind: entities.kind, externalId: entities.externalId }),
  );
}

/** Returns the number of snapshots actually inserted. */
export async function insertEntitySnapshots(db: DbOrTx, rows: readonly Insert<typeof entitySnapshots>[]) {
  const inserted = await inBatches(entitySnapshots, rows, (batch) =>
    db
      .insert(entitySnapshots)
      .values(batch)
      .onConflictDoNothing({ target: [entitySnapshots.entityId, entitySnapshots.capturedAt] })
      .returning({ id: entitySnapshots.id }),
  );
  return inserted.length;
}

export async function upsertMetricsDaily(db: DbOrTx, rows: readonly Insert<typeof metricsDaily>[]) {
  const written = await inBatches(metricsDaily, rows, (batch) =>
    db
      .insert(metricsDaily)
      .values(batch)
      .onConflictDoUpdate({ target: [metricsDaily.entityId, metricsDaily.date], set: setExcluded(metricsDaily, METRICS) })
      .returning({ entityId: metricsDaily.entityId }),
  );
  return written.length;
}

export async function upsertMetricsHourly(db: DbOrTx, rows: readonly Insert<typeof metricsHourly>[]) {
  const written = await inBatches(metricsHourly, rows, (batch) =>
    db
      .insert(metricsHourly)
      .values(batch)
      .onConflictDoUpdate({
        target: [metricsHourly.entityId, metricsHourly.date, metricsHourly.hour],
        set: setExcluded(metricsHourly, METRICS),
      })
      .returning({ entityId: metricsHourly.entityId }),
  );
  return written.length;
}

/** Change events are immutable and kept forever (Requirement 2.5). Returns the number inserted. */
export async function insertChangeEvents(db: DbOrTx, rows: readonly Insert<typeof changeEvents>[]) {
  const inserted = await inBatches(changeEvents, rows, (batch) =>
    db
      .insert(changeEvents)
      .values(batch)
      .onConflictDoNothing({ target: [changeEvents.accountId, changeEvents.externalId] })
      .returning({ id: changeEvents.id }),
  );
  return inserted.length;
}

export async function upsertSearchTerms(db: DbOrTx, rows: readonly Insert<typeof gSearchTerms>[]) {
  const written = await inBatches(gSearchTerms, rows, (batch) =>
    db
      .insert(gSearchTerms)
      .values(batch)
      .onConflictDoUpdate({
        target: [gSearchTerms.adGroupId, gSearchTerms.term, gSearchTerms.date],
        set: setExcluded(gSearchTerms, ['campaignId', 'costMicros', 'impressions', 'clicks', 'conversions', 'convValue']),
      })
      .returning({ term: gSearchTerms.term }),
  );
  return written.length;
}

export function upsertConversionActions(db: DbOrTx, rows: readonly Insert<typeof gConversionActions>[]) {
  return inBatches(gConversionActions, rows, (batch) =>
    db
      .insert(gConversionActions)
      .values(batch)
      .onConflictDoUpdate({
        target: [gConversionActions.accountId, gConversionActions.externalId],
        set: setExcluded(gConversionActions, ['name', 'status', 'category', 'primary', 'lastConversionAt', 'ecDiagnostics']),
      })
      .returning({ id: gConversionActions.id, externalId: gConversionActions.externalId }),
  );
}

export async function upsertAudienceMetrics(db: DbOrTx, rows: readonly Insert<typeof gAudienceMetrics>[]) {
  const written = await inBatches(gAudienceMetrics, rows, (batch) =>
    db
      .insert(gAudienceMetrics)
      .values(batch)
      .onConflictDoUpdate({
        target: [gAudienceMetrics.campaignId, gAudienceMetrics.userListId, gAudienceMetrics.date],
        set: setExcluded(gAudienceMetrics, [
          'userListName',
          'targetingMode',
          'costMicros',
          'impressions',
          'clicks',
          'conversions',
          'convValue',
        ]),
      })
      .returning({ userListId: gAudienceMetrics.userListId }),
  );
  return written.length;
}

export async function upsertGa4Daily(db: DbOrTx, rows: readonly Insert<typeof ga4Daily>[]) {
  const written = await inBatches(ga4Daily, rows, (batch) =>
    db
      .insert(ga4Daily)
      .values(batch)
      .onConflictDoUpdate({
        target: [ga4Daily.orgId, ga4Daily.propertyId, ga4Daily.date, ga4Daily.sourceMedium],
        set: setExcluded(ga4Daily, ['sessions', 'conversions']),
      })
      .returning({ propertyId: ga4Daily.propertyId }),
  );
  return written.length;
}
