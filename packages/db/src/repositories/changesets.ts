// ChangeSet persistence (ADR-0006). Status changes go through applyTransition: the pure
// transition() computes the next state, the UPDATE only lands if the status is still what the
// caller saw (compare-and-set, Requirement 6.6), and every change is audited in the same
// transaction (Requirement 3.6).
import {
  DEFAULT_TIER_THRESHOLDS,
  RuleSpecSchema,
  transition,
  type ChangeSet,
  type ChangeSetEvent,
  type ChangeSetSource,
  type ChangeSetStatus,
  type Op,
  type OpResult,
  type RuleInstance,
  type TierThresholds,
  type Violation,
} from '@arlo/core';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { approvalMessages, auditLog, changesetOpResults, changesets, DEFAULT_ORG_ID, rules, tierThresholds } from '../schema';
import type { Db } from '../client';
import type { DbOrTx } from './upsert';

type Row = typeof changesets.$inferSelect;

export interface Actor {
  kind: 'user' | 'agent' | 'system';
  id?: string | null;
}

export function toChangeSet(row: Row): ChangeSet {
  return {
    id: row.id,
    orgId: row.orgId,
    platform: row.platform,
    accountId: row.accountId,
    feature: row.feature,
    source: row.source as ChangeSetSource,
    ops: row.ops as Op[],
    summary: row.summary,
    rationale: row.rationale,
    tier: row.tier as ChangeSet['tier'],
    status: row.status,
    violations: row.violations as Violation[],
    requestedBy: { kind: row.requestedByKind as ChangeSet['requestedBy']['kind'], userId: row.requestedByUserId },
    approvedBy: row.approvedBy,
    expiresAt: row.expiresAt,
    revertOf: row.revertOf,
    traceId: row.traceId,
    excludedOps: row.excludedOps,
    createdAt: row.createdAt,
    executedAt: row.executedAt,
  };
}

export type StoredChangeSet = ChangeSet & { statusReason: string | null; updatedAt: Date };

const stored = (row: Row): StoredChangeSet => ({ ...toChangeSet(row), statusReason: row.statusReason, updatedAt: row.updatedAt });

export async function writeAudit(
  db: DbOrTx,
  entry: { actor: Actor; entityKind: string; entityId: string; action: string; fromStatus?: string | null; toStatus?: string | null; payload?: unknown },
): Promise<void> {
  await db.insert(auditLog).values({
    orgId: DEFAULT_ORG_ID,
    actorKind: entry.actor.kind,
    actorId: entry.actor.id ?? null,
    entityKind: entry.entityKind,
    entityId: entry.entityId,
    action: entry.action,
    fromStatus: entry.fromStatus ?? null,
    toStatus: entry.toStatus ?? null,
    payload: entry.payload ?? null,
  });
}

export interface NewChangeSet {
  accountId: string;
  feature?: ChangeSet['feature'];
  source: ChangeSetSource;
  ops: Op[];
  summary: string;
  rationale?: string | null;
  requestedBy: ChangeSet['requestedBy'];
  revertOf?: string | null;
  traceId?: string | null;
}

/** Inserts in PENDING_VALIDATION and audits the creation. Pass a transaction to enqueue with it. */
export async function insertChangeSet(db: DbOrTx, input: NewChangeSet): Promise<StoredChangeSet> {
  if (input.ops.length === 0) throw new Error('a ChangeSet needs at least one op (Tier 0 creates none)');
  const [row] = await db
    .insert(changesets)
    .values({
      orgId: DEFAULT_ORG_ID,
      platform: 'google_ads',
      accountId: input.accountId,
      feature: input.feature ?? null,
      sourceKind: input.source.kind,
      source: input.source,
      ops: input.ops,
      summary: input.summary,
      rationale: input.rationale ?? null,
      requestedByKind: input.requestedBy.kind,
      requestedByUserId: input.requestedBy.userId ?? null,
      revertOf: input.revertOf ?? null,
      traceId: input.traceId ?? null,
    })
    .returning();
  await writeAudit(db, {
    actor: { kind: input.requestedBy.kind, id: input.requestedBy.userId },
    entityKind: 'changeset',
    entityId: row!.id,
    action: 'create',
    toStatus: row!.status,
    payload: { source: input.source, opCount: input.ops.length, revertOf: input.revertOf ?? null },
  });
  return stored(row!);
}

export async function getChangeSet(db: DbOrTx, id: string): Promise<StoredChangeSet | undefined> {
  const [row] = await db.select().from(changesets).where(eq(changesets.id, id));
  return row ? stored(row) : undefined;
}

