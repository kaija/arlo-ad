// Monitor rules and firings (ADR-0017).
import { MonitorActionSchema, MonitorRuleSpecSchema, type MonitorAction, type MonitorRuleSpec } from '@arlo/core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DEFAULT_ORG_ID, monitorFirings, monitorRules } from '../schema';
import type { Db } from '../client';
import { writeAudit, type Actor } from './changesets';
import type { DbOrTx } from './upsert';

export interface MonitorRule {
  id: string;
  accountId: string;
  campaignEntityId: string | null;
  spec: MonitorRuleSpec;
  action: MonitorAction;
  cooldownMinutes: number;
  enabled: boolean;
}

type Row = typeof monitorRules.$inferSelect;
const toRule = (r: Row): MonitorRule => ({
  id: r.id,
  accountId: r.accountId,
  campaignEntityId: r.campaignEntityId,
  spec: MonitorRuleSpecSchema.parse(r.spec),
  action: MonitorActionSchema.parse(r.action),
  cooldownMinutes: r.cooldownMinutes,
  enabled: r.enabled,
});

export async function listMonitorRules(db: DbOrTx, opts: { accountId?: string; enabledOnly?: boolean } = {}): Promise<MonitorRule[]> {
  const rows = await db
    .select()
    .from(monitorRules)
    .where(and(eq(monitorRules.orgId, DEFAULT_ORG_ID), opts.accountId ? eq(monitorRules.accountId, opts.accountId) : undefined, opts.enabledOnly ? eq(monitorRules.enabled, true) : undefined))
    .orderBy(asc(monitorRules.createdAt));
  return rows.map(toRule);
}

export async function getMonitorRule(db: DbOrTx, id: string): Promise<MonitorRule | undefined> {
  const [row] = await db.select().from(monitorRules).where(and(eq(monitorRules.orgId, DEFAULT_ORG_ID), eq(monitorRules.id, id)));
  return row ? toRule(row) : undefined;
}

export interface MonitorRuleInput {
  accountId: string;
  campaignEntityId: string | null;
  spec: MonitorRuleSpec;
  action: MonitorAction;
  cooldownMinutes: number;
  enabled: boolean;
}

/** Creates or updates a rule (spec and action validated) and audits it. */
export async function saveMonitorRule(db: Db, input: MonitorRuleInput & { id?: string }, actor: Actor): Promise<MonitorRule> {
  const values = {
    accountId: input.accountId,
    campaignEntityId: input.campaignEntityId,
    spec: MonitorRuleSpecSchema.parse(input.spec),
    action: MonitorActionSchema.parse(input.action),
    cooldownMinutes: input.cooldownMinutes,
    enabled: input.enabled,
  };
  return db.transaction(async (tx) => {
    const [row] = input.id
      ? await tx.update(monitorRules).set(values).where(and(eq(monitorRules.orgId, DEFAULT_ORG_ID), eq(monitorRules.id, input.id))).returning()
      : await tx.insert(monitorRules).values({ ...values, orgId: DEFAULT_ORG_ID, createdBy: actor.id ?? null }).returning();
    if (!row) throw new Error(`monitor rule ${input.id} not found`);
    await writeAudit(tx, { actor, entityKind: 'monitor_rule', entityId: row.id, action: input.id ? 'update' : 'create', payload: values });
    return toRule(row);
  });
}

export async function deleteMonitorRule(db: Db, id: string, actor: Actor): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(monitorRules).where(and(eq(monitorRules.orgId, DEFAULT_ORG_ID), eq(monitorRules.id, id))).returning();
    if (row) await writeAudit(tx, { actor, entityKind: 'monitor_rule', entityId: id, action: 'delete', payload: { spec: row.spec, action: row.action } });
    return Boolean(row);
  });
}

export async function lastFiring(db: DbOrTx, ruleId: string, entityId: string): Promise<Date | null> {
  const [row] = await db
    .select({ firedAt: monitorFirings.firedAt })
    .from(monitorFirings)
    .where(and(eq(monitorFirings.monitorRuleId, ruleId), eq(monitorFirings.entityId, entityId)))
    .orderBy(desc(monitorFirings.firedAt))
    .limit(1);
  return row?.firedAt ?? null;
}

export async function recordFiring(db: DbOrTx, input: { ruleId: string; entityId: string; firedAt: Date; changesetId: string | null; evidence: Record<string, unknown> }): Promise<void> {
  await db.insert(monitorFirings).values({ orgId: DEFAULT_ORG_ID, monitorRuleId: input.ruleId, entityId: input.entityId, firedAt: input.firedAt, changesetId: input.changesetId, evidence: input.evidence });
}

export async function listFirings(db: DbOrTx, opts: { ruleId?: string; limit?: number } = {}) {
  return db
    .select()
    .from(monitorFirings)
    .where(and(eq(monitorFirings.orgId, DEFAULT_ORG_ID), opts.ruleId ? eq(monitorFirings.monitorRuleId, opts.ruleId) : undefined))
    .orderBy(desc(monitorFirings.firedAt))
    .limit(opts.limit ?? 50);
}

/** Firings per rule since `since`, for the settings page. */
export async function firingCounts(db: DbOrTx, since: Date): Promise<Map<string, number>> {
  const rows = await db
    .select({ ruleId: monitorFirings.monitorRuleId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(monitorFirings)
    .where(sql`${monitorFirings.firedAt} >= ${since}`)
    .groupBy(monitorFirings.monitorRuleId);
  return new Map(rows.map((r) => [r.ruleId, r.n]));
}
