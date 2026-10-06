import { FakeChatAdapter } from '@arlo/adapters/chat';
import { createAnalystAgent, createOrchestrator, MeteredModel } from '@arlo/agents';
import { say, ScriptedModel } from '@arlo/agents/testing';
import { createLogger } from '@arlo/config/logger';
import {
  createScheduledJob,
  deleteScheduledJob,
  DEFAULT_ORG_ID,
  listJobRuns,
  schema,
  setSetting,
  updateScheduledJob,
  upsertAdAccounts,
  upsertEntities,
  upsertMetricsDaily,
} from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { ALL_JOBS, createBoss, ensureQueues, Jobs, type PgBoss } from '@arlo/queue';
import { setTracingDisabled } from '@openai/agents';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScheduledJob, syncSchedules, type SchedulerDeps } from './scheduler';
import { TEMPLATES } from './templates';
import type { TemplateHandler } from './types';

setTracingDisabled(true);
const logger = createLogger({ component: 'test', level: 'silent' });
const target = { platform: 'slack' as const, channelId: 'CREPORTS' };
const M = 1_000_000;

describe('scheduler', () => {
  const t = useTestDatabase();
  let boss: PgBoss;
  let chat: FakeChatAdapter;
  let deps: SchedulerDeps;
  let account: { id: string };
  const opsNotices: string[] = [];
  const analystModel = new MeteredModel(new ScriptedModel(() => [say('- 昨日花費較前日增加，Brand 貢獻最多轉換。')]), 'analyst', 'gpt-5');

  beforeAll(async () => {
    boss = createBoss({ connectionString: t.url, logger, role: 'migrator' });
    await boss.start();
    await ensureQueues(boss, ALL_JOBS);

    chat = new FakeChatAdapter();
    const analyst = () => createAnalystAgent({ model: analystModel });
    deps = {
      db: t.db,
      chat,
      logger,
      now: () => new Date('2026-10-06T01:00:00Z'), // 09:00 Taipei
      agents: { analyst, orchestrator: () => createOrchestrator({ model: analystModel, specialists: { analyst: analyst() } }) },
      templates: TEMPLATES,
      llmBudgetUsd: 30,
      notifyOps: async (n) => void opsNotices.push(n.text),
    };

    account = (await upsertAdAccounts(t.db, [
      { orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' },
    ]))[0]!;
    const [acc] = await upsertEntities(t.db, [{ orgId: DEFAULT_ORG_ID, accountId: account!.id, kind: 'account', externalId: '1234567890' }]);
    const [brand] = await upsertEntities(t.db, [
      { orgId: DEFAULT_ORG_ID, accountId: account!.id, kind: 'campaign', externalId: '111', parentId: acc!.id, name: 'Brand', status: 'ENABLED' },
    ]);
    const row = (entityId: string, level: 'account' | 'campaign', date: string, cost: number, conversions: number) => ({
      orgId: DEFAULT_ORG_ID,
      accountId: account!.id,
      entityId,
      level,
      date,
      costMicros: cost * M,
      impressions: 1000,
      clicks: 100,
      conversions,
      convValue: conversions * 2000,
    });
    await upsertMetricsDaily(t.db, [
      row(acc!.id, 'account', '2026-10-05', 1200, 6),
      row(acc!.id, 'account', '2026-10-04', 1000, 5),
      row(acc!.id, 'account', '2026-09-28', 900, 3),
      row(brand!.id, 'campaign', '2026-10-05', 1200, 6),
    ]);
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, close: true });
  });

  const job = (overrides: Partial<Parameters<typeof createScheduledJob>[1]> = {}) =>
    createScheduledJob(t.db, {
      name: '每日報告',
      template: 'daily_report',
      cron: '0 9 * * *',
      tz: 'Asia/Taipei',
      accountIds: null,
      target,
      extraInstructions: null,
      enabled: true,
      ...overrides,
    });

  describe('syncSchedules', () => {
    it('schedules enabled jobs by key and removes disabled or deleted ones', async () => {
      const a = await job({ name: 'A' });
      const b = await job({ name: 'B', cron: '30 8 * * 1', enabled: false });
      expect(await syncSchedules({ boss, db: t.db, logger })).toEqual({ scheduled: 1, removed: 0 });
      let schedules = await boss.getSchedules(Jobs.schedulerRun.name);
      expect(schedules.map((s) => [s.key, s.cron, s.timezone, s.data])).toEqual([[a.id, '0 9 * * *', 'Asia/Taipei', { scheduledJobId: a.id, trigger: 'schedule' }]]);

      await updateScheduledJob(t.db, b.id, { enabled: true });
      await updateScheduledJob(t.db, a.id, { cron: '0 10 * * *' });
      await syncSchedules({ boss, db: t.db, logger });
      schedules = await boss.getSchedules(Jobs.schedulerRun.name);
      expect(Object.fromEntries(schedules.map((s) => [s.key, s.cron]))).toEqual({ [a.id]: '0 10 * * *', [b.id]: '30 8 * * 1' });

      await deleteScheduledJob(t.db, a.id);
      await updateScheduledJob(t.db, b.id, { enabled: false });
      expect(await syncSchedules({ boss, db: t.db, logger })).toEqual({ scheduled: 0, removed: 2 });
      expect(await boss.getSchedules(Jobs.schedulerRun.name)).toEqual([]);
    });
  });

  describe('runScheduledJob', () => {
    it('runs daily_report, posts the report to the target and records the run', async () => {
      const j = await job();
      const run = await runScheduledJob(deps, { scheduledJobId: j.id, trigger: 'schedule' }, logger);
      expect(run).toMatchObject({ status: 'succeeded', template: 'daily_report', trigger: 'schedule' });
      expect(run!.finishedAt).toBeInstanceOf(Date);

      const posted = chat.postedTo('CREPORTS').at(-1)!;
      expect(posted.message).toMatchObject({ type: 'report', title: '每日報告 · 2026-10-05' });
      const report = posted.message as Extract<typeof posted.message, { type: 'report' }>;
      expect(report.sections[0]).toEqual({ kind: 'text', text: '- 昨日花費較前日增加，Brand 貢獻最多轉換。' });
      expect(report.sections[1]).toMatchObject({
        kind: 'fields',
        heading: 'Arlo TW · 2026-10-05',
        fields: expect.arrayContaining([
          { label: '花費', value: 'NT$1,200（前日 +20.0%，上週同日 +33.3%）' },
          { label: 'CPA', value: 'NT$200' },
        ]),
      });
      expect(report.sections[2]).toMatchObject({ kind: 'table', rows: [['Brand', 'NT$1,200', '6.0', 'NT$200', '10.00', '—']] });
      expect(run!.output).toMatchObject({ changesetIds: [], messages: [{ type: 'report' }] });
      // ScriptedModel reports 100 input / 20 output tokens: 100 × 1.25 + 20 × 10 per 1M on gpt-5.
      expect(run!.costUsd).toBeCloseTo(0.000325, 6);
      const usage = await t.db.select().from(schema.llmUsage).where(eq(schema.llmUsage.refId, run!.id));
      expect(usage).toEqual([expect.objectContaining({ agent: 'analyst', refKind: 'job_run', requests: 1, inputTokens: 100, outputTokens: 20 })]);
    });

    it('pauses non-critical templates once the daily LLM budget is spent, alerting ops once', async () => {
      await setSetting(t.db, 'daily_llm_budget_usd', 0.0001);
      try {
        const j = await job({ name: 'over budget' });
        const first = await runScheduledJob(deps, { scheduledJobId: j.id, trigger: 'schedule' }, logger);
        const second = await runScheduledJob(deps, { scheduledJobId: j.id, trigger: 'schedule' }, logger);
        expect([first?.status, second?.status]).toEqual(['skipped', 'skipped']);
        expect(first!.output).toMatchObject({ run: false, reason: 'llm_budget_exceeded' });
        expect(opsNotices).toEqual([expect.stringContaining('非關鍵排程')]);

        const critical: TemplateHandler = { critical: true, run: async () => ({ messages: [], changesetIds: [] }) };
        expect(await runScheduledJob({ ...deps, templates: { daily_report: critical } }, { scheduledJobId: j.id, trigger: 'schedule' }, logger)).toMatchObject({
          status: 'succeeded',
        });
      } finally {
        await setSetting(t.db, 'daily_llm_budget_usd', 30);
      }
    });

    it('still sends the numbers when the summary cannot be written', async () => {
      const failing: SchedulerDeps = {
        ...deps,
        agents: {
          ...deps.agents,
          analyst: () =>
            createAnalystAgent({
              model: new ScriptedModel(() => {
                throw new Error('llm down');
              }),
            }),
        },
      };
      const j = await job({ name: 'no summary' });
      const run = await runScheduledJob(failing, { scheduledJobId: j.id, trigger: 'manual' }, logger);
      expect(run).toMatchObject({ status: 'succeeded', trigger: 'manual' });
      const report = chat.postedTo('CREPORTS').at(-1)!.message as { type: 'report'; sections: { text?: string }[] };
      expect(report.sections[0]!.text).toContain('摘要暫時無法產生');
    });

    it('records failures, notifies the target, and does not throw', async () => {
      const broken: TemplateHandler = { critical: false, run: () => Promise.reject(new Error('boom')) };
      const j = await job({ name: 'broken' });
      const run = await runScheduledJob({ ...deps, templates: { daily_report: broken } }, { scheduledJobId: j.id, trigger: 'schedule' }, logger);
      expect(run).toMatchObject({ status: 'failed', error: 'boom' });
      expect(chat.postedTo('CREPORTS').at(-1)!.message).toMatchObject({ type: 'notice', level: 'error', text: expect.stringContaining('boom') });
    });

    it('skips disabled jobs fired by an old schedule but runs them when triggered manually', async () => {
      const j = await job({ name: 'off', enabled: false });
      expect(await runScheduledJob(deps, { scheduledJobId: j.id, trigger: 'schedule' }, logger)).toMatchObject({ status: 'skipped' });
      expect(await runScheduledJob(deps, { scheduledJobId: j.id, trigger: 'manual' }, logger)).toMatchObject({ status: 'succeeded' });
      expect((await listJobRuns(t.db, { scheduledJobId: j.id })).map((r) => r.status)).toEqual(['succeeded', 'skipped']);
    });

    it('fails clearly for templates that are not available yet', async () => {
      const j = await job({ name: 'audit', template: 'tracking_audit' });
      expect(await runScheduledJob({ ...deps, templates: {} }, { scheduledJobId: j.id, trigger: 'manual' }, logger)).toMatchObject({
        status: 'failed',
        error: 'template tracking_audit is not available',
      });
    });
  });
});
