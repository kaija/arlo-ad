// Scheduled jobs (ADR-0016, Requirement 11): scheduled_jobs rows drive pg-boss cron entries on
// the scheduler.run queue (one schedule key per job); every execution writes a job_run.
import type { ChatAdapter } from '@arlo/adapters/chat';
import { runGuard, trackedRun } from '@arlo/agents';
import type { Logger } from '@arlo/config/logger';
import { ConversationRefSchema, type ChatMessage } from '@arlo/core';
import {
  finishJobRun,
  getScheduledJob,
  listActiveAccounts,
  listScheduledJobs,
  startJobRun,
  type Db,
  type JobRun,
} from '@arlo/db';
import { defineJob, Jobs, type JobData, type PgBoss } from '@arlo/queue';
import type { AgentFactories, TemplateContext, TemplateHandler } from './types';

export interface SchedulerDeps {
  db: Db;
  chat: ChatAdapter;
  logger: Logger;
  now: () => Date;
  agents: AgentFactories;
  templates: Partial<Record<JobRun['template'], TemplateHandler>>;
  /** DAILY_LLM_BUDGET_USD (the daily_llm_budget_usd setting overrides it). */
  llmBudgetUsd: number;
  notifyOps: (notice: { level: 'info' | 'warn' | 'error'; text: string }) => Promise<void>;
  /** Proposer for templates that may suggest changes (custom_prompt, sweeps). */
  propose?: TemplateContext['propose'];
}

/** Makes pg-boss cron match scheduled_jobs: enabled jobs scheduled, everything else removed. */
export async function syncSchedules({ boss, db, logger }: { boss: PgBoss; db: Db; logger: Logger }): Promise<{ scheduled: number; removed: number }> {
  const jobs = await listScheduledJobs(db);
  const enabled = jobs.filter((j) => j.enabled);
  for (const job of enabled) {
    await boss.schedule(Jobs.schedulerRun.name, job.cron, { scheduledJobId: job.id, trigger: 'schedule' }, { tz: job.tz, key: job.id });
  }
  const keep = new Set(enabled.map((j) => j.id));
  let removed = 0;
  for (const s of await boss.getSchedules(Jobs.schedulerRun.name)) {
    if (!keep.has(s.key)) {
      await boss.unschedule(Jobs.schedulerRun.name, s.key);
      removed++;
    }
  }
  logger.info({ scheduled: enabled.length, removed }, 'schedules synced');
  return { scheduled: enabled.length, removed };
}

function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).slice(0, 500);
}

export async function runScheduledJob(deps: SchedulerDeps, data: JobData<typeof Jobs.schedulerRun>, logger: Logger): Promise<JobRun | null> {
  const { db, chat } = deps;
  const job = await getScheduledJob(db, data.scheduledJobId);
  if (!job) {
    logger.warn({ scheduledJobId: data.scheduledJobId }, 'scheduled job no longer exists');
    return null;
  }
  const trigger = data.trigger ?? 'schedule';
  const run = await startJobRun(db, { scheduledJobId: job.id, template: job.template, trigger, startedAt: deps.now() });
  const log = logger.child({ job_run_id: run.id, template: job.template });

  if (!job.enabled && trigger === 'schedule') {
    return finishJobRun(db, run.id, { status: 'skipped', output: { reason: 'disabled' }, finishedAt: deps.now() });
  }
  const target = ConversationRefSchema.safeParse(job.target);
  if (!target.success) {
    return finishJobRun(db, run.id, { status: 'failed', error: 'invalid target', finishedAt: deps.now() });
  }
  const handler = deps.templates[job.template];
  if (!handler) {
    await chat.post(target.data, { type: 'notice', level: 'warn', text: `排程「${job.name}」的模板 ${job.template} 尚未提供。` }).catch(() => undefined);
    return finishJobRun(db, run.id, { status: 'failed', error: `template ${job.template} is not available`, finishedAt: deps.now() });
  }

  // Non-critical templates pause once today's LLM budget is spent (Requirement 19.3).
  const budget = await runGuard({
    db,
    defaultBudgetUsd: deps.llmBudgetUsd,
    critical: handler.critical,
    now: deps.now,
    notify: (d) =>
      deps.notifyOps({
        level: 'warn',
        text: `今日 LLM 成本 US$${d.spentUsd.toFixed(2)} 已達預算 US$${d.budgetUsd.toFixed(2)}，非關鍵排程（報告、擴展類、custom_prompt）暫停至明日；Monitor 與 Executor 不受影響。`,
      }),
  });
  if (!budget.run) {
    return finishJobRun(db, run.id, { status: 'skipped', output: budget, finishedAt: deps.now() });
  }

  const active = await listActiveAccounts(db, 'google_ads');
  const accounts = job.accountIds ? active.filter((a) => job.accountIds!.includes(a.id)) : active;
  try {
    const tracked = await trackedRun(
      { db, name: `job.${job.template}`, ref: { kind: 'job_run', id: run.id }, metadata: { scheduled_job_id: job.id }, now: deps.now },
      (traceId) => handler.run({ db, logger: log, now: deps.now, agents: deps.agents, job, run, accounts, traceId, propose: deps.propose }),
    );
    const result = tracked.result;
    const posted: ChatMessage[] = [];
    for (const message of result.messages) {
      await chat.post(target.data, message);
      posted.push(message);
    }
    return await finishJobRun(db, run.id, {
      status: 'succeeded',
      output: { messages: posted, changesetIds: result.changesetIds },
      traceId: tracked.traceId,
      costUsd: tracked.costUsd,
      finishedAt: deps.now(),
    });
  } catch (err) {
    log.error({ err }, 'scheduled job failed');
    await chat
      .post(target.data, { type: 'notice', level: 'error', text: `排程「${job.name}」執行失敗：${errorText(err)}` })
      .catch((postErr) => log.error({ err: postErr }, 'failed to report job failure'));
    return finishJobRun(db, run.id, { status: 'failed', error: errorText(err), finishedAt: deps.now() });
  }
}

export function schedulerJobs(deps: SchedulerDeps & { boss: PgBoss }) {
  return [
    defineJob(Jobs.schedulerRun, (data, ctx) => runScheduledJob(deps, data, ctx.logger).then((r) => ({ jobRunId: r?.id ?? null, status: r?.status ?? null }))),
    defineJob(Jobs.schedulerSync, (_data, ctx) => syncSchedules({ boss: deps.boss, db: deps.db, logger: ctx.logger })),
  ];
}
