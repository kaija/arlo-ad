// Anomalies (ADR-0021). Re-detecting the same (account, entity, day, metric, segment) updates it.
import type { Anomaly } from '@arlo/core';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { anomalies, changeEvents, changesets, DEFAULT_ORG_ID } from '../schema';
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

export interface CauseCandidate {
  /** Stable id for ranking: ce:<external id> or cs:<changeset id>. */
  id: string;
  at: Date;
  kind: 'change_event' | 'changeset';
  who: string | null;
  summary: string;
  /** Platform ids the change touched, for matching an anomaly's entity. */
  targets: string[];
}

/** Google Ads change events and Arlo ChangeSets within ±hours of `at` (Requirement 16.5). */
export async function changesAround(db: DbOrTx, accountId: string, at: Date, hours = 48): Promise<CauseCandidate[]> {
  const from = new Date(at.getTime() - hours * 3_600_000);
  const to = new Date(at.getTime() + hours * 3_600_000);
  const [events, sets] = await Promise.all([
    db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.accountId, accountId), gte(changeEvents.changedAt, from), lte(changeEvents.changedAt, to)))
      .orderBy(asc(changeEvents.changedAt))
      .limit(200),
    db
      .select()
      .from(changesets)
      .where(and(eq(changesets.accountId, accountId), sql`coalesce(${changesets.executedAt}, ${changesets.createdAt}) between ${from} and ${to}`, sql`${changesets.status} in ('EXECUTED', 'REVERTED', 'FAILED')`))
      .orderBy(asc(changesets.createdAt))
      .limit(100),
  ]);
  const idOf = (resource: string | null) => (resource ? (resource.split('/').at(-1) ?? '') : '');
  return [
    ...events.map((e) => ({
      id: `ce:${e.externalId.split('/').at(-1)}`,
      at: e.changedAt,
      kind: 'change_event' as const,
      who: e.userEmail ?? e.clientType,
      summary: `${e.resourceType ?? 'CHANGE'} ${e.changedFields.join(', ')}${e.old !== null || e.new !== null ? `：${JSON.stringify(e.old)?.slice(0, 120)} → ${JSON.stringify(e.new)?.slice(0, 120)}` : ''}`,
      targets: [idOf(e.resourceName)].filter(Boolean),
    })),
    ...sets.map((c) => ({
      id: `cs:${c.id}`,
      at: c.executedAt ?? c.createdAt,
      kind: 'changeset' as const,
      who: c.requestedByKind === 'user' ? 'Arlo（使用者請求）' : 'Arlo',
      summary: `${c.summary}（${c.status}）`,
      targets: [...new Set((c.ops as { target: { id: string } }[]).map((o) => o.target.id))],
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
}
