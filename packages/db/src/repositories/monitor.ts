// Monitor rules and firings (ADR-0017).
import { MonitorActionSchema, MonitorRuleSpecSchema, type MonitorAction, type MonitorRuleSpec } from '@arlo/core';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { DEFAULT_ORG_ID, metricsDaily, metricsHourly, monitorFirings, monitorRules } from '../schema';
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

export interface HourSlot {
  date: string;
  hour: number;
}

export interface EntityWindowTotals {
  costMicros: number;
  conversions: number;
  convValue: number;
}

/** Hourly totals per entity over the given (date, hour) slots, from metrics_hourly. */
export async function hourlyTotals(db: DbOrTx, accountId: string, level: 'campaign' | 'account', slots: readonly HourSlot[]): Promise<Map<string, EntityWindowTotals>> {
  const out = new Map<string, EntityWindowTotals>();
  if (slots.length === 0) return out;
  const dates = [...new Set(slots.map((s) => s.date))].sort();
  const wanted = new Set(slots.map((s) => `${s.date}:${s.hour}`));
  const rows = await db
    .select({ entityId: metricsHourly.entityId, date: metricsHourly.date, hour: metricsHourly.hour, cost: metricsHourly.costMicros, conv: metricsHourly.conversions, value: metricsHourly.convValue })
    .from(metricsHourly)
    .where(and(eq(metricsHourly.accountId, accountId), eq(metricsHourly.level, level), gte(metricsHourly.date, dates[0]!), lte(metricsHourly.date, dates.at(-1)!)));
  for (const r of rows) {
    if (!wanted.has(`${r.date}:${r.hour}`)) continue;
    const t = out.get(r.entityId) ?? { costMicros: 0, conversions: 0, convValue: 0 };
    t.costMicros += Number(r.cost);
    t.conversions += Number(r.conv);
    t.convValue += Number(r.value);
    out.set(r.entityId, t);
  }
  return out;
}

/** Spend per entity on one day (metrics_daily, refreshed hourly for today). */
export async function spendOn(db: DbOrTx, accountId: string, level: 'campaign' | 'account', date: string, entityIds?: readonly string[]): Promise<Map<string, number>> {
  const rows = await db
    .select({ entityId: metricsDaily.entityId, cost: metricsDaily.costMicros })
    .from(metricsDaily)
    .where(and(eq(metricsDaily.accountId, accountId), eq(metricsDaily.level, level), eq(metricsDaily.date, date), entityIds?.length ? inArray(metricsDaily.entityId, [...entityIds]) : undefined));
  return new Map(rows.map((r) => [r.entityId, Number(r.cost)]));
}
