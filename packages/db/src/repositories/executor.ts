// What the Executor reads before validating a ChangeSet (design.md「Validator」): month-to-date
// spend, campaign states, today's executed ops and recent snapshots, all from synced data.
import {
  addDays,
  changeSetView,
  type ChangeSet,
  type ChangeSetView,
  dateInTimeZone,
  entityKey,
  zonedToInstant,
  type CampaignContext,
  type CurrentField,
  type EntityKind,
  type Op,
  type ValidationContext,
} from '@arlo/core';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { changesetOpResults, changesets, entities, entitySnapshots, metricsDaily } from '../schema';
import { getUserWithBindings } from './identity';
import { listCampaigns } from './reads';
import type { AdAccount } from './sync';
import type { DbOrTx } from './upsert';

const CPA = new Set(['TARGET_CPA', 'MAXIMIZE_CONVERSIONS']);
const ROAS = new Set(['TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE']);
/** Longest MaxChangePct window the validator can look back over (rules.ts allows 31 days). */
const MAX_WINDOW_HOURS = 24 * 31;

type Snapshot = { capturedAt: Date; budgetMicros: number | null; status: string | null; bidStrategy: string | null; bidTarget: number | null };

function snapshotValue(s: Snapshot, field: string): number | undefined {
  if (field === 'budget_micros') return s.budgetMicros ?? undefined;
  if (field === 'target_cpa_micros') return s.bidStrategy && CPA.has(s.bidStrategy) ? (s.bidTarget ?? undefined) : undefined;
  if (field === 'target_roas') return s.bidStrategy && ROAS.has(s.bidStrategy) ? (s.bidTarget ?? undefined) : undefined;
  return undefined;
}

/** Start of the account's local day, as an instant. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  return zonedToInstant(`${dateInTimeZone(now, timeZone)} 00:00:00`, timeZone);
}

/** Successful ops executed since `since`, in total and per campaign entity id. */
export async function countExecutedOps(db: DbOrTx, account: AdAccount, since: Date): Promise<{ total: number; byCampaign: Map<string, number> }> {
  const rows = await db
    .select({ ops: changesets.ops, opIndex: changesetOpResults.opIndex })
    .from(changesetOpResults)
    .innerJoin(changesets, eq(changesets.id, changesetOpResults.changesetId))
    .where(and(eq(changesets.accountId, account.id), eq(changesetOpResults.ok, true), gte(changesetOpResults.createdAt, since)));
  const campaignIds = new Map(
    (await db.select({ id: entities.id, externalId: entities.externalId }).from(entities).where(and(eq(entities.accountId, account.id), eq(entities.kind, 'campaign')))).map(
      (e) => [e.externalId, e.id],
    ),
  );
  const byCampaign = new Map<string, number>();
  for (const r of rows) {
    const op = (r.ops as Op[])[r.opIndex];
    const entityId = op?.target.kind === 'campaign' ? campaignIds.get(op.target.id) : undefined;
    if (entityId) byCampaign.set(entityId, (byCampaign.get(entityId) ?? 0) + 1);
  }
  return { total: rows.length, byCampaign };
}

