import { createLogger } from '@arlo/config/logger';
import type { CampaignDraft } from '@arlo/core';
import { DEFAULT_ORG_ID, getCampaignTask, latestCampaignDraft, listCampaignDraftVersions, listCampaignTasks, saveCampaignDraft, setCampaignTaskStatus, upsertAdAccounts } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { ALL_JOBS, createBoss, ensureQueues, Jobs, type PgBoss } from '@arlo/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseBriefForm, submitBrief, type BriefFormValues } from './campaigns';

const ACC = '0199b0c2-8f1e-7a3b-9c4d-123456789abc';
const values = (over: Partial<BriefFormValues> = {}): BriefFormValues => ({
  accountId: ACC,
  name: 'Arlo Pro 6 預購',
  objective: '新品預購',
  offering: '2K 無線監視器',
  landingPageUrl: 'https://www.arlo.com/pro6',
  audience: '',
  locations: '台灣，香港',
  languages: 'zh-TW, en',
  dailyBudget: '1,500',
  notes: '',
  ...over,
});

describe('parseBriefForm', () => {
  it('parses lists, money and blanks', () => {
    expect(parseBriefForm(values(), [ACC])).toEqual({
      ok: true,
      accountId: ACC,
      brief: { name: 'Arlo Pro 6 預購', objective: '新品預購', offering: '2K 無線監視器', landingPageUrl: 'https://www.arlo.com/pro6', audience: null, locations: ['台灣', '香港'], languages: ['zh-TW', 'en'], dailyBudget: 1500, notes: null },
    });
  });

  it('reports errors per field', () => {
    expect(parseBriefForm(values({ accountId: 'x', landingPageUrl: 'http://insecure', dailyBudget: '-1', locations: ' ' }), [ACC])).toEqual({
      ok: false,
      errors: { accountId: expect.any(String), landingPageUrl: expect.stringContaining('https'), dailyBudget: expect.any(String), locations: '至少一項' },
    });
  });
});

describe('campaign tasks', () => {
  const t = useTestDatabase();
  let boss: PgBoss;

  beforeAll(async () => {
    boss = createBoss({ connectionString: t.url, logger: createLogger({ component: 'test', level: 'silent' }), role: 'migrator' });
    await boss.start();
    await ensureQueues(boss, ALL_JOBS);
  });
  afterAll(() => boss.stop({ graceful: false, close: true }));

  it('creates a queued task with its job, then stores draft versions', async () => {
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    const parsed = parseBriefForm(values({ accountId: acc!.id }), [acc!.id]);
    if (!parsed.ok) throw new Error('brief');
    const task = await submitBrief(t.db, boss, { accountId: acc!.id, brief: parsed.brief, userId: null });
    expect(task).toMatchObject({ status: 'queued', brief: { name: 'Arlo Pro 6 預購' } });
    expect((await boss.findJobs(Jobs.campaignGenerate.name)).map((j) => j.data)).toEqual([{ taskId: task.id }]);
    expect(await listCampaignTasks(t.db, [])).toEqual([]);

    expect(await setCampaignTaskStatus(t.db, task.id, ['draft'], 'submitted')).toBeUndefined();
    expect(await setCampaignTaskStatus(t.db, task.id, ['queued'], 'running')).toMatchObject({ status: 'running' });
    const draft: CampaignDraft = {
      campaign: { name: 'x', dailyBudget: 1500, biddingStrategy: 'MAXIMIZE_CONVERSIONS', targetCpa: null, locations: ['台灣'], languages: ['zh-TW'] },
      adGroups: [{ name: 'g', keywords: [{ text: 'arlo pro 6', matchType: 'PHRASE' }], ads: [{ headlines: ['a', 'b', 'c'], descriptions: ['d', 'e'], finalUrl: 'https://www.arlo.com/pro6', path1: null, path2: null }] }],
      negativeKeywords: [],
      rationale: 'r',
    };
    await saveCampaignDraft(t.db, { taskId: task.id, draft, lintIssues: [], origin: 'generate' });
    await saveCampaignDraft(t.db, { taskId: task.id, draft: { ...draft, rationale: 'edited' }, lintIssues: [], origin: 'edit' });
    expect((await latestCampaignDraft(t.db, task.id))?.draft.rationale).toBe('edited');
    expect((await listCampaignDraftVersions(t.db, task.id)).map((v) => [v.version, v.origin])).toEqual([
      [2, 'edit'],
      [1, 'generate'],
    ]);
    expect((await getCampaignTask(t.db, task.id))?.status).toBe('running');
  });
});