export type TransitionResult = { ok: true; changeset: StoredChangeSet } | { ok: false; current: StoredChangeSet | undefined };

/**
 * Applies `event` to the ChangeSet as the caller last saw it. Fails without changes when someone
 * else moved it first (the caller re-reads `current`). Throws IllegalTransitionError for events
 * the state machine does not allow from the observed status.
 */
export async function applyTransition(
  db: Db,
  seen: ChangeSet,
  event: ChangeSetEvent,
  actor: Actor,
  opts: { reason?: string | null; payload?: Record<string, unknown> } = {},
): Promise<TransitionResult> {
  const next = transition(seen, event);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(changesets)
      .set({
        status: next.status,
        tier: next.tier,
        violations: next.violations,
        expiresAt: next.expiresAt ?? null,
        approvedBy: next.approvedBy ?? null,
        executedAt: next.executedAt ?? null,
        statusReason: opts.reason ?? null,
      })
      .where(and(eq(changesets.id, seen.id), eq(changesets.status, seen.status)))
      .returning();
    if (!row) return { ok: false as const, current: await getChangeSet(tx, seen.id) };
    await writeAudit(tx, {
      actor,
      entityKind: 'changeset',
      entityId: seen.id,
      action: event.type,
      fromStatus: seen.status,
      toStatus: next.status,
      payload: { ...opts.payload, ...(opts.reason ? { reason: opts.reason } : {}), ...('tier' in event ? { tier: event.tier } : {}) },
    });
    return { ok: true as const, changeset: stored(row) };
  });
}

export async function recordOpResults(db: DbOrTx, changesetId: string, results: readonly OpResult[]): Promise<void> {
  if (results.length === 0) return;
  await db
    .insert(changesetOpResults)
    .values(results.map((r) => ({ orgId: DEFAULT_ORG_ID, changesetId, opIndex: r.index, ok: r.ok, error: r.error ?? null, resourceName: r.resourceName ?? null })))
    .onConflictDoNothing();
}

export function listOpResults(db: DbOrTx, changesetId: string) {
  return db.select().from(changesetOpResults).where(eq(changesetOpResults.changesetId, changesetId)).orderBy(asc(changesetOpResults.opIndex));
}

export interface ChangeSetFilter {
  statuses?: readonly ChangeSetStatus[];
  tiers?: readonly number[];
  accountIds?: readonly string[] | null;
  limit?: number;
  before?: Date;
}

export async function listChangeSets(db: DbOrTx, f: ChangeSetFilter = {}): Promise<StoredChangeSet[]> {
  const where: (SQL | undefined)[] = [
    eq(changesets.orgId, DEFAULT_ORG_ID),
    f.statuses?.length ? inArray(changesets.status, [...f.statuses]) : undefined,
    f.tiers?.length ? inArray(changesets.tier, [...f.tiers]) : undefined,
    f.accountIds ? (f.accountIds.length ? inArray(changesets.accountId, [...f.accountIds]) : sql`false`) : undefined,
    f.before ? lt(changesets.createdAt, f.before) : undefined,
  ];
  const rows = await db
    .select()
    .from(changesets)
    .where(and(...where))
    .orderBy(desc(changesets.createdAt), desc(changesets.id))
    .limit(f.limit ?? 50);
  return rows.map(stored);
}

/** ChangeSets of an account executed in [from, to) (trend markers, Requirement 18.2). */
export async function listExecutedChangeSets(db: DbOrTx, accountId: string, from: Date, to: Date): Promise<StoredChangeSet[]> {
  const rows = await db
    .select()
    .from(changesets)
    .where(and(eq(changesets.accountId, accountId), sql`${changesets.executedAt} >= ${from}`, lt(changesets.executedAt, to)))
    .orderBy(asc(changesets.executedAt));
  return rows.map(stored);
}

/** PENDING_APPROVAL ChangeSets past their expiry. */
export async function listExpiredPending(db: DbOrTx, now: Date): Promise<StoredChangeSet[]> {
  const rows = await db
    .select()
    .from(changesets)
    .where(and(eq(changesets.status, 'PENDING_APPROVAL'), lt(changesets.expiresAt, now)));
  return rows.map(stored);
}

/** Ops executed today (since `since`) for MaxMutationsPerDay. */
export async function countExecutedOpsSince(db: DbOrTx, accountId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(changesetOpResults)
    .innerJoin(changesets, eq(changesets.id, changesetOpResults.changesetId))
    .where(and(eq(changesets.accountId, accountId), eq(changesetOpResults.ok, true), sql`${changesetOpResults.createdAt} >= ${since}`));
  return row?.n ?? 0;
}

