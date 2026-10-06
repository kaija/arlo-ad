// Automation modes (ADR-0013): off / shadow / live per account × feature, shadow by default.
import { DEFAULT_AUTOMATION_MODE, type AutomationFeature, type AutomationMode } from '@arlo/core';
import { and, eq, sql } from 'drizzle-orm';
import { automationModes, DEFAULT_ORG_ID } from '../schema';
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
