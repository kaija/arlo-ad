// Anomalies (ADR-0021). Re-detecting the same (account, entity, day, metric, segment) updates it.
import type { Anomaly } from '@arlo/core';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { anomalies, DEFAULT_ORG_ID } from '../schema';
import type { DbOrTx } from './upsert';

export type AnomalyRow = typeof anomalies.$inferSelect;

export async function saveAnomalies(db: DbOrTx, accountId: string, entityId: string | null, found: readonly Anomaly[]): Promise<AnomalyRow[]> {
  const out: AnomalyRow[] = [];
  for (const a of found) {
    const segment = typeof a.details?.segment === 'string' ? a.details.segment : '';
    const values = {
      orgId: DEFAULT_ORG_ID,
      accountId,
      entityId,
      entityKey: entityId ?? '',
      detectedOn: a.date,
      metric: a.metric,
      segment,
      value: Number.isFinite(a.value) ? a.value : 0,
      baseline: Number.isFinite(a.baseline) ? a.baseline : 0,
      z: Math.max(-1e6, Math.min(1e6, Math.round(a.z * 10_000) / 10_000)),
      direction: a.direction,
      details: a.details ?? {},
    };
    const [row] = await db
      .insert(anomalies)
      .values(values)
      .onConflictDoUpdate({
        target: [anomalies.accountId, anomalies.entityKey, anomalies.detectedOn, anomalies.metric, anomalies.segment],
        set: { value: values.value, baseline: values.baseline, z: values.z, direction: values.direction, details: values.details, updatedAt: sql`now()` },
      })
      .returning();
    out.push(row!);
  }
  return out;
}

export function listAnomalies(db: DbOrTx, opts: { accountIds?: readonly string[]; since?: string; unexplainedOnly?: boolean; limit?: number } = {}) {
  return db
    .select()
    .from(anomalies)
    .where(
      and(
        eq(anomalies.orgId, DEFAULT_ORG_ID),
        opts.accountIds ? (opts.accountIds.length ? sql`${anomalies.accountId} = any(${sql.param([...opts.accountIds])}::uuid[])` : sql`false`) : undefined,
        opts.since ? gte(anomalies.detectedOn, opts.since) : undefined,
        opts.unexplainedOnly ? isNull(anomalies.explainedAt) : undefined,
      ),
    )
    .orderBy(desc(anomalies.detectedOn), desc(sql`abs(${anomalies.z})`))
    .limit(opts.limit ?? 100);
}

export async function setAnomalyExplanation(db: DbOrTx, id: string, explanation: string, at: Date): Promise<void> {
  await db.update(anomalies).set({ explanation, explainedAt: at }).where(eq(anomalies.id, id));
}