export function listAudit(db: DbOrTx, entityKind: string, entityId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityKind, entityKind), eq(auditLog.entityId, entityId)))
    .orderBy(asc(auditLog.at), asc(auditLog.id));
}

// --- approval messages (Requirement 7.4) -----------------------------------------------

export type ApprovalMessage = typeof approvalMessages.$inferSelect;

export async function addApprovalMessage(
  db: DbOrTx,
  input: { changesetId: string; channelId: string; messageId: string; threadId?: string | null; kind: ApprovalMessage['kind'] },
): Promise<void> {
  await db
    .insert(approvalMessages)
    .values({ orgId: DEFAULT_ORG_ID, changesetId: input.changesetId, channelId: input.channelId, messageId: input.messageId, threadId: input.threadId ?? null, kind: input.kind })
    .onConflictDoNothing();
}

export function listApprovalMessages(db: DbOrTx, changesetId: string): Promise<ApprovalMessage[]> {
  return db.select().from(approvalMessages).where(eq(approvalMessages.changesetId, changesetId)).orderBy(asc(approvalMessages.createdAt));
}

export async function findChangeSetByMessage(db: DbOrTx, channelId: string, messageId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: approvalMessages.changesetId })
    .from(approvalMessages)
    .where(and(eq(approvalMessages.channelId, channelId), eq(approvalMessages.messageId, messageId)));
  return row?.id;
}

// --- rules and thresholds ----------------------------------------------------------------

export type RuleRow = typeof rules.$inferSelect;

export function toRuleInstance(row: RuleRow): RuleInstance {
  const spec = RuleSpecSchema.parse(row.spec);
  const scope: RuleInstance['scope'] =
    row.scopeKind === 'org'
      ? { kind: 'org' }
      : row.scopeKind === 'account'
        ? { kind: 'account', accountId: row.accountId! }
        : { kind: 'campaign', accountId: row.accountId!, campaignEntityId: row.campaignEntityId! };
  return { id: row.id, scope, spec, severity: row.severity, enabled: row.enabled };
}

/** Org rules plus the account's own (account and campaign scope). */
export async function loadRules(db: DbOrTx, accountId: string): Promise<RuleInstance[]> {
  const rows = await db
    .select()
    .from(rules)
    .where(and(eq(rules.orgId, DEFAULT_ORG_ID), or(eq(rules.scopeKind, 'org'), eq(rules.accountId, accountId))));
  return rows.map(toRuleInstance);
}

export function listAllRules(db: DbOrTx): Promise<RuleRow[]> {
  return db.select().from(rules).where(eq(rules.orgId, DEFAULT_ORG_ID)).orderBy(asc(rules.createdAt));
}

export async function getRule(db: DbOrTx, id: string): Promise<RuleRow | undefined> {
  const [row] = await db.select().from(rules).where(and(eq(rules.orgId, DEFAULT_ORG_ID), eq(rules.id, id)));
  return row;
}

export interface RuleWrite {
  scopeKind: RuleRow['scopeKind'];
  accountId: string | null;
  campaignEntityId: string | null;
  spec: unknown;
  severity: RuleRow['severity'];
  enabled: boolean;
}

/** Creates or updates a rule (spec validated against RuleSpecSchema) and audits it. */
export async function saveRule(db: Db, input: RuleWrite & { id?: string }, actor: Actor): Promise<RuleRow> {
  const spec = RuleSpecSchema.parse(input.spec);
  return db.transaction(async (tx) => {
    const values = { scopeKind: input.scopeKind, accountId: input.accountId, campaignEntityId: input.campaignEntityId, spec, severity: input.severity, enabled: input.enabled };
    const [row] = input.id
      ? await tx.update(rules).set(values).where(and(eq(rules.orgId, DEFAULT_ORG_ID), eq(rules.id, input.id))).returning()
      : await tx.insert(rules).values({ ...values, orgId: DEFAULT_ORG_ID, createdBy: actor.id ?? null }).returning();
    if (!row) throw new Error(`rule ${input.id} not found`);
    await writeAudit(tx, { actor, entityKind: 'rule', entityId: row.id, action: input.id ? 'update' : 'create', payload: values });
    return row;
  });
}

export async function deleteRule(db: Db, id: string, actor: Actor): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(rules).where(and(eq(rules.orgId, DEFAULT_ORG_ID), eq(rules.id, id))).returning();
    if (row) await writeAudit(tx, { actor, entityKind: 'rule', entityId: id, action: 'delete', payload: { spec: row.spec, scopeKind: row.scopeKind, accountId: row.accountId } });
    return Boolean(row);
  });
}

export type TierThresholdRow = typeof tierThresholds.$inferSelect;

