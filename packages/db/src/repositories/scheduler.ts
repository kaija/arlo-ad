import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { DEFAULT_ORG_ID, jobRuns, scheduledJobs } from '../schema';
import type { DbOrTx } from './upsert';

export type ScheduledJob = typeof scheduledJobs.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type ScheduledJobInput = Pick<ScheduledJob, 'name' | 'template' | 'cron' | 'tz' | 'accountIds' | 'target' | 'extraInstructions' | 'enabled'> & {
  createdBy?: string | null;
};

export function listScheduledJobs(db: DbOrTx): Promise<ScheduledJob[]> {
  return db.select().from(scheduledJobs).where(eq(scheduledJobs.orgId, DEFAULT_ORG_ID)).orderBy(scheduledJobs.name);
}

export async function getScheduledJob(db: DbOrTx, id: string): Promise<ScheduledJob | undefined> {
  const [row] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id));
  return row;
}

export async function createScheduledJob(db: DbOrTx, input: ScheduledJobInput): Promise<ScheduledJob> {
  const [row] = await db
    .insert(scheduledJobs)
    .values({ ...input, orgId: DEFAULT_ORG_ID })
    .returning();
  return row!;
}

export async function updateScheduledJob(db: DbOrTx, id: string, patch: Partial<ScheduledJobInput>): Promise<ScheduledJob | undefined> {
  const [row] = await db.update(scheduledJobs).set(patch).where(eq(scheduledJobs.id, id)).returning();
  return row;
}

export async function deleteScheduledJob(db: DbOrTx, id: string): Promise<boolean> {
  const rows = await db.delete(scheduledJobs).where(eq(scheduledJobs.id, id)).returning({ id: scheduledJobs.id });
  return rows.length === 1;
}

export async function startJobRun(
  db: DbOrTx,
  input: { scheduledJobId: string | null; template: JobRun['template']; trigger: 'schedule' | 'manual'; startedAt?: Date },
): Promise<JobRun> {
  const [row] = await db
    .insert(jobRuns)
    .values({ orgId: DEFAULT_ORG_ID, ...input })
    .returning();
  return row!;
}

export async function finishJobRun(
  db: DbOrTx,
  id: string,
  result: { status: Exclude<JobRun['status'], 'running'>; output?: unknown; error?: string | null; traceId?: string | null; costUsd?: number | null; finishedAt?: Date },
): Promise<JobRun> {
  const [row] = await db
    .update(jobRuns)
    .set({ ...result, finishedAt: result.finishedAt ?? new Date() })
    .where(and(eq(jobRuns.id, id), eq(jobRuns.status, 'running')))
    .returning();
  if (!row) throw new Error(`job run ${id} is not running`);
  return row;
}

export function listJobRuns(db: DbOrTx, opts: { scheduledJobId?: string; limit?: number } = {}): Promise<JobRun[]> {
  return db
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.orgId, DEFAULT_ORG_ID), opts.scheduledJobId ? eq(jobRuns.scheduledJobId, opts.scheduledJobId) : undefined))
    .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
    .limit(opts.limit ?? 50);
}

/** Most recent run of each scheduled job. */
export async function latestRunsByJob(db: DbOrTx): Promise<Map<string, JobRun>> {
  const rows = await db
    .selectDistinctOn([jobRuns.scheduledJobId])
    .from(jobRuns)
    .where(and(eq(jobRuns.orgId, DEFAULT_ORG_ID), isNotNull(jobRuns.scheduledJobId)))
    .orderBy(jobRuns.scheduledJobId, desc(jobRuns.startedAt), desc(jobRuns.id));
  return new Map(rows.map((r) => [r.scheduledJobId!, r]));
}

/** The chat target of the scheduled job behind a run (ChangeSet routing, Requirement 7.2). */
export async function scheduleTargetForRun(db: DbOrTx, jobRunId: string): Promise<unknown> {
  const [row] = await db
    .select({ target: scheduledJobs.target })
    .from(jobRuns)
    .innerJoin(scheduledJobs, eq(scheduledJobs.id, jobRuns.scheduledJobId))
    .where(eq(jobRuns.id, jobRunId));
  return row?.target;
}
