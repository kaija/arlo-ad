// Sync worker reads and bookkeeping (ADR-0003). Writes of platform data go through
// repositories/platform.ts.
import { and, eq, inArray, lt, max, notInArray, sql } from 'drizzle-orm';
import type { EntityKind, Platform } from '@arlo/core';
import { adAccounts, changeEvents, DEFAULT_ORG_ID, entities, metricsHourly, syncState } from '../schema';
import type { DbOrTx } from './upsert';

export type AdAccount = typeof adAccounts.$inferSelect;
export type SyncState = typeof syncState.$inferSelect;

export function listActiveAccounts(db: DbOrTx, platform: Platform): Promise<AdAccount[]> {
  return db
    .select()
    .from(adAccounts)
    .where(and(eq(adAccounts.orgId, DEFAULT_ORG_ID), eq(adAccounts.platform, platform), eq(adAccounts.active, true)))
    .orderBy(adAccounts.externalId);
}

/** Accounts no longer accessible through the manager account stop syncing. Returns how many. */
export async function deactivateAccountsExcept(db: DbOrTx, platform: Platform, keepExternalIds: readonly string[]) {
  const rows = await db
    .update(adAccounts)
    .set({ active: false })
    .where(
      and(
        eq(adAccounts.orgId, DEFAULT_ORG_ID),
        eq(adAccounts.platform, platform),
        eq(adAccounts.active, true),
        keepExternalIds.length ? notInArray(adAccounts.externalId, [...keepExternalIds]) : undefined,
      ),
    )
    .returning({ id: adAccounts.id });
  return rows.length;
}

export const entityMapKey = (kind: EntityKind, externalId: string) => `${kind}:${externalId}`;

/** Internal entity ids of an account keyed by `kind:externalId`. */
export async function loadEntityIds(db: DbOrTx, accountId: string, kinds?: readonly EntityKind[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: entities.id, kind: entities.kind, externalId: entities.externalId })
    .from(entities)
    .where(and(eq(entities.accountId, accountId), kinds ? inArray(entities.kind, [...kinds]) : undefined));
  return new Map(rows.map((r) => [entityMapKey(r.kind, r.externalId), r.id]));
}

/**
 * Entities of `kind` the platform no longer returns (removed there) are kept for history
 * with status REMOVED. Returns how many were marked.
 */
export async function markEntitiesRemoved(db: DbOrTx, accountId: string, kind: EntityKind, keepExternalIds: readonly string[]) {
  const rows = await db
    .update(entities)
    .set({ status: 'REMOVED' })
    .where(
      and(
        eq(entities.accountId, accountId),
        eq(entities.kind, kind),
        sql`${entities.status} is distinct from 'REMOVED'`,
        keepExternalIds.length ? notInArray(entities.externalId, [...keepExternalIds]) : undefined,
      ),
    )
    .returning({ id: entities.id });
  return rows.length;
}

export async function latestChangeEventAt(db: DbOrTx, accountId: string): Promise<Date | null> {
  const [row] = await db.select({ at: max(changeEvents.changedAt) }).from(changeEvents).where(eq(changeEvents.accountId, accountId));
  return row?.at ?? null;
}

/** metrics_hourly keeps 14 days (design.md); returns rows deleted. */
export async function deleteHourlyMetricsBefore(db: DbOrTx, date: string): Promise<number> {
  const rows = await db.delete(metricsHourly).where(lt(metricsHourly.date, date)).returning({ id: metricsHourly.entityId });
  return rows.length;
}

/** Records a sync attempt; a success resets the failure streak. Returns the new state. */
export async function recordSyncAttempt(
  db: DbOrTx,
  input: { accountId: string; job: string; at: Date } & ({ ok: true } | { ok: false; error: string }),
): Promise<SyncState> {
  const failure = !input.ok;
  const [row] = await db
    .insert(syncState)
    .values({
      orgId: DEFAULT_ORG_ID,
      accountId: input.accountId,
      job: input.job,
      lastAttemptAt: input.at,
      lastSuccessAt: failure ? null : input.at,
      consecutiveFailures: failure ? 1 : 0,
      lastError: failure ? input.error : null,
    })
    .onConflictDoUpdate({
      target: [syncState.accountId, syncState.job],
      set: failure
        ? {
            lastAttemptAt: input.at,
            consecutiveFailures: sql`${syncState.consecutiveFailures} + 1`,
            lastError: input.error,
            updatedAt: sql`now()`,
          }
        : {
            lastAttemptAt: input.at,
            lastSuccessAt: input.at,
            consecutiveFailures: 0,
            lastError: null,
            alertedAt: null,
            updatedAt: sql`now()`,
          },
    })
    .returning();
  return row!;
}

export async function markSyncAlerted(db: DbOrTx, accountId: string, job: string, at: Date): Promise<void> {
  await db
    .update(syncState)
    .set({ alertedAt: at })
    .where(and(eq(syncState.accountId, accountId), eq(syncState.job, job)));
}

export function listSyncState(db: DbOrTx): Promise<SyncState[]> {
  return db.select().from(syncState).where(eq(syncState.orgId, DEFAULT_ORG_ID));
}

export async function getAdAccount(db: DbOrTx, id: string): Promise<AdAccount | undefined> {
  const [row] = await db.select().from(adAccounts).where(eq(adAccounts.id, id));
  return row;
}

export async function getSyncState(db: DbOrTx, accountId: string, job: string): Promise<SyncState | undefined> {
  const [row] = await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.accountId, accountId), eq(syncState.job, job)));
  return row;
}