export function listTierThresholds(db: DbOrTx): Promise<TierThresholdRow[]> {
  return db.select().from(tierThresholds).where(eq(tierThresholds.orgId, DEFAULT_ORG_ID)).orderBy(asc(tierThresholds.createdAt));
}

/** Sets the org default (accountId null) or an account override, audited. */
export async function setTierThresholds(db: Db, accountId: string | null, t: TierThresholds, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const values = { tier3Pct: t.tier3Pct, tier3AmountMicros: t.tier3AmountMicros, tier1MaxReducePct: t.tier1MaxReducePct };
    const where = and(eq(tierThresholds.orgId, DEFAULT_ORG_ID), accountId ? eq(tierThresholds.accountId, accountId) : isNull(tierThresholds.accountId));
    const updated = await tx.update(tierThresholds).set(values).where(where).returning({ id: tierThresholds.id });
    const id = updated[0]?.id ?? (await tx.insert(tierThresholds).values({ ...values, orgId: DEFAULT_ORG_ID, accountId }).returning({ id: tierThresholds.id }))[0]!.id;
    await writeAudit(tx, { actor, entityKind: 'tier_thresholds', entityId: id, action: 'set', payload: { accountId, ...values } });
  });
}

/** Removes an account override so the org default applies again. */
export async function clearTierThresholds(db: Db, accountId: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.delete(tierThresholds).where(and(eq(tierThresholds.orgId, DEFAULT_ORG_ID), eq(tierThresholds.accountId, accountId))).returning();
    if (row) await writeAudit(tx, { actor, entityKind: 'tier_thresholds', entityId: row.id, action: 'clear', payload: { accountId } });
  });
}

/** Account thresholds, else the org default, else the built-in default. */
export async function loadTierThresholds(db: DbOrTx, accountId: string): Promise<TierThresholds> {
  const rows = await db
    .select()
    .from(tierThresholds)
    .where(and(eq(tierThresholds.orgId, DEFAULT_ORG_ID), or(isNull(tierThresholds.accountId), eq(tierThresholds.accountId, accountId))));
  const row = rows.find((r) => r.accountId === accountId) ?? rows.find((r) => r.accountId === null);
  return row ? { tier3Pct: row.tier3Pct, tier3AmountMicros: row.tier3AmountMicros, tier1MaxReducePct: row.tier1MaxReducePct } : DEFAULT_TIER_THRESHOLDS;
}

/**
 * Includes or excludes one op of a pending batch (Requirement 14.5). Only while
 * PENDING_APPROVAL; returns the updated ChangeSet, or undefined when it is no longer pending.
 */
export async function setOpExcluded(db: DbOrTx, id: string, opIndex: number, excluded: boolean, actor: Actor): Promise<StoredChangeSet | undefined> {
  const [row] = await db
    .update(changesets)
    .set({
      excludedOps: excluded
        ? sql`(select coalesce(array_agg(distinct x order by x), '{}') from unnest(array_append(${changesets.excludedOps}, ${opIndex}::int)) x)`
        : sql`array_remove(${changesets.excludedOps}, ${opIndex}::int)`,
    })
    .where(and(eq(changesets.id, id), eq(changesets.status, 'PENDING_APPROVAL'), sql`${opIndex} >= 0 and ${opIndex} < jsonb_array_length(${changesets.ops})`))
    .returning();
  if (!row) return undefined;
  await writeAudit(db, { actor, entityKind: 'changeset', entityId: id, action: excluded ? 'exclude_op' : 'include_op', payload: { opIndex } });
  return stored(row);
}

// --- approval SLA (Requirement 7.5) ------------------------------------------------------

/** PENDING_APPROVAL ChangeSets created before `before` that have not been reminded yet. */
export async function listSlaOverdue(db: DbOrTx, before: Date): Promise<StoredChangeSet[]> {
  const rows = await db
    .select()
    .from(changesets)
    .where(and(eq(changesets.status, 'PENDING_APPROVAL'), isNull(changesets.slaRemindedAt), lt(changesets.createdAt, before)))
    .orderBy(asc(changesets.createdAt));
  return rows.map(stored);
}

/** Claims the one SLA reminder of a ChangeSet; false when it was already sent or claimed. */
export async function claimSlaReminder(db: DbOrTx, id: string, at: Date): Promise<boolean> {
  const rows = await db
    .update(changesets)
    .set({ slaRemindedAt: at })
    .where(and(eq(changesets.id, id), eq(changesets.status, 'PENDING_APPROVAL'), isNull(changesets.slaRemindedAt)))
    .returning({ id: changesets.id });
  return rows.length === 1;
}
