import type { CampaignBrief, CampaignDraft } from '@arlo/core';
import { DEFAULT_ORG_ID, upsertAdAccounts } from '@arlo/db';
import { useTestDatabase } from '@arlo/db/testing';
import { setTracingDisabled } from '@openai/agents';
import { describe, expect, it } from 'vitest';
import type { AgentContext } from '../context';
import { say, ScriptedModel } from '../testing';
import { runCreateCampaignTask } from '../tools/campaign';
import { briefPrompt, createCampaignAgent, generateCampaignDraft } from './campaign';

setTracingDisabled(true);

const BRIEF: CampaignBrief = {
  name: 'Arlo Pro 6 預購',
  objective: '新品預購',
  offering: '2K 無線監視器',
  landingPageUrl: 'https://www.arlo.com/pro6',
  audience: null,
  locations: ['台灣'],
  languages: ['zh-TW'],
  dailyBudget: 1500,
  notes: null,
};

const DRAFT: CampaignDraft = {
  campaign: { name: 'Arlo Pro 6 預購', dailyBudget: 1500, biddingStrategy: 'MAXIMIZE_CONVERSIONS', targetCpa: null, locations: ['台灣'], languages: ['zh-TW'] },
  adGroups: [
    {
      name: '品牌',
      keywords: [{ text: 'arlo pro 6', matchType: 'PHRASE' }],
      ads: [{ headlines: ['Arlo Pro 6 監視器', '2K HDR 夜視', '免佈線輕鬆安裝', '雲端與本地儲存', '官方網站預購', '戶外防水設計', '智慧偵測人車', 'Arlo 官方保固'], descriptions: ['2K HDR 影像與彩色夜視，看清每個細節。', '無線免佈線，十分鐘完成安裝，立即預購。'], finalUrl: 'https://www.arlo.com/pro6', path1: null, path2: null }],
    },
  ],
  negativeKeywords: [{ text: '免費', matchType: 'PHRASE' }],
  rationale: '品牌與產品詞為主',
};

const ctx = { db: undefined as never, allowedAccountIds: null, now: () => new Date() } as AgentContext;

describe('generateCampaignDraft', () => {
  it('feeds lint errors back and returns the fixed draft', async () => {
    const bad = { ...DRAFT, adGroups: [{ ...DRAFT.adGroups[0]!, ads: [{ ...DRAFT.adGroups[0]!.ads[0]!, headlines: ['立即預購!', ...DRAFT.adGroups[0]!.ads[0]!.headlines.slice(1)] }] }] };
    const model = new ScriptedModel((_req, { call }) => [say(JSON.stringify(call === 1 ? bad : DRAFT))]);
    const result = await generateCampaignDraft({ agent: createCampaignAgent({ model }), context: ctx, prompt: briefPrompt(BRIEF, { name: 'TW', externalId: '1', currency: 'TWD' }), landingPageUrl: BRIEF.landingPageUrl });
    expect(result.attempts).toBe(2);
    expect(result.issues).toEqual([]);
    const fix = model.requests[1]!.input as { content: unknown }[];
    expect(JSON.stringify(fix.at(-1))).toContain('標題不可使用驚嘆號');
  });

  it('gives up after two fixes and returns the issues', async () => {
    const bad = { ...DRAFT, negativeKeywords: [{ text: 'arlo', matchType: 'PHRASE' as const }] };
    const model = new ScriptedModel(() => [say(JSON.stringify(bad))]);
    const result = await generateCampaignDraft({ agent: createCampaignAgent({ model }), context: ctx, prompt: 'p' });
    expect(result.attempts).toBe(3);
    expect(result.issues.map((i) => i.code)).toContain('NEGATIVE_BLOCKS_KEYWORD');
  });
});

describe('create_campaign_task', () => {
  const t = useTestDatabase();

  it('creates a background task from a complete brief', async () => {
    await upsertAdAccounts(t.db, [{ orgId: DEFAULT_ORG_ID, platform: 'google_ads', externalId: '1234567890', name: 'Arlo TW', currency: 'TWD', timezone: 'Asia/Taipei' }]);
    const created: unknown[] = [];
    const c: AgentContext = { db: t.db, allowedAccountIds: null, now: () => new Date(), createCampaignTask: async (input) => (created.push(input), { id: 'task-1' }) };
    expect(await runCreateCampaignTask(c, { account: 'Arlo TW', ...BRIEF })).toMatchObject({ taskId: 'task-1', status: 'queued' });
    expect(created).toEqual([expect.objectContaining({ brief: BRIEF, createdBy: null })]);
    await expect(runCreateCampaignTask(c, { account: 'Arlo TW', ...BRIEF, landingPageUrl: 'ftp://x' })).rejects.toThrow('landingPageUrl');
    await expect(runCreateCampaignTask({ ...c, createCampaignTask: undefined }, { account: 'Arlo TW', ...BRIEF })).rejects.toThrow('不能建立');
  });
});