/** ValidationContext for `ops` on `account` at `now`. */
export async function loadValidationContext(db: DbOrTx, account: AdAccount, ops: readonly Op[], now: Date): Promise<ValidationContext> {
  const today = dateInTimeZone(now, account.timezone);
  const monthStart = `${today.slice(0, 8)}01`;
  const ref = (kind: EntityKind, id: string) => ({ platform: account.platform, accountId: account.externalId, kind, id });

  const [campaignRows, campaignSpend, accountSpend, executed] = await Promise.all([
    listCampaigns(db, [account.id]),
    db
      .select({ entityId: metricsDaily.entityId, cost: sql<number>`sum(${metricsDaily.costMicros})`.mapWith(Number) })
      .from(metricsDaily)
      .where(and(eq(metricsDaily.accountId, account.id), eq(metricsDaily.level, 'campaign'), gte(metricsDaily.date, monthStart)))
      .groupBy(metricsDaily.entityId),
    db
      .select({
        mtd: sql<number>`coalesce(sum(${metricsDaily.costMicros}) filter (where ${metricsDaily.date} >= ${monthStart}), 0)`.mapWith(Number),
        last7: sql<number>`coalesce(sum(${metricsDaily.costMicros}) filter (where ${metricsDaily.date} >= ${addDays(today, -7)} and ${metricsDaily.date} < ${today}), 0)`.mapWith(Number),
        last14: sql<number>`coalesce(sum(${metricsDaily.costMicros}) filter (where ${metricsDaily.date} >= ${addDays(today, -14)} and ${metricsDaily.date} < ${today}), 0)`.mapWith(Number),
        rows: sql<number>`count(*)`.mapWith(Number),
      })
      .from(metricsDaily)
      .where(and(eq(metricsDaily.accountId, account.id), eq(metricsDaily.level, 'account'))),
    countExecutedOps(db, account, startOfLocalDay(now, account.timezone)),
  ]);

  const spendByEntity = new Map(campaignSpend.map((r) => [r.entityId, r.cost]));
  const campaigns = new Map<string, CampaignContext>();
  for (const c of campaignRows) {
    campaigns.set(entityKey(ref('campaign', c.externalId)), {
      entityId: c.campaignId,
      status: c.status,
      budgetMicros: c.budgetMicros,
      mtdSpendMicros: spendByEntity.get(c.campaignId) ?? 0,
      bidStrategy: c.bidStrategy,
      bidTarget: c.bidTarget,
    });
  }

  // Snapshots of the touched campaigns, for MaxChangePct baselines.
  const touched = [...new Set(ops.filter((o) => o.target.kind === 'campaign').map((o) => campaigns.get(entityKey(o.target))?.entityId).filter((id): id is string => Boolean(id)))];
  const history = new Map<string, Snapshot[]>();
  if (touched.length) {
    const rows = await db
      .select({
        entityId: entitySnapshots.entityId,
        capturedAt: entitySnapshots.capturedAt,
        budgetMicros: entitySnapshots.budgetMicros,
        status: entitySnapshots.status,
        bidStrategy: entitySnapshots.bidStrategy,
        bidTarget: entitySnapshots.bidTarget,
      })
      .from(entitySnapshots)
      .where(and(inArray(entitySnapshots.entityId, touched), gte(entitySnapshots.capturedAt, new Date(now.getTime() - (MAX_WINDOW_HOURS + 1) * 3_600_000))))
      .orderBy(asc(entitySnapshots.capturedAt));
    for (const r of rows) history.set(r.entityId, [...(history.get(r.entityId) ?? []), r]);
  }

  const [spend] = accountSpend;
  return {
    accountId: account.id,
    currency: account.currency,
    today,
    mtdSpendMicros: spend && spend.rows > 0 ? spend.mtd : null,
    campaigns,
    mutationsToday: executed.total,
    mutationsTodayByCampaign: executed.byCampaign,
    valueAt: (key: string, field: string, windowHours: number) => {
      const entityId = campaigns.get(key)?.entityId;
      const list = entityId ? history.get(entityId) : undefined;
      if (!list?.length) return undefined;
      const at = now.getTime() - windowHours * 3_600_000;
      // The value in effect `windowHours` ago: the last snapshot captured at or before then.
      const snap = list.filter((s) => s.capturedAt.getTime() <= at).at(-1);
      return snap ? snapshotValue(snap, field as CurrentField) : undefined;
    },
    avgDailySpend7dMicros: spend && spend.rows > 0 ? spend.last7 / 7 : null,
    avgDailySpend14dMicros: spend && spend.rows > 0 ? spend.last14 / 14 : null,
  };
}

/** Display names of the op targets, keyed by entityKey (for chat cards). */
export async function loadOpTargetNames(db: DbOrTx, account: AdAccount, ops: readonly Op[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byKind = new Map<EntityKind, Set<string>>();
  for (const op of ops) byKind.set(op.target.kind, (byKind.get(op.target.kind) ?? new Set()).add(op.target.id));
  for (const [kind, ids] of byKind) {
    const rows = await db
      .select({ externalId: entities.externalId, name: entities.name })
      .from(entities)
      .where(and(eq(entities.accountId, account.id), eq(entities.kind, kind), inArray(entities.externalId, [...ids])));
    for (const r of rows) {
      if (r.name) out.set(entityKey({ platform: account.platform, accountId: account.externalId, kind, id: r.externalId }), r.name);
    }
  }
  return out;
}

/** The card view of a ChangeSet: entity names, requester name, optional outcome. */
export async function loadChangeSetView(db: DbOrTx, cs: ChangeSet, account: AdAccount, outcome?: ChangeSetView['outcome']): Promise<ChangeSetView> {
  const [names, requester] = await Promise.all([
    loadOpTargetNames(db, account, cs.ops),
    cs.requestedBy.userId ? getUserWithBindings(db, cs.requestedBy.userId) : undefined,
  ]);
  const requestedBy = requester ? (requester.displayName ?? requester.googleEmail) : cs.requestedBy.kind === 'agent' ? 'Arlo' : cs.requestedBy.kind === 'system' ? '系統' : undefined;
  return changeSetView(cs, { accountName: account.name, currency: account.currency, names, requestedBy, outcome });
}
