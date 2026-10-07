// Campaign tasks and drafts (ADR-0020).
import { CampaignBriefSchema, CampaignDraftSchema, type CampaignBrief, type CampaignDraft, type CampaignTaskStatus } from '@arlo/core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { campaignDrafts, campaignTasks, DEFAULT_ORG_ID } from '../schema';
import type { DbOrTx } from './upsert';

export type CampaignTaskRow = typeof campaignTasks.$inferSelect;
export type CampaignDraftRow = typeof campaignDrafts.$inferSelect;

export interface CampaignTask extends Omit<CampaignTaskRow, 'brief'> {
  brief: CampaignBrief;
}

const task = (r: CampaignTaskRow): CampaignTask => ({ ...r, brief: CampaignBriefSchema.parse(r.brief) });

export async function createCampaignTask(db: DbOrTx, input: { accountId: string; brief: CampaignBrief; createdBy: string | null }): Promise<CampaignTask> {
  const [row] = await db.insert(campaignTasks).values({ orgId: DEFAULT_ORG_ID, accountId: input.accountId, brief: CampaignBriefSchema.parse(input.brief), createdBy: input.createdBy }).returning();
  return task(row!);
}

export async function getCampaignTask(db: DbOrTx, id: string): Promise<CampaignTask | undefined> {
  const [row] = await db.select().from(campaignTasks).where(eq(campaignTasks.id, id));
  return row ? task(row) : undefined;
}

export async function listCampaignTasks(db: DbOrTx, accountIds: readonly string[] | null, limit = 50): Promise<CampaignTask[]> {
  const rows = await db
    .select()
    .from(campaignTasks)
    .where(and(eq(campaignTasks.orgId, DEFAULT_ORG_ID), accountIds ? (accountIds.length ? inArray(campaignTasks.accountId, [...accountIds]) : sql`false`) : undefined))
    .orderBy(desc(campaignTasks.createdAt))
    .limit(limit);
  return rows.map(task);
}

/** Moves a task to `to` only from one of `from`; returns the task, or undefined if it was not there. */
export async function setCampaignTaskStatus(db: DbOrTx, id: string, from: readonly CampaignTaskStatus[], to: CampaignTaskStatus, extra: { error?: string | null; traceId?: string | null } = {}): Promise<CampaignTask | undefined> {
  const [row] = await db
    .update(campaignTasks)
    .set({ status: to, ...(extra.error !== undefined ? { error: extra.error } : {}), ...(extra.traceId !== undefined ? { traceId: extra.traceId } : {}) })
    .where(and(eq(campaignTasks.id, id), inArray(campaignTasks.status, [...from])))
    .returning();
  return row ? task(row) : undefined;
}

export interface StoredDraft extends Omit<CampaignDraftRow, 'draft'> {
  draft: CampaignDraft;
}

const draftOf = (r: CampaignDraftRow): StoredDraft => ({ ...r, draft: CampaignDraftSchema.parse(r.draft) });

/** Stores the next version of a task's draft. */
export async function saveCampaignDraft(db: DbOrTx, input: { taskId: string; draft: CampaignDraft; lintIssues: unknown[]; origin: string; createdBy?: string | null }): Promise<StoredDraft> {
  const [last] = await db.select({ version: campaignDrafts.version }).from(campaignDrafts).where(eq(campaignDrafts.taskId, input.taskId)).orderBy(desc(campaignDrafts.version)).limit(1);
  const [row] = await db
    .insert(campaignDrafts)
    .values({ orgId: DEFAULT_ORG_ID, taskId: input.taskId, version: (last?.version ?? 0) + 1, draft: CampaignDraftSchema.parse(input.draft), lintIssues: input.lintIssues, origin: input.origin, createdBy: input.createdBy ?? null })
    .returning();
  return draftOf(row!);
}

export async function latestCampaignDraft(db: DbOrTx, taskId: string): Promise<StoredDraft | undefined> {
  const [row] = await db.select().from(campaignDrafts).where(eq(campaignDrafts.taskId, taskId)).orderBy(desc(campaignDrafts.version)).limit(1);
  return row ? draftOf(row) : undefined;
}

export function listCampaignDraftVersions(db: DbOrTx, taskId: string) {
  return db
    .select({ id: campaignDrafts.id, version: campaignDrafts.version, origin: campaignDrafts.origin, createdAt: campaignDrafts.createdAt, changesetId: campaignDrafts.changesetId })
    .from(campaignDrafts)
    .where(eq(campaignDrafts.taskId, taskId))
    .orderBy(desc(campaignDrafts.version));
}

export async function setDraftChangeSet(db: DbOrTx, draftId: string, changesetId: string): Promise<void> {
  await db.update(campaignDrafts).set({ changesetId }).where(eq(campaignDrafts.id, draftId));
}

export async function setDraftPolicyStatus(db: DbOrTx, draftId: string, policyStatus: unknown): Promise<void> {
  await db.update(campaignDrafts).set({ policyStatus }).where(eq(campaignDrafts.id, draftId));
}
