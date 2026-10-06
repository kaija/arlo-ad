// Automation modes (ADR-0013): off / shadow / live per account × feature, shadow by default.
import { DEFAULT_AUTOMATION_MODE, type AutomationFeature, type AutomationMode } from '@arlo/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { automationModes, changesets, DEFAULT_ORG_ID, shadowFeedback } from '../schema';
import type { Db } from '../client';
import { writeAudit, type Actor } from './changesets';
import type { DbOrTx } from './upsert';

export async function getAutomationMode(db: DbOrTx, accountId: string, feature: AutomationFeature): Promise<AutomationMode> {
  const [row] = await db
    .select({ mode: automationModes.mode })
    .from(automationModes)
    .where(and(eq(automationModes.accountId, accountId), eq(automationModes.feature, feature)));
  return row?.mode ?? DEFAULT_AUTOMATION_MODE;
}

/** Explicit modes keyed `${accountId}:${feature}`; anything missing is the default. */
export async function listAutomationModes(db: DbOrTx): Promise<Map<string, AutomationMode>> {
  const rows = await db.select().from(automationModes).where(eq(automationModes.orgId, DEFAULT_ORG_ID));
  return new Map(rows.map((r) => [`${r.accountId}:${r.feature}`, r.mode]));
}

/** Admin-only in the Web console (Requirement 9.5); audited. */
export async function setAutomationMode(db: Db, accountId: string, feature: AutomationFeature, mode: AutomationMode, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const previous = await getAutomationMode(tx, accountId, feature);
    const [row] = await tx
      .insert(automationModes)
      .values({ orgId: DEFAULT_ORG_ID, accountId, feature, mode, updatedBy: actor.id ?? null })
      .onConflictDoUpdate({ target: [automationModes.accountId, automationModes.feature], set: { mode, updatedBy: actor.id ?? null, updatedAt: sql`now()` } })
      .returning({ id: automationModes.id });
    await writeAudit(tx, { actor, entityKind: 'automation_mode', entityId: row!.id, action: 'set', fromStatus: previous, toStatus: mode, payload: { accountId, feature } });
  });
}

// --- shadow feedback (Requirements 9.4, 9.5) ------------------------------------------------

/** Records (or changes) a user's verdict on a SIMULATED ChangeSet; returns the new totals. */
export async function recordShadowFeedback(db: DbOrTx, changesetId: string, userId: string, verdict: 'up' | 'down'): Promise<{ up: number; down: number }> {
  await db
    .insert(shadowFeedback)
    .values({ orgId: DEFAULT_ORG_ID, changesetId, userId, verdict })
    .onConflictDoUpdate({ target: [shadowFeedback.changesetId, shadowFeedback.userId], set: { verdict, updatedAt: sql`now()` } });
  return shadowTotals(db, changesetId);
}

export async function shadowTotals(db: DbOrTx, changesetId: string): Promise<{ up: number; down: number }> {
  const [row] = await db
    .select({
      up: sql<number>`count(*) filter (where ${shadowFeedback.verdict} = 'up')`.mapWith(Number),
      down: sql<number>`count(*) filter (where ${shadowFeedback.verdict} = 'down')`.mapWith(Number),
    })
    .from(shadowFeedback)
    .where(eq(shadowFeedback.changesetId, changesetId));
  return { up: row?.up ?? 0, down: row?.down ?? 0 };
}

export interface ShadowAccuracyRow {
  accountId: string;
  feature: AutomationFeature;
  simulated: number;
  /** SIMULATED ChangeSets with at least one vote, judged by majority (ties count as wrong). */
  judged: number;
  correct: number;
}

/**
 * Shadow accuracy per account × feature (Requirement 9.5): of the SIMULATED ChangeSets people
 * voted on, how many the majority judged right.
 */
export async function shadowAccuracy(db: DbOrTx, opts: { accountIds?: readonly string[] | null; since?: Date } = {}): Promise<ShadowAccuracyRow[]> {
  const votes = db
    .select({
      changesetId: shadowFeedback.changesetId,
      up: sql<number>`count(*) filter (where ${shadowFeedback.verdict} = 'up')`.as('up'),
      down: sql<number>`count(*) filter (where ${shadowFeedback.verdict} = 'down')`.as('down'),
    })
    .from(shadowFeedback)
    .groupBy(shadowFeedback.changesetId)
    .as('votes');
  const rows = await db
    .select({
      accountId: changesets.accountId,
      feature: changesets.feature,
      simulated: sql<number>`count(*)`.mapWith(Number),
      judged: sql<number>`count(${votes.changesetId})`.mapWith(Number),
      correct: sql<number>`count(*) filter (where ${votes.up} > ${votes.down})`.mapWith(Number),
    })
    .from(changesets)
    .leftJoin(votes, eq(votes.changesetId, changesets.id))
    .where(
      and(
        eq(changesets.orgId, DEFAULT_ORG_ID),
        eq(changesets.status, 'SIMULATED'),
        sql`${changesets.feature} is not null`,
        opts.accountIds ? (opts.accountIds.length ? inArray(changesets.accountId, [...opts.accountIds]) : sql`false`) : undefined,
        opts.since ? sql`${changesets.createdAt} >= ${opts.since}` : undefined,
      ),
    )
    .groupBy(changesets.accountId, changesets.feature);
  return rows.map((r) => ({ ...r, feature: r.feature! }));
}
