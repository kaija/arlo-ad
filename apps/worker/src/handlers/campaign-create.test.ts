import { FakeChatAdapter } from '@arlo/adapters/chat';
import { FakePlatformAdapter } from '@arlo/adapters/platform';
import { createLogger } from '@arlo/config/logger';
import { draftToBundle, type CampaignDraft } from '@arlo/core';
import { createCampaignTask, insertChangeSet, latestCampaignDraft, saveCampaignDraft, setDraftChangeSet, upsertUserOnSignIn, type AdAccount } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { describe, expect, it } from 'vitest';
import { syncAccounts, syncDaily, syncSnapshots } from '../sync/sync';
import { createExecutor } from './executor';

const logger = createLogger({ component: 'test', level: 'silent' });
const ACC = '1234567890';
const NOW = new Date('2026-10-07T04:00:00Z');
const ad = { headlines: ['Arlo Pro 6', '2K 夜視', '免佈線', '官方預購', '雲端儲存', '防水設計', '智慧偵測', '官方保固'], descriptions: ['看清每個細節。', '立即預購。'], finalUrl: 'https://www.arlo.com/pro6', path1: null, path2: null };
const draft: CampaignDraft = {
  campaign: { name: 'Pro 6', dailyBudget: 1500, biddingStrategy: 'MAXIMIZE_CONVERSIONS', targetCpa: null, locations: ['台灣'], languages: ['zh-TW'] },
  adGroups: [{ name: 'g', keywords: [{ text: 'arlo pro 6', matchType: 'PHRASE' }], ads: [ad] }],
  negativeKeywords: [],
  rationale: 'r',
};

describe('creating a campaign from a draft', () => {
  const t = useTestDatabase();

  it('needs approval, creates the campaign paused, and syncs its policy review onto the draft', async () => {
    const fake = new FakePlatformAdapter().addAccount({ externalId: ACC, name: 'TW', currency: 'TWD', timezone: 'Asia/Taipei' }).setClock(() => NOW);
    const sync = { db: t.db, platform: fake, logger, now: () => NOW };
    const account: AdAccount = (await syncAccounts(sync))[0]!;
    await syncSnapshots(sync, account);
    const approver = (await upsertUserOnSignIn(t.db, { email: 'amy@example.com' })).id;
    const task = await createCampaignTask(t.db, { accountId: account.id, brief: { name: 'Pro 6', objective: 'o', offering: 'x', landingPageUrl: 'https://www.arlo.com/pro6', audience: null, locations: ['台灣'], languages: ['zh-TW'], dailyBudget: 1500, notes: null }, createdBy: null });
    const stored = await saveCampaignDraft(t.db, { taskId: task.id, draft, lintIssues: [], origin: 'generate' });
    const built = draftToBundle(draft);
    if (!built.ok) throw new Error('bundle');
    const cs = await insertChangeSet(t.db, {
      accountId: account.id,
      source: { kind: 'web' },
      ops: [{ kind: 'google.create_campaign_bundle', target: { platform: 'google_ads', accountId: ACC, kind: 'account', id: ACC }, before: null, after: built.bundle, meta: { minTier: 2 } }],
      summary: 'create',
      requestedBy: { kind: 'system' },
    });
    await setDraftChangeSet(t.db, stored.id, cs.id);

    const executor = createExecutor({ db: t.db, platform: fake, chat: new FakeChatAdapter(), logger, now: () => NOW, writeAllowedCustomerIds: [ACC], approvalChannel: { platform: 'slack', channelId: 'C1' } });
    expect(await executor.process(cs.id)).toMatchObject({ status: 'PENDING_APPROVAL', tier: 2 });
    expect(await executor.approve(cs.id, approver)).toMatchObject({ outcome: 'executed' });
    const created = fake.applied[0]!.results[0]!.resourceName!;
    const campaignId = /campaigns\/(\d+)$/.exec(created)![1]!;
    expect(fake.entity({ platform: 'google_ads', accountId: ACC, kind: 'campaign', id: campaignId })).toMatchObject({ status: 'PAUSED', name: 'Pro 6' });

    fake.setAdPolicies(ACC, [{ campaignExternalId: campaignId, adGroupExternalId: '1', adId: '2', approvalStatus: 'APPROVED', reviewStatus: 'REVIEWED', topics: [] }]);
    expect((await syncDaily(sync, account)).adPolicies).toBe(1);
    expect((await latestCampaignDraft(t.db, task.id))?.policyStatus).toEqual([expect.objectContaining({ adId: '2', approvalStatus: 'APPROVED' })]);
  });
});
