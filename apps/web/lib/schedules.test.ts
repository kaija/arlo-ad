import { createLogger } from '@arlo/config/logger';
import { getScheduledJob, upsertUserOnSignIn } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { ALL_JOBS, createBoss, ensureQueues, Jobs, type PgBoss } from '@arlo/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseScheduleForm, saveSchedule, setScheduleEnabled, triggerSchedule } from './schedules';

const ACC = '0199b0c2-8f1e-7a3b-9c4d-123456789abc';

function form(overrides: Record<string, string | string[] | null> = {}) {
  const values: Record<string, string | string[] | null> = {
    name: '每日報告',
    template: 'daily_report',
    cron: '0 9 * * 1-5',
    tz: 'Asia/Taipei',
    accountIds: [],
    channelId: 'C0123ABC',
    extraInstructions: '',
    enabled: 'on',
    ...overrides,
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (v === null) continue;
    for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
  }
  return fd;
}

describe('schedule form', () => {
  it('parses a valid form; no accounts means all accounts', () => {
    expect(parseScheduleForm(form({ accountIds: [ACC], enabled: null }))).toEqual({
      ok: true,
      value: { name: '每日報告', template: 'daily_report', cron: '0 9 * * 1-5', tz: 'Asia/Taipei', accountIds: [ACC], channelId: 'C0123ABC', extraInstructions: undefined, enabled: false },
    });
  });

  it.each([
    [{ cron: 'every morning' }, 'cron', '無效的 cron'],
    [{ tz: 'Mars/Base' }, 'tz', '無效的時區'],
    [{ name: '  ' }, 'name', '請輸入名稱'],
    [{ channelId: '#ads' }, 'channelId', 'channel ID'],
    [{ template: 'custom_prompt' }, 'extraInstructions', '需要指示內容'],
    [{ template: 'rm -rf' }, 'template', ''],
    [{ accountIds: ['not-a-uuid'] }, 'accountIds', ''],
  ])('rejects %j', (overrides, field, message) => {
    const result = parseScheduleForm(form(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[field as keyof typeof result.errors]).toContain(message);
  });
});

describe('saving schedules', () => {
  const t = useTestDatabase();
  let boss: PgBoss;
  let userId: string;

  beforeAll(async () => {
    boss = createBoss({ connectionString: t.url, logger: createLogger({ component: 'test', level: 'silent' }), role: 'migrator' });
    await boss.start();
    await ensureQueues(boss, ALL_JOBS);
    userId = (await upsertUserOnSignIn(t.db, { email: 'admin@example.com' })).id;
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false, close: true });
  });

  it('creates and updates schedules, asking the worker to re-sync cron each time', async () => {
    const parsed = parseScheduleForm(form());
    if (!parsed.ok) throw new Error('form should parse');
    const created = await saveSchedule(t.db, boss, { value: parsed.value, userId });
    expect(created).toMatchObject({ accountIds: null, target: { platform: 'slack', channelId: 'C0123ABC' }, createdBy: userId, enabled: true });

    const edited = parseScheduleForm(form({ cron: '30 8 * * *', accountIds: [ACC] }));
    if (!edited.ok) throw new Error('form should parse');
    await saveSchedule(t.db, boss, { id: created.id, value: edited.value, userId });
    expect(await getScheduledJob(t.db, created.id)).toMatchObject({ cron: '30 8 * * *', accountIds: [ACC] });

    await setScheduleEnabled(t.db, boss, created.id, false);
    expect((await getScheduledJob(t.db, created.id))?.enabled).toBe(false);
    expect(await boss.findJobs(Jobs.schedulerSync.name)).toHaveLength(3);

    await triggerSchedule(boss, created.id);
    expect((await boss.findJobs(Jobs.schedulerRun.name)).map((j) => j.data)).toEqual([{ scheduledJobId: created.id, trigger: 'manual' }]);
  });
});
