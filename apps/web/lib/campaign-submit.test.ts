import { createLogger } from '@arlo/config/logger';
import type { CampaignDraft } from '@arlo/core';
import { applyTransition, createCampaignTask, DEFAULT_ORG_ID, getCampaignTask, getChangeSet, recordOpResults, saveCampaignDraft, setCampaignTaskStatus, upsertAdAccounts, upsertUserOnSignIn } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { ALL_JOBS, createBoss, ensureQueues, Jobs, type PgBoss } from '@arlo/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createdCampaign, enableCampaign, submitDraft } from './campaign-submit';

const ad = { headlines: ['Arlo Pro 6', '2K 夜視', '免佈線', '官方預購', '雲端儲存', '防水設計', '智慧偵測', '官方保固'], descriptions: ['看清每個細節。', '立即預購。'], finalUrl: 'https://www.arlo.com/pro6', path1: null, path2: null };
const draft: CampaignDraft = {
  campaign: { name: 'Pro 6', dailyBudget: 1500, biddingStrategy: 'MAXIMIZE_CONVERSIONS', targetCpa: null, locations: ['台灣'], languages: ['zh-TW'] },
  adGroups: [{ name: 'g', keywords: [{ text: 'arlo pro 6', matchType: 'PHRASE' }], ads: [ad] }],
  negativeKeywords: [],
  rationale: 'r',
};
const brief = { name: 'Pro 6', objective: 'o', offering: 'x', landingPageUrl: 'https://www.arlo.com/pro6', audience: null, locations: ['台灣'], languages: ['zh-TW'], dailyBudget: 1500, notes: null };

describe('submitting drafts and enabling campaigns', () => {
  const t = useTestDatabase();
  let boss: PgBoss;
  let accountId: string;
  let userId: string;

  beforeAll(async () => {
    boss = createBoss({ connectionString: t.url, logger: createLogger({ component: 'test', level: 'silent' }), role: 'migrator' });
    await boss.start();
    await ensureQueues(boss, ALL_JOBS);
    const [acc] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    accountId = acc!.id;
    userId = (await upsertUserOnSignIn(t.db, { email: 'op@example.com' })).id;
  });
  afterAll(() => boss.stop({ graceful: false, close: true }));

  async function draftTask(d: CampaignDraft) {
    const task = await createCampaignTask(t.db, { accountId, brief, createdBy: userId });
    await saveCampaignDraft(t.db, { taskId: task.id, draft: d, lintIssues: [], origin: 'generate' });
    return (await setCampaignTaskStatus(t.db, task.id, ['queued'], 'draft'))!;
  }

  it('submits a clean draft once as a paused bundle ChangeSet, then enables it after execution', async () => {
    const task = await draftTask(draft);
    const result = await submitDraft(t.db, boss, task, userId);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const cs = await getChangeSet(t.db, result.changesetId);
    expect(cs!.ops).toEqual([expect.objectContaining({ kind: 'google.create_campaign_bundle', target: expect.objectContaining({ kind: 'account', id: '1234567890' }), after: expect.objectContaining({ status: 'PAUSED', geoTargetIds: [2158] }), meta: expect.objectContaining({ minTier: 2 }) })]);
    expect((await getCampaignTask(t.db, task.id))?.status).toBe('submitted');
    expect((await boss.findJobs(Jobs.changesetProcess.name)).some((j) => (j.data as { changesetId: string }).changesetId === cs!.id)).toBe(true);
    expect(await submitDraft(t.db, boss, task, userId)).toMatchObject({ ok: false });

    const submitted = (await getCampaignTask(t.db, task.id))!;
    expect(await enableCampaign(t.db, boss, submitted, userId)).toEqual({ ok: false, error: 'campaignNotCreated' });
    // Executor's work, simulated: approved and executed, campaign 9001 created.
    let cur = cs!;
    for (const event of [{ type: 'request_approval', tier: 2, expiresAt: new Date(Date.now() + 3_600_000) }, { type: 'approve', by: userId }, { type: 'execute' }, { type: 'executed', at: new Date() }] as const) {
      const moved = await applyTransition(t.db, cur, event, { kind: 'system' });
      if (!moved.ok) throw new Error('transition');
      cur = moved.changeset;
    }
    await recordOpResults(t.db, cs!.id, [{ index: 0, ok: true, resourceName: 'customers/1234567890/campaigns/9001' }]);
    expect(await createdCampaign(t.db, submitted)).toMatchObject({ changesetStatus: 'EXECUTED', campaignExternalId: '9001', enableChangesetId: null });

    const enabled = await enableCampaign(t.db, boss, submitted, userId);
    if (!enabled.ok) throw new Error(JSON.stringify(enabled.error));
    expect((await getChangeSet(t.db, enabled.changesetId))!.ops).toEqual([expect.objectContaining({ kind: 'set_status', target: expect.objectContaining({ id: '9001' }), before: 'PAUSED', after: 'ENABLED' })]);
    expect(await enableCampaign(t.db, boss, submitted, userId)).toEqual({ ok: false, error: 'enableAlreadyPending' });
  });

  it('refuses drafts with lint errors or unknown targets', async () => {
    const task = await draftTask({ ...draft, campaign: { ...draft.campaign, locations: ['火星'] } });
    expect(await submitDraft(t.db, boss, task, userId)).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'UNKNOWN_LOCATION' })] });
    expect((await getCampaignTask(t.db, task.id))?.status).toBe('draft');
  });
});
