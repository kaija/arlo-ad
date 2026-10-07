import { createCampaignAgent } from '@arlo/agents';
import { say, ScriptedModel } from '@arlo/agents/testing';
import { createLogger } from '@arlo/config/logger';
import type { CampaignBrief, CampaignDraft } from '@arlo/core';
import { createCampaignTask, DEFAULT_ORG_ID, getCampaignTask, latestCampaignDraft, upsertAdAccounts } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { setTracingDisabled } from '@openai/agents';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateForTask, type CampaignDeps } from './campaign';

setTracingDisabled(true);
const logger = createLogger({ component: 'test', level: 'silent' });
const brief: CampaignBrief = { name: 'Pro 6', objective: '預購', offering: '2K 監視器', landingPageUrl: 'https://www.arlo.com/pro6', audience: null, locations: ['台灣'], languages: ['zh-TW'], dailyBudget: 1500, notes: null };
const draft: CampaignDraft = {
  campaign: { name: 'Pro 6', dailyBudget: 1500, biddingStrategy: 'MAXIMIZE_CONVERSIONS', targetCpa: null, locations: ['台灣'], languages: ['zh-TW'] },
  adGroups: [{ name: 'g', keywords: [{ text: 'arlo pro 6', matchType: 'PHRASE' }], ads: [{ headlines: ['Arlo Pro 6', '2K 夜視', '免佈線', '官方預購'], descriptions: ['2K 影像與彩色夜視。', '無線免佈線，立即預購。'], finalUrl: 'https://www.arlo.com/pro6', path1: null, path2: null }] }],
  negativeKeywords: [],
  rationale: 'r',
};

describe('campaign.generate', () => {
  const t = useTestDatabase();
  let accountId: string;

  beforeAll(async () => {
    const [account] = await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    accountId = account!.id;
  });

  const deps = (model: ScriptedModel | null): CampaignDeps => ({ db: t.db, logger, now: () => new Date(), agents: model ? { campaign: () => createCampaignAgent({ model }) } : {} });

  it('stores the draft with its lint result and moves the task to draft, once', async () => {
    const task = await createCampaignTask(t.db, { accountId, brief, createdBy: null });
    const model = new ScriptedModel(() => [say(JSON.stringify(draft))]);
    expect(await generateForTask(deps(model), task.id)).toEqual({ status: 'draft' });
    expect(await getCampaignTask(t.db, task.id)).toMatchObject({ status: 'draft', error: null });
    expect(await latestCampaignDraft(t.db, task.id)).toMatchObject({ version: 1, origin: 'generate', draft: { campaign: { name: 'Pro 6' } }, lintIssues: [expect.objectContaining({ code: 'FEW_HEADLINES' })] });
    expect(await generateForTask(deps(model), task.id)).toEqual({ status: 'draft' });
    expect(model.requests).toHaveLength(1);
  });

  it('marks the task failed with the reason', async () => {
    const task = await createCampaignTask(t.db, { accountId, brief, createdBy: null });
    expect(await generateForTask(deps(null), task.id)).toEqual({ status: 'failed' });
    expect(await getCampaignTask(t.db, task.id)).toMatchObject({ status: 'failed', error: 'campaign agent is not configured' });
  });
});
