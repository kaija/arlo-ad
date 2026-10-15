// Optimizer inputs and runs (ADR-0018).
import { addDays, dateInTimeZone, isLearning, type OptimizerCampaign, type ReallocationPlan } from '@arlo/core';
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { DEFAULT_ORG_ID, entities, entitySnapshots, gBudgetSimulations, metricsDaily, optimizerRuns } from '../schema';
import { listCampaigns } from './reads';
import type { AdAccount } from './sync';
import { inBatches, type DbOrTx } from './upsert';

export interface SimulationInput {
  campaignId: string;
  points: { budgetMicros: number; costMicros: number; clicks: number; conversions: number; convValue: number }[];
}

export async function upsertBudgetSimulations(db: DbOrTx, accountId: string, fetchedOn: string, rows: readonly SimulationInput[]): Promise<number> {
  const written = await inBatches(gBudgetSimulations, [...rows], (batch) =>
    db
      .insert(gBudgetSimulations)
      .values(batch.map((r) => ({ orgId: DEFAULT_ORG_ID, accountId, campaignId: r.campaignId, points: r.points, fetchedOn })))
      .onConflictDoUpdate({ target: gBudgetSimulations.campaignId, set: { points: sql`excluded.points`, fetchedOn: sql`excluded.fetched_on`, updatedAt: sql`now()` } })
      .returning({ id: gBudgetSimulations.id }),
  );
  return written.length;
}

/**
 * Serializable optimizer inputs for the account's enabled campaigns: 14 days of cost and
 * conversions (or value when `valueBased`), lost IS (budget), learning status, simulation.
 */
export async function loadOptimizerInputs(db: DbOrTx, account: AdAccount, now: Date, opts: { valueBased?: boolean } = {}): Promise<OptimizerCampaign[]> {
  const today = dateInTimeZone(now, account.timezone);
  const campaigns = (await listCampaigns(db, [account.id])).filter((c) => c.status === 'ENABLED' && c.budgetMicros);
  if (campaigns.length === 0) return [];
  const ids = campaigns.map((c) => c.campaignId);
  const [metrics, sims, snaps, attrs] = await Promise.all([
    db
      .select({ entityId: metricsDaily.entityId, date: metricsDaily.date, cost: metricsDaily.costMicros, conv: metricsDaily.conversions, value: metricsDaily.convValue, lost: metricsDaily.lostIsBudget })
      .from(metricsDaily)
      .where(and(inArray(metricsDaily.entityId, ids), gte(metricsDaily.date, addDays(today, -14)), lte(metricsDaily.date, addDays(today, -1)))),
    db.select().from(gBudgetSimulations).where(inArray(gBudgetSimulations.campaignId, ids)),
    db
      .select({ entityId: entitySnapshots.entityId, capturedAt: entitySnapshots.capturedAt, bidStrategy: entitySnapshots.bidStrategy, bidTarget: entitySnapshots.bidTarget })
      .from(entitySnapshots)
      .where(and(inArray(entitySnapshots.entityId, ids), gte(entitySnapshots.capturedAt, new Date(now.getTime() - 8 * 86_400_000)))),
    db.select({ id: entities.id, attrs: entities.attrs }).from(entities).where(inArray(entities.id, ids)),
  ]);
  const shared = new Map(attrs.map((a) => [a.id, Boolean((a.attrs as { budgetShared?: boolean }).budgetShared)]));
  return campaigns.map((c) => {
    const days = metrics.filter((m) => m.entityId === c.campaignId);
    const lost = days.map((d) => d.lost).filter((v): v is number => v !== null);
    const sim = sims.find((s) => s.campaignId === c.campaignId);
    return {
      id: c.externalId,
      name: c.name ?? c.externalId,
      budgetMicros: c.budgetMicros!,
      history: days.map((d) => ({ costMicros: Number(d.cost), value: Number(opts.valueBased ? d.value : d.conv) })),
      simulation: sim ? (sim.points as SimulationInput['points']).map((p) => ({ budgetMicros: p.budgetMicros, value: opts.valueBased ? p.convValue : p.conversions })) : null,
      lostIsBudget: lost.length ? lost.reduce((s, v) => s + v, 0) / lost.length : null,
      learning: isLearning(snaps.filter((s) => s.entityId === c.campaignId), now),
      budgetShared: shared.get(c.campaignId) ?? false,
    };
  });
}

export type OptimizerRun = typeof optimizerRuns.$inferSelect;

/** `createdAt` is the caller's clock, the same one the proposal's 24 h TTL check uses. */
export async function saveOptimizerRun(db: DbOrTx, input: { accountId: string; inputs: OptimizerCampaign[]; plan: ReallocationPlan; maxChangePct: number; minConversions: number; createdAt: Date }): Promise<OptimizerRun> {
  const [row] = await db.insert(optimizerRuns).values({ orgId: DEFAULT_ORG_ID, ...input }).returning();
  return row!;
}

export async function getOptimizerRun(db: DbOrTx, id: string): Promise<OptimizerRun | undefined> {
  const [row] = await db.select().from(optimizerRuns).where(eq(optimizerRuns.id, id));
  return row;
}

/** Claims a run for one proposal before it is made; false when it was already used. */
export async function claimOptimizerRun(db: DbOrTx, id: string, at: Date): Promise<boolean> {
  const rows = await db.update(optimizerRuns).set({ usedAt: at }).where(and(eq(optimizerRuns.id, id), isNull(optimizerRuns.usedAt))).returning({ id: optimizerRuns.id });
  return rows.length === 1;
}

export async function linkOptimizerRun(db: DbOrTx, id: string, changesetId: string): Promise<void> {
  await db.update(optimizerRuns).set({ changesetId }).where(eq(optimizerRuns.id, id));
}
